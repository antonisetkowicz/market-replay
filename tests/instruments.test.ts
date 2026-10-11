import { describe, expect, it } from 'vitest'
import { INSTRUMENTS, exitPrices, isSpot, pricePrecision, unitLabel, unitSize } from '../src/instruments'
import { aggregate, aggregateUpTo, bucketStart, foldBar, sessionStart } from '../src/data/resample'
import { closePosition, createAccount, equity, onBar, placeOrder, type AccountState } from '../src/broker/broker'
import type { Bar, Instrument } from '../src/types'
import { datasetsFor, localStoreSymbol, yahooDatasets } from '../src/data/datasets'

const by = (s: string): Instrument => INSTRUMENTS.find((i) => i.symbol === s)!
const [NQ, ES, EURUSD, GBPUSD, XAUUSD] = ['NQ', 'ES', 'EURUSD', 'GBPUSD', 'XAUUSD'].map(by) as [Instrument, Instrument, Instrument, Instrument, Instrument]
const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c, v: 1 })

describe('instrument contracts', () => {
  it('NQ/ES keep futures defaults (2 decimals, points, CME 18:00)', () => {
    for (const i of [NQ, ES]) {
      expect(pricePrecision(i)).toBe(2); expect(unitSize(i)).toBe(1); expect(unitLabel(i)).toBe('pts'); expect(i.sessionOpenHour).toBeUndefined(); expect(isSpot(i)).toBe(false)
    }
    expect(NQ).toMatchObject({ tick: 0.25, pointValue: 20, exchange: 'CME' })
    expect(ES).toMatchObject({ tick: 0.25, pointValue: 50, exchange: 'CME' })
  })
  it('forex / gold definitions', () => {
    expect([EURUSD, GBPUSD].map((i) => [i.pricePrecision, i.tick, i.pip, i.pointValue, i.exchange, i.sessionOpenHour])).toEqual([[5, 0.00001, 0.0001, 1000, 'FX', 17], [5, 0.00001, 0.0001, 1000, 'FX', 17]])
    expect([XAUUSD.pricePrecision, XAUUSD.tick, XAUUSD.pip, XAUUSD.pointValue, XAUUSD.exchange, XAUUSD.sessionOpenHour]).toEqual([3, 0.001, 0.1, 1, 'OTC', 17])
    for (const i of [EURUSD, GBPUSD, XAUUSD]) { expect(i.lotContracts).toBe(100); expect(isSpot(i)).toBe(true); expect(i.contractNote).toMatch(/^1 = /) }
  })
})

describe('P&L math (integer contracts)', () => {
  const run = (inst: Instrument, entry: number, exit: number, qty: number, side: 'buy' | 'sell' = 'buy'): number => {
    let s: AccountState = createAccount(inst)
    s = placeOrder(s, { side, type: 'market', qty }, 1, entry).state
    const r = closePosition(s, exit, 2)
    expect(r.error).toBeUndefined()
    return r.state.cash - s.startingCash
  }
  it('EURUSD / GBPUSD: 100 contracts = 1 lot, +10 pips = +$100.00', () => {
    expect(run(EURUSD, 1.1, 1.101, 100)).toBe(100)
    expect(run(GBPUSD, 1.3, 1.301, 100)).toBe(100)
    expect(run(EURUSD, 1.1, 1.099, 100)).toBe(-100)
    expect(run(EURUSD, 1.1, 1.099, 100, 'sell')).toBe(100)
    expect(run(EURUSD, 1.08523, 1.08623, 1)).toBe(1)        // 1 contract = 0.01 lot: 10 pips = $1.00 (float dust rounded to cents)
    expect(run(EURUSD, 1.08523, 1.08623, 7)).toBe(7)
  })
  it('XAUUSD: 100 oz, +$5.00 move = +$500', () => {
    expect(run(XAUUSD, 2000, 2005, 100)).toBe(500)
    expect(run(XAUUSD, 2000.55, 2005.55, 1)).toBe(5)
  })
  it('XAUUSD: Dukascopy 3-decimal prices survive the broker (tick must not round them)', () => {
    const s = placeOrder(createAccount(XAUUSD), { side: 'buy', type: 'market', qty: 100, ...exitPrices('buy', 2907.475, 5, 10, unitSize(XAUUSD)) }, 1, 2907.475).state
    expect(s.position!.avgPrice).toBe(2907.475)
    expect(s.position!.sl).toBe(2906.975); expect(s.position!.tp).toBe(2908.475)      // exactly 5 / 10 pips, no 0.495 / 1.005 drift
    expect(pricePrecision(XAUUSD)).toBe(3)
  })
  it('spread fills are exact tick multiples (no float dust)', () => {
    const buy = placeOrder(createAccount(XAUUSD, 50000, 0, 0.3), { side: 'buy', type: 'market', qty: 100 }, 1, 4298.555).state
    expect(buy.position!.avgPrice).toBe(4298.855)
    const sell = placeOrder(createAccount(EURUSD, 50000, 0, 0.00012), { side: 'sell', type: 'market', qty: 100 }, 1, 1.08412).state
    const shortClosed = closePosition(sell, 1.08412, 2)
    expect(shortClosed.state.trades[0]!.exit).toBe(1.08424)
    expect(shortClosed.state.trades[0]!.pnl).toBe(-12)
  })
  it('SL/TP in pips resolve to the right prices and fill', () => {
    const e = exitPrices('buy', 1.1, 10, 20, unitSize(EURUSD))
    expect(e.sl).toBeCloseTo(1.099, 10); expect(e.tp).toBeCloseTo(1.102, 10)
    let s = placeOrder(createAccount(EURUSD), { side: 'buy', type: 'market', qty: 100, ...e }, 1, 1.1).state
    expect(s.position).toMatchObject({ sl: 1.099, tp: 1.102 })        // rounded to the 0.00001 tick, no float dust
    s = onBar(s, bar(60000, 1.1, 1.1025, 1.0995, 1.102)).state         // TP touched
    expect(s.position).toBeNull(); expect(s.trades[0]).toMatchObject({ reason: 'tp', pnl: 200 })
  })
  it('gold pips: 1 pip = 0.1, short SL/TP mirror', () => {
    expect(exitPrices('sell', 2000, 50, 100, unitSize(XAUUSD))).toEqual({ sl: 2005, tp: 1990 })
    expect(exitPrices('buy', 24000, 10, undefined, 1)).toEqual({ sl: 23990 })            // futures: points
    expect(exitPrices('buy', 24000, undefined, undefined, 1)).toEqual({})
  })
  it('NQ/ES maths unchanged', () => {
    expect(run(NQ, 20000, 20010.25, 2)).toBe(410)
    expect(run(ES, 5000, 4990, 1, 'sell')).toBe(500)
  })
})

describe('fixed spread (ask = bid + spread), default 0 = not modelled', () => {
  const sp = 0.0002
  it('0 spread is byte-identical to the old behaviour', () => {
    const s = placeOrder(createAccount(EURUSD), { side: 'buy', type: 'market', qty: 100 }, 1, 1.1).state
    expect(s.spread).toBe(0); expect(s.position!.avgPrice).toBe(1.1); expect(equity(s, 1.1)).toBe(50000)
  })
  it('market buy fills at the ask; long is marked at the bid', () => {
    const s = placeOrder(createAccount(EURUSD, 50000, 0, sp), { side: 'buy', type: 'market', qty: 100 }, 1, 1.1).state
    expect(s.position!.avgPrice).toBeCloseTo(1.1002, 10)
    expect(equity(s, 1.1)).toBeCloseTo(50000 - 20, 6)                  // 2 pips x $10/pip paid immediately
    expect(closePosition(s, 1.101, 2).state.cash).toBeCloseTo(50000 + 100 - 20, 6)
  })
  it('market sell fills at the bid; short is marked and closed at the ask', () => {
    const s = placeOrder(createAccount(EURUSD, 50000, 0, sp), { side: 'sell', type: 'market', qty: 100 }, 1, 1.1).state
    expect(s.position!.avgPrice).toBe(1.1)
    expect(equity(s, 1.1)).toBeCloseTo(50000 - 20, 6)
    expect(closePosition(s, 1.099, 2).state.cash).toBeCloseTo(50000 + 100 - 20, 6)
  })
  it('buy limit / buy stop trigger on the ask; sell side unchanged', () => {
    const acc = createAccount(EURUSD, 50000, 0, sp)
    const lim = placeOrder(acc, { side: 'buy', type: 'limit', qty: 100, price: 1.0995 }, 1, 1.1).state
    expect(onBar(lim, bar(60000, 1.1, 1.1, 1.0994, 1.1)).state.position).toBeNull()        // bid low 1.0994 -> ask low 1.0996 > limit
    expect(onBar(lim, bar(60000, 1.1, 1.1, 1.0993, 1.1)).state.position!.avgPrice).toBeCloseTo(1.0995, 10)   // ask low 1.0995 touches
    const stop = placeOrder(acc, { side: 'buy', type: 'stop', qty: 100, price: 1.1005 }, 1, 1.1).state
    expect(onBar(stop, bar(60000, 1.1, 1.1002, 1.1, 1.1)).state.position).toBeNull()
    expect(onBar(stop, bar(60000, 1.1, 1.1003, 1.1, 1.1)).state.position!.avgPrice).toBeCloseTo(1.1005, 10)
    const sell = placeOrder(acc, { side: 'sell', type: 'limit', qty: 100, price: 1.1005 }, 1, 1.1).state
    expect(onBar(sell, bar(60000, 1.1, 1.1005, 1.1, 1.1)).state.position!.avgPrice).toBeCloseTo(1.1005, 10)
  })
  it('SL of a short triggers on the ask', () => {
    const s = placeOrder(createAccount(EURUSD, 50000, 0, sp), { side: 'sell', type: 'market', qty: 100, sl: 1.101 }, 1, 1.1).state
    expect(onBar(s, bar(60000, 1.1, 1.1007, 1.1, 1.1)).state.position).not.toBeNull()   // ask high 1.1009 < SL
    const hit = onBar(s, bar(60000, 1.1, 1.1008, 1.1, 1.1)).state                          // ask high 1.1010 touches
    expect(hit.position).toBeNull(); expect(hit.trades[0]).toMatchObject({ reason: 'sl', exit: 1.101 })
  })
})

describe('daily bars open at 17:00 New York for forex/gold, 18:00 for CME', () => {
  it('sessionStart with openHour 17 incl. DST (EST->EDT 2026-03-08, EDT->EST 2026-11-01)', () => {
    // winter 17:00 EST = 22:00Z, summer 17:00 EDT = 21:00Z
    expect(sessionStart(Date.UTC(2026, 0, 14, 21, 59), 17)).toBe(Date.UTC(2026, 0, 13, 22))
    expect(sessionStart(Date.UTC(2026, 0, 14, 22, 0), 17)).toBe(Date.UTC(2026, 0, 14, 22))
    expect(sessionStart(Date.UTC(2026, 6, 14, 20, 59), 17)).toBe(Date.UTC(2026, 6, 13, 21))
    expect(sessionStart(Date.UTC(2026, 6, 14, 21, 0), 17)).toBe(Date.UTC(2026, 6, 14, 21))
    // spring forward: Fri Mar 6 17:00 EST = 22:00Z, Sun Mar 8 17:00 EDT = 21:00Z
    expect(sessionStart(Date.UTC(2026, 2, 6, 22, 30), 17)).toBe(Date.UTC(2026, 2, 6, 22))
    expect(sessionStart(Date.UTC(2026, 2, 8, 21, 30), 17)).toBe(Date.UTC(2026, 2, 8, 21))
    expect(sessionStart(Date.UTC(2026, 2, 9, 12), 17)).toBe(Date.UTC(2026, 2, 8, 21))
    // fall back: Fri Oct 30 17:00 EDT = 21:00Z, Sun Nov 1 17:00 EST = 22:00Z
    expect(sessionStart(Date.UTC(2026, 9, 30, 20, 55), 17)).toBe(Date.UTC(2026, 9, 29, 21))
    expect(sessionStart(Date.UTC(2026, 9, 30, 21, 0), 17)).toBe(Date.UTC(2026, 9, 30, 21))
    expect(sessionStart(Date.UTC(2026, 10, 1, 21, 55), 17)).toBe(Date.UTC(2026, 9, 31, 21))
    expect(sessionStart(Date.UTC(2026, 10, 1, 22, 0), 17)).toBe(Date.UTC(2026, 10, 1, 22))
  })
  it('default stays 18:00 and openHour only affects the daily bucket', () => {
    expect(sessionStart(Date.UTC(2026, 0, 14, 22, 30))).toBe(Date.UTC(2026, 0, 13, 23))   // unchanged CME behaviour (18:00 EST = 23:00Z)
    expect(bucketStart(Date.UTC(2026, 0, 14, 22, 30), 1440, 17)).toBe(Date.UTC(2026, 0, 14, 22))
    expect(bucketStart(Date.UTC(2026, 0, 14, 22, 30), 60, 17)).toBe(Date.UTC(2026, 0, 14, 22))
    expect(bucketStart(Date.UTC(2026, 0, 14, 22, 30), 60)).toBe(Date.UTC(2026, 0, 14, 22))
  })
  it('daily aggregate / aggregateUpTo / foldBar honour openHour', () => {
    const H = 3_600_000, t0 = Date.UTC(2026, 0, 14, 20)            // 15:00 EST Wed
    const base = Array.from({ length: 6 }, (_, i) => bar(t0 + i * H, 1 + i, 2 + i, i, 1.5 + i))   // 20:00..01:00Z
    const d17 = aggregate(base, 60, 1440, 17), d18 = aggregate(base, 60, 1440)
    expect(d17.map((b) => b.t)).toEqual([Date.UTC(2026, 0, 13, 22), Date.UTC(2026, 0, 14, 22)])    // split at 22:00Z
    expect(d18.map((b) => b.t)).toEqual([Date.UTC(2026, 0, 13, 23), Date.UTC(2026, 0, 14, 23)])    // split at 23:00Z
    expect(d17[0]).toMatchObject({ o: 1, c: 2.5 }); expect(d17[1]).toMatchObject({ o: 3, c: 6.5 })
    expect(aggregateUpTo(base, 60, 1440, 2, 17).map((b) => b.t)).toEqual([Date.UTC(2026, 0, 13, 22), Date.UTC(2026, 0, 14, 22)])
    expect(foldBar(d17[0], base[2]!, 1440, 17).t).toBe(Date.UTC(2026, 0, 14, 22))
  })
})

describe('datasets: forex/gold keep sources separate and honestly labelled', () => {
  const local = [{ symbol: 'EURUSD', appSymbol: 'EURUSD', label: 'x', source: 's', resolutionMinutes: 1, from: Date.UTC(2003, 4, 5), to: Date.UTC(2026, 9, 5), count: 1, files: [{ file: 'a.csv.gz', from: 1, to: 2, count: 1 }] }]
  it('Dukascopy spot label shows real range; Yahoo spot archive is distinct from the Dukascopy one', () => {
    const ds = datasetsFor(EURUSD, local, [])
    const duk = ds.find((d) => d.kind === 'local')!
    expect(duk.label).toBe('EURUSD · Dukascopy spot 1m bid (2003-05-05 → 2026-10-05)')
    expect(duk.storeSymbol).toBe('EURUSD.dukascopy')
    const y = ds.filter((d) => d.kind === 'yahoo')
    expect(y.map((d) => d.storeSymbol)).toEqual(['EURUSD.yahoo', 'EURUSD.yahoo'])
    expect(new Set([duk.storeSymbol, ...y.map((d) => d.storeSymbol)]).size).toBe(2)
    expect(y[0]!.label).toMatch(/EURUSD spot · Yahoo 5m/)
  })
  it('gold Yahoo set is GC=F, labelled futures; NQ labels unchanged', () => {
    expect(yahooDatasets(XAUUSD)[0]!.label).toBe('XAUUSD futures (GC=F) · Yahoo 5m (last 60d)')
    expect(yahooDatasets(NQ)[0]!).toMatchObject({ label: 'NQ futures · Yahoo 5m (last 60d)', storeSymbol: 'NQ' })
    expect(localStoreSymbol('USATECHIDXUSD')).toBe('USATECHIDXUSD')
  })
})
