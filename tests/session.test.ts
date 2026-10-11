import { describe, expect, it } from 'vitest'
import { LiveSeries } from '../src/replay/liveSeries'
import { aggregate, updateForming } from '../src/data/resample'
import { computeStats, DrawdownTracker } from '../src/broker/stats'
import { clampToRange, dateInputToTs, lastIndexAtOrBefore } from '../src/data/dates'
import { inferIntervalMinutes } from '../src/data/importCsv'
import type { Bar } from '../src/types'

const MIN = 60_000
const T0 = Date.UTC(2025, 0, 6, 14, 0)
const mk = (n: number): Bar[] => Array.from({ length: n }, (_, i) => { const c = 100 + Math.sin(i / 7) * 5; return { t: T0 + i * MIN, o: c, h: c + 1, l: c - 1, c: c + 0.5, v: 1 } })

describe('LiveSeries == immutable updateForming/aggregate', () => {
  it.each([1, 5, 60, 1440])('tf %i', (tf) => {
    const base = mk(900)
    const cut = 400
    const live = new LiveSeries(); live.load(aggregate(base.slice(0, cut), 1, tf))
    let imm = aggregate(base.slice(0, cut), 1, tf)
    for (const b of base.slice(cut)) { live.fold(b, tf); imm = updateForming(imm, b, tf) }
    expect(live.snapshot()).toEqual(imm)
    expect(live.snapshot()).toEqual(aggregate(base, 1, tf))
  })
  it('load copies; tail/snapshot are copies', () => {
    const src = aggregate(mk(10), 1, 1); const live = new LiveSeries(); live.load(src)
    live.fold({ t: T0 + 10 * MIN, o: 1, h: 1, l: 1, c: 1, v: 1 }, 1)
    expect(src).toHaveLength(10); expect(live.length).toBe(11)
    live.snapshot().pop(); live.tail(3).pop(); expect(live.length).toBe(11)
  })
})

describe('DrawdownTracker == full-curve scan', () => {
  it('matches computeStats on arrays', () => {
    const curve = [100, 120, 90, 130, 80, 140]
    const t = new DrawdownTracker(); curve.forEach((v) => t.push(v))
    expect(computeStats([], t)).toEqual(computeStats([], curve))
    expect(computeStats([], t).maxDrawdown).toBe(50)
  })
  it('ignores non-finite values', () => {
    const t = new DrawdownTracker(100); t.push(NaN); t.push(90)
    expect(t.result.abs).toBe(10)
  })
})

describe('dates', () => {
  it('date input -> 09:30 New York (DST aware)', () => {
    expect(new Date(dateInputToTs('2025-01-15')!).toISOString()).toBe('2025-01-15T14:30:00.000Z')
    expect(new Date(dateInputToTs('2025-07-15')!).toISOString()).toBe('2025-07-15T13:30:00.000Z')
    for (const bad of ['', 'x', '2025-02-30', '2025-13-01', '25-01-01']) expect(dateInputToTs(bad)).toBeNull()
  })
  it('clamps and binary-searches', () => {
    expect(clampToRange(5, 10, 20)).toEqual({ ts: 10, clamped: 'before' })
    expect(clampToRange(25, 10, 20)).toEqual({ ts: 20, clamped: 'after' })
    expect(clampToRange(15, 10, 20).clamped).toBeNull()
    const bars = [{ t: 10 }, { t: 20 }, { t: 30 }]
    expect([5, 10, 25, 30, 99].map((t) => lastIndexAtOrBefore(bars, t))).toEqual([-1, 0, 1, 2, 2])
    expect(lastIndexAtOrBefore([], 1)).toBe(-1)
  })
})

describe('inferIntervalMinutes', () => {
  it('detects 1m / 5m / 60m, tolerating gaps', () => {
    for (const m of [1, 5, 60]) {
      const bars = Array.from({ length: 50 }, (_, i) => ({ t: i * m * MIN + (i > 25 ? 3 * m * MIN : 0), o: 1, h: 1, l: 1, c: 1, v: 0 }))
      expect(inferIntervalMinutes(bars)).toBe(m)
    }
  })
  it('rejects sub-minute / single bar', () => {
    expect(() => inferIntervalMinutes([{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 0 }])).toThrow()
    expect(() => inferIntervalMinutes([0, 1000, 2000].map((t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 0 })))).toThrow(/whole-minute/)
  })
})
