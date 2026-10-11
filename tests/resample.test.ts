import { describe, expect, it } from 'vitest'
import fixture from './fixtures/nq5m.json'
import { aggregate, aggregateUpTo, bucketStart, sessionStart, updateForming } from '../src/data/resample'
import type { Bar } from '../src/types'

const base: Bar[] = (fixture as { openTime: number; open: number; high: number; low: number; close: number; volume: number }[])
  .map(r => ({ t: r.openTime, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume }))

// Synthetic 5m bars Fri 2026-10-30 12:00Z .. Tue 2026-11-03 (skips Sat), spanning the US DST end (Sun 2026-11-01 06:00Z).
function dstFixture(): Bar[] {
  const out: Bar[] = []
  let p = 100, seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let t = Date.UTC(2026, 9, 30, 12); t < Date.UTC(2026, 10, 3, 12); t += 300_000) {
    const day = new Date(t).getUTCDay()
    if (day === 6) continue
    const o = p, c = p + (rnd() - 0.5) * 2
    out.push({ t, o, h: Math.max(o, c) + rnd(), l: Math.min(o, c) - rnd(), c, v: Math.floor(rnd() * 100) })
    p = c
  }
  return out
}

describe('aggregate', () => {
  it('aggregates OHLCV correctly and aligns to epoch multiples', () => {
    for (const tf of [15, 60, 240]) {
      const agg = aggregate(base, 5, tf)
      expect(agg.every(b => b.t % (tf * 60_000) === 0)).toBe(true)
      expect(agg.reduce((s, b) => s + b.v, 0)).toBe(base.reduce((s, b) => s + b.v, 0))
      expect(Math.max(...agg.map(b => b.h))).toBe(Math.max(...base.map(b => b.h)))
      expect(agg[0].o).toBe(base[0].o)
      expect(agg[agg.length - 1].c).toBe(base[base.length - 1].c)
    }
  })
  it('hand-checked 15m bucket', () => {
    const b = (t: number, o: number, h: number, l: number, c: number, v: number): Bar => ({ t, o, h, l, c, v })
    const T = 900_000 * 1000
    const r = aggregate([b(T, 1, 5, 1, 2, 1), b(T + 300_000, 2, 9, 2, 3, 2), b(T + 600_000, 3, 4, 0, 4, 3), b(T + 900_000, 4, 4, 4, 4, 4)], 5, 15)
    expect(r).toEqual([{ t: T, o: 1, h: 9, l: 0, c: 4, v: 6 }, { t: T + 900_000, o: 4, h: 4, l: 4, c: 4, v: 4 }])
  })
  it('does not mutate input', () => {
    const copy = JSON.stringify(base)
    aggregate(base, 5, 60)
    expect(JSON.stringify(base)).toBe(copy)
  })
  it('rejects bad timeframes', () => {
    expect(() => aggregate(base, 5, 7)).toThrow()
    expect(() => aggregate(base, 5, 10080)).toThrow(/Unsupported/)
  })
})

describe('daily session (18:00 America/New_York)', () => {
  it('session start across DST end', () => {
    // Before change (EDT, UTC-4): 18:00 NY = 22:00Z
    expect(sessionStart(Date.UTC(2026, 9, 30, 21, 55))).toBe(Date.UTC(2026, 9, 29, 22))
    expect(sessionStart(Date.UTC(2026, 9, 30, 22, 0))).toBe(Date.UTC(2026, 9, 30, 22))
    // Sun Nov 1 after change (EST, UTC-5): 18:00 NY = 23:00Z; 22:55Z is still the session opened Sat Oct 31 18:00 EDT = 22:00Z
    expect(sessionStart(Date.UTC(2026, 10, 1, 22, 55))).toBe(Date.UTC(2026, 9, 31, 22))
    expect(sessionStart(Date.UTC(2026, 10, 1, 23, 0))).toBe(Date.UTC(2026, 10, 1, 23))
    expect(bucketStart(Date.UTC(2026, 10, 2, 12), 1440)).toBe(Date.UTC(2026, 10, 1, 23))
  })
  it('DST start (spring) too', () => {
    // 2026-03-08: EST->EDT. Sun 18:00 EDT = 22:00Z; Fri 18:00 EST = 23:00Z
    expect(sessionStart(Date.UTC(2026, 2, 9, 12))).toBe(Date.UTC(2026, 2, 8, 22))
    expect(sessionStart(Date.UTC(2026, 2, 6, 23, 30))).toBe(Date.UTC(2026, 2, 6, 23))
  })
  it('daily aggregate on DST fixture splits sessions correctly', () => {
    const d = aggregate(dstFixture(), 5, 1440)
    expect(d.map(b => b.t)).toEqual([Date.UTC(2026, 9, 29, 22), Date.UTC(2026, 9, 30, 22), Date.UTC(2026, 9, 31, 22), Date.UTC(2026, 10, 1, 23), Date.UTC(2026, 10, 2, 23)])
  })
})

describe('no-lookahead forming candle', () => {
  const cases: [string, Bar[], number[]][] = [
    ['nq fixture', base, [15, 60, 240, 1440]],
    ['dst fixture', dstFixture(), [15, 60, 1440]],
  ]
  for (const [name, bars, tfs] of cases) {
    for (const tf of tfs) {
      it(`aggregateUpTo(k) == aggregate(slice(0,k+1)) and updateForming agrees: ${name} ${tf}m`, () => {
        let inc: Bar[] = []
        for (let k = 0; k < bars.length; k++) {
          inc = updateForming(inc, bars[k], tf)
          const expected = aggregate(bars.slice(0, k + 1), 5, tf)
          expect(aggregateUpTo(bars, 5, tf, k)).toEqual(expected)
          expect(inc).toEqual(expected)
        }
      })
    }
  }
  it('forming candle excludes future base bars', () => {
    const r = aggregateUpTo(base, 5, 60, 3)
    const last = r[r.length - 1]
    expect(last.c).toBe(base[3].c)
  })
})
