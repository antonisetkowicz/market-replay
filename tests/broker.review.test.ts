import { describe, expect, it } from 'vitest'
import { INSTRUMENTS } from '../src/instruments'
import type { Bar, OrderRequest } from '../src/types'
import { closePosition, createAccount, equity, onBar, placeOrder, cancelOrder, type AccountState, type BrokerEvent } from '../src/broker/broker'
import { computeStats } from '../src/broker/stats'

const NQ = INSTRUMENTS[0]
const ES = INSTRUMENTS[1]
const bar = (o: number, h: number, l: number, c: number, t = 1000): Bar => ({ t, o, h, l, c, v: 1 })

function place(s: AccountState, req: OrderRequest, last = 100, now = 1) {
  const r = placeOrder(s, req, now, last)
  expect(r.error).toBeUndefined()
  return r.state
}

describe('review: same-bar entry then SL/TP', () => {
  it('SL on a position opened intrabar fills at the SL level, not at the bar open that preceded entry', () => {
    // buy stop 105 triggers after the 100 open; SL 101 can only be hit after entry -> fill 101 (not 100)
    const s = place(createAccount(NQ), { side: 'buy', type: 'stop', qty: 1, price: 105, sl: 101 }, 100)
    const r = onBar(s, bar(100, 106, 99, 104))
    expect(r.state.position).toBeNull()
    expect(r.state.trades[0]).toMatchObject({ entry: 105, exit: 101, reason: 'sl', pnl: -80 })
  })
  it('TP on a position opened intrabar fills at the TP level, not at the open that preceded entry', () => {
    // buy limit 95, TP 99 (< open 100): exit must not be 100
    const s = place(createAccount(NQ), { side: 'buy', type: 'limit', qty: 1, price: 95, tp: 99 }, 100)
    const r = onBar(s, bar(100, 101, 94, 100))
    expect(r.state.trades[0]).toMatchObject({ entry: 95, exit: 99, reason: 'tp' })
  })
  it('gap fill with SL above the fill price exits inside the bar range', () => {
    const s = place(createAccount(NQ), { side: 'buy', type: 'limit', qty: 1, price: 95, sl: 90 }, 100)
    const r = onBar(s, bar(85, 86, 84, 85))
    const t = r.state.trades[0]
    expect(t.entry).toBe(85)
    expect(t.exit).toBeGreaterThanOrEqual(84)
    expect(t.exit).toBeLessThanOrEqual(86)
  })
})

describe('review: chronology inside a bar', () => {
  it('existing position SL is evaluated before a pending add that is only reachable after the SL', () => {
    let s = place(createAccount(NQ), { side: 'buy', type: 'market', qty: 1, sl: 95 }, 100)
    s = place(s, { side: 'buy', type: 'limit', qty: 1, price: 90 }, 100)
    const r = onBar(s, bar(97, 98, 89, 92))
    expect(r.state.trades).toEqual([expect.objectContaining({ entry: 100, exit: 95, reason: 'sl', pnl: -100 })])
    expect(r.state.position).toMatchObject({ side: 'buy', qty: 1, avgPrice: 90 })
  })
  it('TP gap-through at the open is filled at the open even if SL is also touched later in the bar', () => {
    const s = place(createAccount(NQ), { side: 'buy', type: 'market', qty: 1, sl: 95, tp: 110 }, 100)
    const r = onBar(s, bar(115, 116, 90, 100))
    expect(r.state.trades[0]).toMatchObject({ reason: 'tp', exit: 115, pnl: 300 })
    const sh = place(createAccount(NQ), { side: 'sell', type: 'market', qty: 1, sl: 105, tp: 90 }, 100)
    expect(onBar(sh, bar(85, 106, 84, 100)).state.trades[0]).toMatchObject({ reason: 'tp', exit: 85 })
  })
  it('an order never fills on the bar it was placed on (no lookahead / replay of a revealed bar)', () => {
    const s = place(createAccount(NQ), { side: 'buy', type: 'limit', qty: 1, price: 95 }, 100, 1000)
    const same = onBar(s, bar(100, 101, 90, 99, 1000))
    expect(same.state.position).toBeNull()
    expect(same.state.orders).toHaveLength(1)
    const older = onBar(s, bar(100, 101, 90, 99, 500))
    expect(older.state.position).toBeNull()
    expect(onBar(s, bar(100, 101, 90, 99, 2000)).state.position?.avgPrice).toBe(95)
  })
  it('SL/TP of a position are not evaluated on the bar it was opened at (market order at now)', () => {
    const s = place(createAccount(NQ), { side: 'buy', type: 'market', qty: 1, sl: 95 }, 100, 1000)
    const r = onBar(s, bar(100, 101, 90, 99, 1000))
    expect(r.state.position).not.toBeNull()
    expect(r.events).toHaveLength(0)
  })
  it('re-feeding the same bar does not double fill', () => {
    const s = place(createAccount(NQ), { side: 'buy', type: 'limit', qty: 1, price: 95 }, 100)
    const b = bar(100, 101, 94, 99, 5000)
    const a = onBar(s, b)
    const again = onBar(a.state, b)
    expect(again.events).toHaveLength(0)
    expect(again.state.position).toMatchObject({ qty: 1, avgPrice: 95 })
  })
})

describe('review: position/order accounting', () => {
  it('reducing order does not attach its sl/tp (they belong to a non-existent opposite position)', () => {
    let s = place(createAccount(NQ), { side: 'buy', type: 'market', qty: 3, sl: 90 }, 100)
    s = place(s, { side: 'sell', type: 'market', qty: 1, sl: 120, tp: 80 }, 105)
    expect(s.position).toMatchObject({ qty: 2, sl: 90 })
    expect(s.position?.tp).toBeUndefined()
  })
  it('cash == start + sum(trade pnl) after flips, partial closes, commissions (short and long)', () => {
    let s = createAccount(ES, 50000, 1.25)
    s = place(s, { side: 'buy', type: 'market', qty: 2 }, 100)
    s = place(s, { side: 'sell', type: 'market', qty: 5 }, 101) // flip: closes 2, opens short 3
    s = place(s, { side: 'buy', type: 'market', qty: 1 }, 99)   // partial close of short
    s = place(s, { side: 'buy', type: 'market', qty: 4 }, 98)   // flip again: closes 2, opens long 2
    s = closePosition(s, 99.5, 9).state
    expect(s.position).toBeNull()
    const net = s.trades.reduce((a, t) => a + t.pnl, 0)
    expect(s.cash).toBeCloseTo(50000 + net, 9)
    // by hand: (101-100)*50*2 + (101-99)*50*1 + (101-98)*50*2 + (99.5-98)*50*2 - 2*1.25*(2+1+2+2)... entries counted once
    const gross = 100 + 100 + 300 + 150
    const commissions = 1.25 * (2 + 5 + 1 + 4 + 2)
    expect(s.cash).toBeCloseTo(50000 + gross - commissions, 9)
  })
  it('short P&L sign: profit when price falls, loss when it rises, in equity too', () => {
    const s = place(createAccount(ES), { side: 'sell', type: 'market', qty: 1 }, 100)
    expect(equity(s, 98)).toBe(50000 + 100)
    expect(closePosition(s, 102, 2).state.trades[0].pnl).toBe(-100)
  })
  it('cancel after fill errors and does not touch the position', () => {
    const s = place(createAccount(NQ), { side: 'buy', type: 'limit', qty: 1, price: 95 }, 100)
    const f = onBar(s, bar(100, 101, 94, 99, 2000)).state
    const c = cancelOrder(f, 1)
    expect(c.error).toMatch(/not found/)
    expect(c.state.position).toMatchObject({ qty: 1 })
  })
  it('two pending orders on one bar both fill once, in id order', () => {
    let s = place(createAccount(NQ), { side: 'buy', type: 'limit', qty: 1, price: 95 }, 100)
    s = place(s, { side: 'sell', type: 'limit', qty: 1, price: 105 }, 100)
    const r = onBar(s, bar(100, 106, 94, 100, 2000))
    expect(r.events.filter((e) => e.type === 'fill').map((e) => (e as { orderId?: number }).orderId)).toEqual([1, 2])
    expect(r.state.position).toBeNull()
    expect(r.state.trades).toHaveLength(1)
    expect(r.state.orders).toHaveLength(0)
  })
})

describe('review: floating point drift', () => {
  it('10000 round trips with fractional commission keep cash exact to the cent', () => {
    let s = createAccount(NQ, 50000, 0.62)
    for (let i = 0; i < 10000; i++) {
      s = placeOrder(s, { side: 'buy', type: 'market', qty: 1 }, i, 100).state
      s = placeOrder(s, { side: 'sell', type: 'market', qty: 1 }, i, 100.25).state
    }
    expect(s.trades).toHaveLength(10000)
    expect(s.cash).toBe(87600) // 50000 + 10000 * (5 - 1.24)
    expect(s.trades.every((t) => t.pnl === 3.76)).toBe(true)
    expect(computeStats(s.trades, []).netPnl).toBe(37600)
  })
  it('fractional average price does not leak sub-cent noise into cash', () => {
    let s = createAccount(NQ, 50000, 0)
    for (let i = 0; i < 3000; i++) {
      s = placeOrder(s, { side: 'buy', type: 'market', qty: 2 }, i, 100).state
      s = placeOrder(s, { side: 'buy', type: 'market', qty: 1 }, i, 100.25).state // avg 100.0833..
      s = placeOrder(s, { side: 'sell', type: 'market', qty: 3 }, i, 100.5).state
    }
    expect(Math.round(s.cash * 100) / 100).toBe(s.cash)
    expect(s.trades.every((t) => Math.round(t.pnl * 100) / 100 === t.pnl)).toBe(true)
  })
})

describe('review: randomized invariants', () => {
  function rng(seed: number) {
    let x = seed
    return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296)
  }
  it('every fill is inside its bar range, cash is conserved, positions stay sane', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed)
      const inst = seed % 2 ? NQ : ES
      const comm = [0, 0.62, 2.5][seed % 3]
      let s = createAccount(inst, 50000, comm)
      let px = 1000
      for (let i = 1; i <= 300; i++) {
        // place random orders at bar close i-1
        if (r() < 0.5) {
          const side = r() < 0.5 ? 'buy' : 'sell'
          const type = (['market', 'limit', 'stop'] as const)[Math.floor(r() * 3)]
          const off = (k: number) => Math.round(k * 40) / 4
          const price = type === 'market' ? undefined : px + (r() < 0.5 ? -1 : 1) * off(r() + 0.1)
          const entry = price ?? px
          const dir = side === 'buy' ? 1 : -1
          const req: OrderRequest = {
            side, type, qty: 1 + Math.floor(r() * 3), price,
            ...(r() < 0.5 && { sl: entry - dir * off(r() + 0.1) }),
            ...(r() < 0.5 && { tp: entry + dir * off(r() + 0.1) }),
          }
          s = placeOrder(s, req, i - 1, px).state
        }
        if (r() < 0.05) s = closePosition(s, px, i - 1).state
        if (r() < 0.05 && s.orders.length) s = cancelOrder(s, s.orders[0].id).state
        const o = px + (r() - 0.5) * 6
        const c = o + (r() - 0.5) * 12
        const h = Math.max(o, c) + r() * 5
        const l = Math.min(o, c) - r() * 5
        const b = bar(o, h, l, c, i)
        const res = onBar(s, b)
        for (const e of res.events as BrokerEvent[]) {
          if (e.type === 'fill') {
            expect(e.price).toBeGreaterThanOrEqual(b.l - 1e-9)
            expect(e.price).toBeLessThanOrEqual(b.h + 1e-9)
          }
        }
        s = res.state
        if (s.position) expect(s.position.qty).toBeGreaterThan(0)
        px = c
      }
      s = closePosition(s, px, 301).state
      const net = s.trades.reduce((a, t) => a + t.pnl, 0)
      expect(s.cash).toBeCloseTo(50000 + net, 6)
    }
  })
})
