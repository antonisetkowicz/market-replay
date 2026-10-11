import { describe, expect, it } from 'vitest'
import { INSTRUMENTS } from '../src/instruments'
import type { Bar, OrderRequest } from '../src/types'
import { cancelOrder, closePosition, createAccount, equity, onBar, placeOrder, type AccountState } from '../src/broker/broker'
import { computeStats } from '../src/broker/stats'

const NQ = INSTRUMENTS[0]
const ES = INSTRUMENTS[1]
const bar = (o: number, h: number, l: number, c: number, t = 1000): Bar => ({ t, o, h, l, c, v: 1 })

function place(s: AccountState, req: OrderRequest, last = 100, now = 1) {
  const r = placeOrder(s, req, now, last)
  expect(r.error).toBeUndefined()
  return r.state
}

describe('market orders and positions', () => {
  it('fills at lastPrice immediately', () => {
    const s = place(createAccount(NQ), { side: 'buy', type: 'market', qty: 2 }, 100)
    expect(s.position).toMatchObject({ side: 'buy', qty: 2, avgPrice: 100, openedAt: 1 })
    expect(s.orders).toHaveLength(0)
  })

  it('does not mutate the input state', () => {
    const s0 = createAccount(NQ)
    const frozen = JSON.stringify(s0)
    placeOrder(s0, { side: 'buy', type: 'market', qty: 1 }, 1, 100)
    expect(JSON.stringify(s0)).toBe(frozen)
  })

  it('averages the price when adding and replaces sl/tp with the latest', () => {
    let s = place(createAccount(NQ), { side: 'buy', type: 'market', qty: 1, sl: 90 }, 100)
    s = place(s, { side: 'buy', type: 'market', qty: 1, sl: 95, tp: 120 }, 110)
    expect(s.position).toMatchObject({ qty: 2, avgPrice: 105, sl: 95, tp: 120 })
  })

  it('keeps sl/tp when an add does not specify them', () => {
    let s = place(createAccount(NQ), { side: 'buy', type: 'market', qty: 1, sl: 90 }, 100)
    s = place(s, { side: 'buy', type: 'market', qty: 1 }, 110)
    expect(s.position?.sl).toBe(90)
  })

  it('partial close keeps the remainder and records a manual trade', () => {
    let s = place(createAccount(NQ), { side: 'buy', type: 'market', qty: 3 }, 100)
    s = place(s, { side: 'sell', type: 'market', qty: 1 }, 110)
    expect(s.position).toMatchObject({ side: 'buy', qty: 2, avgPrice: 100 })
    expect(s.trades).toEqual([expect.objectContaining({ qty: 1, pnl: 10 * 20, reason: 'manual' })])
  })

  it('full close via opposite order', () => {
    let s = place(createAccount(NQ), { side: 'sell', type: 'market', qty: 2 }, 100)
    s = place(s, { side: 'buy', type: 'market', qty: 2 }, 90)
    expect(s.position).toBeNull()
    expect(s.trades[0]).toMatchObject({ side: 'sell', pnl: 10 * 20 * 2, reason: 'manual' })
  })

  it('flip closes old position with reason flip and opens the remainder with new sl/tp', () => {
    let s = place(createAccount(NQ), { side: 'buy', type: 'market', qty: 1 }, 100)
    s = place(s, { side: 'sell', type: 'market', qty: 3, sl: 120, tp: 80 }, 105)
    expect(s.trades).toEqual([expect.objectContaining({ qty: 1, pnl: 100, reason: 'flip' })])
    expect(s.position).toMatchObject({ side: 'sell', qty: 2, avgPrice: 105, sl: 120, tp: 80, openedAt: 1 })
  })

  it('closePosition flattens at lastPrice; errors when flat', () => {
    let s = place(createAccount(NQ), { side: 'buy', type: 'market', qty: 1 }, 100)
    const r = closePosition(s, 103, 9)
    expect(r.state.position).toBeNull()
    expect(r.state.trades[0]).toMatchObject({ pnl: 60, closedAt: 9, reason: 'manual' })
    s = r.state
    expect(closePosition(s, 103, 10).error).toMatch(/no open position/)
  })

  it('order ids increase monotonically', () => {
    let s = place(createAccount(NQ), { side: 'buy', type: 'limit', qty: 1, price: 90 })
    s = place(s, { side: 'buy', type: 'limit', qty: 1, price: 80 })
    s = place(s, { side: 'buy', type: 'market', qty: 1 })
    expect(s.orders.map((o) => o.id)).toEqual([1, 2])
    expect(s.nextOrderId).toBe(4)
  })
})

describe('validation', () => {
  const s = createAccount(NQ)
  const err = (req: OrderRequest) => placeOrder(s, req, 1, 100).error
  it('rejects bad qty', () => {
    expect(err({ side: 'buy', type: 'market', qty: 0 })).toMatch(/qty/)
    expect(err({ side: 'buy', type: 'market', qty: 1.5 })).toMatch(/qty/)
    expect(err({ side: 'buy', type: 'market', qty: -1 })).toMatch(/qty/)
  })
  it('requires price for limit/stop', () => {
    expect(err({ side: 'buy', type: 'limit', qty: 1 })).toMatch(/price/)
    expect(err({ side: 'sell', type: 'stop', qty: 1 })).toMatch(/price/)
  })
  it('rejects SL/TP on the wrong side', () => {
    expect(err({ side: 'buy', type: 'market', qty: 1, sl: 101 })).toMatch(/SL/)
    expect(err({ side: 'buy', type: 'market', qty: 1, tp: 99 })).toMatch(/TP/)
    expect(err({ side: 'sell', type: 'market', qty: 1, sl: 99 })).toMatch(/SL/)
    expect(err({ side: 'sell', type: 'market', qty: 1, tp: 101 })).toMatch(/TP/)
    expect(err({ side: 'buy', type: 'limit', qty: 1, price: 95, sl: 96 })).toMatch(/SL/)
  })
  it('rejects without mutating state, accepts correct sides', () => {
    expect(placeOrder(s, { side: 'buy', type: 'market', qty: 0 }, 1, 100).state).toBe(s)
    expect(err({ side: 'buy', type: 'market', qty: 1, sl: 99, tp: 101 })).toBeUndefined()
  })
  it('rounds prices to the tick', () => {
    const r = place(s, { side: 'buy', type: 'limit', qty: 1, price: 99.9, sl: 90.13, tp: 120.4 })
    expect(r.orders[0]).toMatchObject({ price: 100, sl: 90.25, tp: 120.5 })
  })
  it('cancelOrder removes the order; unknown id errors', () => {
    const p = place(s, { side: 'buy', type: 'limit', qty: 1, price: 90 })
    expect(cancelOrder(p, 1).state.orders).toHaveLength(0)
    expect(cancelOrder(p, 99).error).toMatch(/not found/)
  })
})

describe('pending order fill rules', () => {
  const pend = (req: OrderRequest) => place(createAccount(NQ), req, 100)

  it('buy limit fills at limit when touched intrabar', () => {
    const r = onBar(pend({ side: 'buy', type: 'limit', qty: 1, price: 95 }), bar(100, 101, 94, 99))
    expect(r.state.position?.avgPrice).toBe(95)
    expect(r.state.orders).toHaveLength(0)
  })
  it('buy limit gap-through fills at open', () => {
    const r = onBar(pend({ side: 'buy', type: 'limit', qty: 1, price: 95 }), bar(92, 96, 91, 94))
    expect(r.state.position?.avgPrice).toBe(92)
  })
  it('buy limit untouched stays pending', () => {
    const r = onBar(pend({ side: 'buy', type: 'limit', qty: 1, price: 95 }), bar(100, 101, 96, 99))
    expect(r.state.position).toBeNull()
    expect(r.state.orders).toHaveLength(1)
  })
  it('sell limit fills at limit; gap-through at open', () => {
    const o = pend({ side: 'sell', type: 'limit', qty: 1, price: 105 })
    expect(onBar(o, bar(100, 106, 99, 100)).state.position?.avgPrice).toBe(105)
    expect(onBar(o, bar(108, 109, 107, 108)).state.position?.avgPrice).toBe(108)
  })
  it('buy stop fills at stop; gap-through at open', () => {
    const o = pend({ side: 'buy', type: 'stop', qty: 1, price: 105 })
    expect(onBar(o, bar(100, 106, 99, 100)).state.position?.avgPrice).toBe(105)
    expect(onBar(o, bar(108, 109, 107, 108)).state.position?.avgPrice).toBe(108)
  })
  it('sell stop fills at stop; gap-through at open', () => {
    const o = pend({ side: 'sell', type: 'stop', qty: 1, price: 95 })
    expect(onBar(o, bar(100, 101, 94, 99)).state.position?.avgPrice).toBe(95)
    expect(onBar(o, bar(92, 93, 90, 91)).state.position?.avgPrice).toBe(92)
  })
  it('emits fill events with order id and bar time', () => {
    const r = onBar(pend({ side: 'buy', type: 'limit', qty: 1, price: 95 }), bar(100, 101, 94, 99, 5000))
    expect(r.events[0]).toMatchObject({ type: 'fill', source: 'limit', orderId: 1, price: 95, time: 5000 })
  })
  it('pending order attaches sl/tp to the new position', () => {
    const r = onBar(pend({ side: 'buy', type: 'limit', qty: 1, price: 95, sl: 90, tp: 110 }), bar(100, 101, 94, 99))
    expect(r.state.position).toMatchObject({ sl: 90, tp: 110 })
  })
  it('pending opposite order closes position (manual)', () => {
    let s = place(createAccount(NQ), { side: 'buy', type: 'market', qty: 1 }, 100)
    s = place(s, { side: 'sell', type: 'limit', qty: 1, price: 105 }, 100)
    const r = onBar(s, bar(100, 106, 99, 100))
    expect(r.state.position).toBeNull()
    expect(r.state.trades[0]).toMatchObject({ pnl: 100, reason: 'manual', exit: 105 })
  })
})

describe('SL / TP', () => {
  const long = () => place(createAccount(NQ), { side: 'buy', type: 'market', qty: 1, sl: 95, tp: 110 }, 100)
  const short = () => place(createAccount(NQ), { side: 'sell', type: 'market', qty: 1, sl: 105, tp: 90 }, 100)

  it('long TP fills at tp', () => {
    const r = onBar(long(), bar(100, 111, 99, 105))
    expect(r.state.trades[0]).toMatchObject({ reason: 'tp', exit: 110, pnl: 200 })
    expect(r.state.position).toBeNull()
  })
  it('long SL fills at sl; gap-through at open', () => {
    expect(onBar(long(), bar(100, 101, 94, 96)).state.trades[0]).toMatchObject({ reason: 'sl', exit: 95 })
    expect(onBar(long(), bar(92, 93, 90, 91)).state.trades[0]).toMatchObject({ reason: 'sl', exit: 92, pnl: -160 })
  })
  it('long TP gap-through fills at open', () => {
    expect(onBar(long(), bar(115, 116, 114, 115)).state.trades[0]).toMatchObject({ reason: 'tp', exit: 115 })
  })
  it('short SL and TP', () => {
    expect(onBar(short(), bar(100, 106, 99, 100)).state.trades[0]).toMatchObject({ reason: 'sl', exit: 105, pnl: -100 })
    expect(onBar(short(), bar(100, 101, 89, 95)).state.trades[0]).toMatchObject({ reason: 'tp', exit: 90, pnl: 200 })
    expect(onBar(short(), bar(108, 109, 107, 108)).state.trades[0]).toMatchObject({ reason: 'sl', exit: 108 })
  })
  it('both touched in one bar: SL wins (long and short)', () => {
    expect(onBar(long(), bar(100, 112, 94, 100)).state.trades[0]).toMatchObject({ reason: 'sl', exit: 95 })
    expect(onBar(short(), bar(100, 106, 89, 100)).state.trades[0]).toMatchObject({ reason: 'sl', exit: 105 })
  })
  it('untouched keeps position', () => {
    const r = onBar(long(), bar(100, 105, 98, 102))
    expect(r.state.position).not.toBeNull()
    expect(r.events).toHaveLength(0)
  })
  it('entry fill and SL/TP evaluated on the same bar', () => {
    const s = place(createAccount(NQ), { side: 'buy', type: 'limit', qty: 1, price: 95, sl: 90, tp: 100 }, 100)
    const r = onBar(s, bar(99, 101, 94, 100))
    expect(r.state.position).toBeNull()
    expect(r.state.trades[0]).toMatchObject({ entry: 95, exit: 100, reason: 'tp' })
    const both = onBar(s, bar(99, 101, 89, 100))
    expect(both.state.trades[0]).toMatchObject({ exit: 90, reason: 'sl' })
  })
})

describe('commission, point value, equity', () => {
  it('charges commission per contract per side', () => {
    let s = place(createAccount(NQ, 50000, 2), { side: 'buy', type: 'market', qty: 2 }, 100)
    expect(s.cash).toBe(50000 - 4)
    s = place(s, { side: 'sell', type: 'market', qty: 2 }, 101)
    expect(s.cash).toBe(50000 - 8 + 2 * 20)
    expect(s.trades[0].pnl).toBe(40 - 8)
    expect(s.cash - 50000).toBe(s.trades[0].pnl)
  })
  it('NQ vs ES point value', () => {
    const run = (i: typeof NQ) => {
      const s = place(createAccount(i), { side: 'buy', type: 'market', qty: 1 }, 100)
      return closePosition(s, 101, 2).state.trades[0].pnl
    }
    expect(run(NQ)).toBe(20)
    expect(run(ES)).toBe(50)
  })
  it('equity includes open P&L for long and short', () => {
    const l = place(createAccount(NQ), { side: 'buy', type: 'market', qty: 2 }, 100)
    expect(equity(l, 103)).toBe(50000 + 3 * 20 * 2)
    const sh = place(createAccount(ES), { side: 'sell', type: 'market', qty: 1 }, 100)
    expect(equity(sh, 103)).toBe(50000 - 3 * 50)
    expect(equity(createAccount(NQ), 999)).toBe(50000)
  })
  it('equity after a flip uses new avg price', () => {
    let s = place(createAccount(NQ), { side: 'buy', type: 'market', qty: 1 }, 100)
    s = place(s, { side: 'sell', type: 'market', qty: 2 }, 110)
    expect(equity(s, 108)).toBe(50000 + 200 + 2 * 20)
  })
})

describe('computeStats', () => {
  const t = (pnl: number) => ({ side: 'buy' as const, qty: 1, entry: 1, exit: 1, pnl, openedAt: 0, closedAt: 1, reason: 'manual' as const })
  it('no trades', () => {
    expect(computeStats([], [])).toEqual({
      trades: 0, winRate: 0, profitFactor: null, avgWin: 0, avgLoss: 0, expectancy: 0, netPnl: 0, maxDrawdown: 0, maxDrawdownPct: 0,
    })
  })
  it('all wins -> profitFactor null', () => {
    const s = computeStats([t(100), t(50)], [])
    expect(s.profitFactor).toBeNull()
    expect(s.winRate).toBe(1)
    expect(s.avgWin).toBe(75)
  })
  it('mixed trades', () => {
    const s = computeStats([t(100), t(-50), t(50), t(-50)], [])
    expect(s).toMatchObject({ trades: 4, winRate: 0.5, profitFactor: 1.5, avgWin: 75, avgLoss: -50, expectancy: 12.5, netPnl: 50 })
  })
  it('breakeven trades count as neither win nor loss', () => {
    const s = computeStats([t(0), t(10)], [])
    expect(s.winRate).toBe(0.5)
    expect(s.profitFactor).toBeNull()
  })
  it('max drawdown absolute and percent', () => {
    const s = computeStats([], [100, 120, 90, 130, 117])
    expect(s.maxDrawdown).toBe(30)
    expect(s.maxDrawdownPct).toBe(25)
  })
  it('monotonic equity has zero drawdown', () => {
    expect(computeStats([], [1, 2, 3]).maxDrawdown).toBe(0)
  })
})
