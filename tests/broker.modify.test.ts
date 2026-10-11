import { describe, expect, it } from 'vitest'
import { INSTRUMENTS, dataKey, symbolTag } from '../src/instruments'
import type { Bar, Instrument, OrderRequest } from '../src/types'
import {
  cancelOrder, closePartial, closePosition, createAccount, equity, modifyOrder, modifyPosition, onBar, placeOrder, qtyStep, type AccountState,
} from '../src/broker/broker'
import { computeStats } from '../src/broker/stats'
import { datasetsFor } from '../src/data/datasets'
import { parseLocalIndex } from '../src/data/localData'

const by = (s: string): Instrument => INSTRUMENTS.find((i) => i.symbol === s)!
const [NQ, ES, MNQ, MES, EURUSD] = ['NQ', 'ES', 'MNQ', 'MES', 'EURUSD'].map(by) as [Instrument, Instrument, Instrument, Instrument, Instrument]
const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c, v: 1 })

function place(s: AccountState, req: OrderRequest, last = 100, now = 1) {
  const r = placeOrder(s, req, now, last)
  expect(r.error).toBeUndefined()
  return r.state
}
const long = (extra: Partial<OrderRequest> = {}, opts?: { fractional?: boolean }) =>
  place(createAccount(NQ, 50000, 0, 0, opts), { side: 'buy', type: 'market', qty: 2, ...extra }, 100)
const short = () => place(createAccount(NQ), { side: 'sell', type: 'market', qty: 2 }, 100)

describe('modifyPosition validation matrix', () => {
  it('long: SL below / TP above last, sets and tick-rounds', () => {
    const r = modifyPosition(long(), { sl: 95.1, tp: 110.13 }, 100)
    expect(r.error).toBeUndefined()
    expect(r.state.position).toMatchObject({ sl: 95, tp: 110.25 })   // 95.1 -> 95.00, 110.13 -> 110.25 (quarter ticks)
  })
  it('long: wrong side rejected, state untouched', () => {
    const s = long({ sl: 95 })
    for (const patch of [{ sl: 100 }, { sl: 101 }, { tp: 100 }, { tp: 99 }]) {
      const r = modifyPosition(s, patch, 100)
      expect(r.error).toBeDefined()
      expect(r.state).toBe(s)
    }
  })
  it('short: SL above / TP below last; wrong side rejected', () => {
    const ok = modifyPosition(short(), { sl: 105, tp: 90 }, 100)
    expect(ok.state.position).toMatchObject({ sl: 105, tp: 90 })
    expect(modifyPosition(short(), { sl: 99 }, 100).error).toMatch(/SL must be above/)
    expect(modifyPosition(short(), { tp: 101 }, 100).error).toMatch(/TP must be below/)
  })
  it('null removes, undefined / absent keeps', () => {
    const s = modifyPosition(long({ sl: 95, tp: 110 }), {}, 100).state
    expect(s.position).toMatchObject({ sl: 95, tp: 110 })
    const noSl = modifyPosition(s, { sl: null }, 100).state
    expect(noSl.position?.sl).toBeUndefined(); expect('sl' in noSl.position!).toBe(false); expect(noSl.position?.tp).toBe(110)
    const none = modifyPosition(noSl, { tp: null, sl: undefined }, 100).state
    expect(none.position).not.toHaveProperty('tp')
  })
  it('does not mutate the input; no position / bad numbers are errors', () => {
    const s = long({ sl: 95 })
    const frozen = JSON.stringify(s)
    modifyPosition(s, { sl: 90 }, 100)
    expect(JSON.stringify(s)).toBe(frozen)
    expect(modifyPosition(createAccount(NQ), { sl: 90 }, 100).error).toBe('no open position')
    expect(modifyPosition(s, { sl: NaN }, 100).error).toMatch(/invalid SL/)
    expect(modifyPosition(s, { tp: -5 }, 100).error).toMatch(/invalid TP/)
  })
  it('one invalid half rejects the whole patch', () => {
    const s = long()
    expect(modifyPosition(s, { sl: 95, tp: 99 }, 100).error).toBeDefined()
  })
  it('short with spread is measured against the ask', () => {
    const s = place(createAccount(NQ, 50000, 0, 1), { side: 'sell', type: 'market', qty: 1 }, 100)
    expect(modifyPosition(s, { sl: 100.5 }, 100).error).toBeDefined()   // ask = 101, SL 100.5 would already be hit
    expect(modifyPosition(s, { sl: 101.25 }, 100).error).toBeUndefined()
  })
  it('a modified SL really triggers in onBar', () => {
    const s = modifyPosition(long(), { sl: 95 }, 100).state
    const r = onBar(s, bar(1000, 99, 99, 94, 96))
    expect(r.state.position).toBeNull()
    expect(r.state.trades[0]).toMatchObject({ exit: 95, reason: 'sl', pnl: -200 })
  })
})

describe('modifyOrder', () => {
  const withOrder = (req: OrderRequest, spread = 0) => place(createAccount(NQ, 50000, 0, spread), req, 100)
  const buyLimit = () => withOrder({ side: 'buy', type: 'limit', qty: 1, price: 95, sl: 90, tp: 110 })

  it('moves a buy limit (rounded) and keeps sl/tp', () => {
    const r = modifyOrder(buyLimit(), 1, { price: 96.1 }, 100)
    expect(r.error).toBeUndefined()
    expect(r.state.orders[0]).toMatchObject({ id: 1, price: 96, sl: 90, tp: 110, type: 'limit', side: 'buy' })
  })
  it('side-of-market matrix', () => {
    const cases: [OrderRequest, number, boolean][] = [
      [{ side: 'buy', type: 'limit', qty: 1, price: 90 }, 99, true], [{ side: 'buy', type: 'limit', qty: 1, price: 90 }, 100, false],
      [{ side: 'sell', type: 'limit', qty: 1, price: 110 }, 101, true], [{ side: 'sell', type: 'limit', qty: 1, price: 110 }, 99, false],
      [{ side: 'buy', type: 'stop', qty: 1, price: 110 }, 101, true], [{ side: 'buy', type: 'stop', qty: 1, price: 110 }, 99, false],
      [{ side: 'sell', type: 'stop', qty: 1, price: 90 }, 99, true], [{ side: 'sell', type: 'stop', qty: 1, price: 90 }, 101, false],
    ]
    for (const [req, np, ok] of cases) {
      expect(modifyOrder(withOrder(req), 1, { price: np }, 100).error === undefined, `${req.side} ${req.type} -> ${np}`).toBe(ok)
    }
  })
  it('moving the order under an existing SL/TP is rejected; moving them too is fine', () => {
    expect(modifyOrder(buyLimit(), 1, { price: 85 }, 100).error).toMatch(/SL must be below/)
    const r = modifyOrder(buyLimit(), 1, { price: 85, sl: 80 }, 100)
    expect(r.error).toBeUndefined()
    expect(r.state.orders[0]).toMatchObject({ price: 85, sl: 80, tp: 110 })
  })
  it('sl/tp patches: set on the order, null removes, validated against the order price', () => {
    expect(modifyOrder(buyLimit(), 1, { sl: 96 }, 100).error).toMatch(/SL must be below/)       // above the 95 entry
    expect(modifyOrder(buyLimit(), 1, { tp: 94 }, 100).error).toMatch(/TP must be above/)
    const r = modifyOrder(buyLimit(), 1, { sl: null, tp: 120.1 }, 100).state.orders[0]!
    expect(r).not.toHaveProperty('sl'); expect(r.tp).toBe(120)
  })
  it('unknown id / bad price are errors; other orders and ids are untouched', () => {
    const s = buyLimit()
    expect(modifyOrder(s, 9, { price: 90 }, 100).error).toMatch(/not found/)
    expect(modifyOrder(s, 1, { price: 0 }, 100).error).toMatch(/positive price/)
    const two = place(s, { side: 'sell', type: 'limit', qty: 1, price: 120 }, 100)
    const r = modifyOrder(two, 2, { price: 125 }, 100).state
    expect(r.orders.map((o) => [o.id, o.price])).toEqual([[1, 95], [2, 125]])
  })
  it('buy orders are checked against the ask', () => {
    const s = withOrder({ side: 'buy', type: 'limit', qty: 1, price: 90 }, 2)   // ask = 102
    expect(modifyOrder(s, 1, { price: 101.75 }, 100).error).toBeUndefined()
    expect(modifyOrder(s, 1, { price: 102 }, 100).error).toBeDefined()
  })
  it('a modified pending order fills with the new price and attaches its sl/tp', () => {
    const s = modifyOrder(buyLimit(), 1, { price: 97, sl: 92, tp: 105 }, 100).state
    const r = onBar(s, bar(1000, 99, 99.5, 96.5, 98))
    expect(r.state.position).toMatchObject({ qty: 1, avgPrice: 97, sl: 92, tp: 105 })
    expect(r.state.orders).toHaveLength(0)
  })
  it('pending order sl/tp are attached on fill (placeOrder path)', () => {
    const s = place(createAccount(NQ), { side: 'sell', type: 'stop', qty: 1, price: 90, sl: 95, tp: 80 }, 100)
    expect(onBar(s, bar(1000, 92, 92, 89, 90)).state.position).toMatchObject({ side: 'sell', avgPrice: 90, sl: 95, tp: 80 })
  })
})

describe('closePartial', () => {
  it('reduces: pnl, commission, cash and stats are consistent', () => {
    let s = place(createAccount(NQ, 50000, 2), { side: 'buy', type: 'market', qty: 4, sl: 90, tp: 120 }, 100)
    const r1 = closePartial(s, 1, 105, 5)
    expect(r1.error).toBeUndefined()
    s = r1.state
    expect(s.position).toMatchObject({ qty: 3, avgPrice: 100, sl: 90, tp: 120 })
    expect(r1.events.map((e) => e.type)).toEqual(['fill', 'trade'])
    expect(s.trades[0]).toMatchObject({ qty: 1, entry: 100, exit: 105, reason: 'manual', pnl: 100 - 4 })   // 5pts x $20 - 2 x $2
    expect(s.cash).toBe(50000 - 4 * 2 - 1 * 2 + 100)
    s = closePartial(s, 3, 95, 6).state                      // == remaining qty closes the position
    expect(s.position).toBeNull()
    expect(s.trades).toHaveLength(2)
    expect(s.trades[1]).toMatchObject({ qty: 3, exit: 95, pnl: -300 - 12 })
    expect(s.cash).toBe(50000 + s.trades.reduce((a, t) => a + t.pnl, 0))    // flat: cash change == sum of net trade pnl
    const st = computeStats(s.trades, [50000, s.cash])
    expect(st.netPnl).toBe(s.cash - 50000)
  })
  it('equals closePosition when qty == position size', () => {
    const s = place(createAccount(NQ, 50000, 1), { side: 'buy', type: 'market', qty: 2 }, 100)
    expect(closePartial(s, 2, 103, 4)).toEqual(closePosition(s, 103, 4))
  })
  it('short partial with spread buys at the ask', () => {
    const s = place(createAccount(NQ, 50000, 0, 1), { side: 'sell', type: 'market', qty: 3 }, 100)
    const r = closePartial(s, 1, 98, 4)
    expect(r.state.trades[0]).toMatchObject({ side: 'sell', exit: 99, pnl: 20 })
    expect(r.state.position?.qty).toBe(2)
  })
  it('errors: none open, > position, zero/negative, off-step', () => {
    const s = long()
    expect(closePartial(createAccount(NQ), 1, 100, 1).error).toBe('no open position')
    expect(closePartial(s, 3, 100, 1).error).toMatch(/cannot close/)
    expect(closePartial(s, 0, 100, 1).error).toBeDefined()
    expect(closePartial(s, -1, 100, 1).error).toBeDefined()
    expect(closePartial(s, 0.5, 100, 1).error).toMatch(/integer/)
    expect(closePartial(s, 1, 100, 1).state.trades).toHaveLength(1)
  })
})

describe('fractional sizes (SIMULATION)', () => {
  const frac = (i: Instrument = NQ) => createAccount(i, 50000, 0, 0, { fractional: true })
  it('qtyStep: integer by default, 0.01 for futures when fractional, forex unchanged', () => {
    expect(qtyStep(createAccount(NQ))).toBe(1)
    expect(qtyStep(frac())).toBe(0.01)
    expect(qtyStep(frac(MNQ))).toBe(0.01)
    expect(qtyStep(frac(EURUSD))).toBe(1)
    expect(qtyStep(createAccount(EURUSD))).toBe(1)
    expect(qtyStep({ instrument: { ...NQ, qtyStep: 5 } })).toBe(5)
    expect(createAccount(NQ).fractional).toBe(false)
  })
  it('integer accounts still reject decimals; fractional rejects sub-step and zero', () => {
    expect(placeOrder(createAccount(NQ), { side: 'buy', type: 'market', qty: 0.5 }, 1, 100).error).toMatch(/integer/)
    expect(placeOrder(frac(), { side: 'buy', type: 'market', qty: 0.005 }, 1, 100).error).toMatch(/multiple of 0.01/)
    expect(placeOrder(frac(), { side: 'buy', type: 'market', qty: 0 }, 1, 100).error).toBeDefined()
    expect(placeOrder(frac(), { side: 'buy', type: 'market', qty: NaN }, 1, 100).error).toBeDefined()
    expect(placeOrder(frac(), { side: 'buy', type: 'market', qty: 1.234 }, 1, 100).error).toBeDefined()
  })
  it('0.01 steps accumulate exactly (no float dust)', () => {
    let s = frac()
    for (let i = 0; i < 30; i++) s = place(s, { side: 'buy', type: 'market', qty: 0.01 }, 100)
    expect(s.position!.qty).toBe(0.3)                       // plain float addition gives 0.30000000000000004 here
    for (let i = 0; i < 30; i++) s = closePartial(s, 0.01, 100, 2).state
    expect(s.position).toBeNull()
    expect(s.trades).toHaveLength(30)
    expect(s.cash).toBe(50000)
  })
  it('0.1 + 0.2 style inputs normalise; remainder after flip is exact', () => {
    let s = place(frac(), { side: 'buy', type: 'market', qty: 0.1 }, 100)
    s = place(s, { side: 'buy', type: 'market', qty: 0.2 }, 100)
    expect(s.position!.qty).toBe(0.3)
    s = place(s, { side: 'sell', type: 'market', qty: 0.45 }, 100)
    expect(s.position).toMatchObject({ side: 'sell', qty: 0.15 })
    expect(s.trades[0]).toMatchObject({ qty: 0.3, reason: 'flip' })
  })
  it('fractional pnl is rounded to cents: NQ 0.37 contract, +10 pts', () => {
    let s = place(frac(), { side: 'buy', type: 'market', qty: 0.37 }, 100)
    s = closePosition(s, 110, 2).state
    expect(s.cash - 50000).toBe(74)                          // 10 x 20 x 0.37
  })
  it('fractional pending orders and partial fills of sl/tp', () => {
    const s = place(frac(), { side: 'buy', type: 'limit', qty: 0.25, price: 95, sl: 90, tp: 100 }, 100)
    const r = onBar(s, bar(1000, 99, 99, 94, 96))
    expect(r.state.position).toMatchObject({ qty: 0.25, avgPrice: 95 })
    const tp = onBar(r.state, bar(2000, 96, 101, 96, 100))
    expect(tp.state.trades[0]).toMatchObject({ qty: 0.25, reason: 'tp', pnl: 25 })   // 5 x 20 x 0.25
  })
  it('equity follows fractional size', () => {
    const s = place(frac(), { side: 'buy', type: 'market', qty: 0.5 }, 100)
    expect(equity(s, 110)).toBe(50100)
  })
})

describe('micro futures', () => {
  const run = (inst: Instrument, entry: number, exit: number, qty: number, side: 'buy' | 'sell' = 'buy'): number => {
    const s = placeOrder(createAccount(inst), { side, type: 'market', qty }, 1, entry).state
    return closePosition(s, exit, 2).state.cash - 50000
  }
  it('definitions', () => {
    expect(MNQ).toMatchObject({ pointValue: 2, tick: 0.25, yahoo: 'MNQ=F', exchange: 'CME', dataSymbol: 'NQ' })
    expect(MES).toMatchObject({ pointValue: 5, tick: 0.25, yahoo: 'MES=F', exchange: 'CME', dataSymbol: 'ES' })
    expect(INSTRUMENTS[0]!.symbol).toBe('NQ'); expect(INSTRUMENTS[1]!.symbol).toBe('ES')
  })
  it('MNQ buy 3 contracts +10 pts = +$60; MES sell 2 contracts -4 pts = -$40', () => {
    expect(run(MNQ, 20000, 20010, 3)).toBe(60)
    expect(run(MES, 5000, 5004, 2, 'sell')).toBe(-40)
    expect(run(NQ, 20000, 20010, 3)).toBe(600)             // E-mini unchanged
    expect(run(ES, 5000, 5004, 2, 'sell')).toBe(-400)
  })
  it('fractional micro: 1.5 MNQ +10 pts = $30; SL/TP edit works', () => {
    expect(run({ ...MNQ }, 20000, 20010, 1.5)).toBe(0)      // integer account: rejected, nothing filled
    const s = place(createAccount(MNQ, 50000, 0, 0, { fractional: true }), { side: 'buy', type: 'market', qty: 1.5 }, 20000)
    expect(closePosition(modifyPosition(s, { sl: 19990, tp: 20020 }, 20000).state, 20010, 2).state.cash - 50000).toBe(30)
  })
})

describe('dataSymbol aliasing', () => {
  const entry = (folder: string, app: string) => ({ symbol: folder, appSymbol: app, label: folder, source: 's', resolutionMinutes: 1, from: 0, to: 1e12, count: 1, files: [{ file: 'a.csv', from: 0, to: 1, count: 1 }] })
  const local = parseLocalIndex([entry('USATECHIDXUSD', 'NQ'), entry('USA500IDXUSD', 'ES')])
  const archive = [{ symbol: 'NQ.import', intervalMinutes: 3, count: 1, from: 0, to: 1 }, { symbol: 'ES.import', intervalMinutes: 1, count: 1, from: 0, to: 1 }]
  const nonYahoo = (i: Instrument) => datasetsFor(i, local, archive).filter((d) => d.kind !== 'yahoo')

  it('MNQ resolves the very same series keys as NQ (no data duplication), MES as ES', () => {
    const keys = (i: Instrument) => nonYahoo(i).map((d) => [d.id, d.storeSymbol, d.baseMin, d.local?.symbol])
    expect(keys(MNQ)).toEqual(keys(NQ)); expect(keys(MNQ).length).toBe(2)
    expect(keys(MES)).toEqual(keys(ES))
    expect(keys(MNQ)).toContainEqual(['local:USATECHIDXUSD', 'USATECHIDXUSD', 1, 'USATECHIDXUSD'])
    expect(keys(MNQ)).toContainEqual(['import:NQ.import:3', 'NQ.import', 3, undefined])
    expect(nonYahoo(MNQ).every((d) => d.symbol === 'MNQ')).toBe(true)
  })
  it("labels say 'MNQ (data: NQ)'; plain NQ is untouched", () => {
    expect(nonYahoo(MNQ).every((d) => d.label.startsWith('MNQ (data: NQ) '))).toBe(true)
    expect(nonYahoo(NQ).every((d) => d.label.startsWith('NQ ') || d.label.startsWith('NQ ·'))).toBe(true)
    expect(symbolTag(MNQ)).toBe('MNQ (data: NQ)'); expect(symbolTag(MES)).toBe('MES (data: ES)'); expect(symbolTag(NQ)).toBe('NQ')
    expect(dataKey(MNQ)).toBe('NQ'); expect(dataKey(EURUSD)).toBe('EURUSD')
  })
  it('does not leak across indices; yahoo sets keep their own archive (different ticker)', () => {
    expect(nonYahoo(MNQ).some((d) => d.local?.symbol === 'USA500IDXUSD')).toBe(false)
    const y = datasetsFor(MNQ, local, archive).filter((d) => d.kind === 'yahoo')
    expect(y.map((d) => d.storeSymbol)).toEqual(['MNQ', 'MNQ'])
  })
})

describe('pending order lifecycle sanity', () => {
  it('cancel still works after modify', () => {
    const s = place(createAccount(NQ), { side: 'buy', type: 'limit', qty: 1, price: 95 }, 100)
    const m = modifyOrder(s, 1, { price: 94 }, 100).state
    expect(cancelOrder(m, 1).state.orders).toHaveLength(0)
  })
})
