import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { aggregate, aggregateUpTo, updateForming } from '../src/data/resample'
import { decodeBars, encodeBars, loadBars, saveBars } from '../src/data/store'
import { LiveSeries } from '../src/replay/liveSeries'
import { computeStats, DrawdownTracker } from '../src/broker/stats'
import { lastIndexAtOrBefore } from '../src/data/dates'
import type { Bar } from '../src/types'

// Synthetic 300k x 1m bars (~13 months of index-CFD sessions). Numbers are printed; thresholds are generous.
const N = 300_000, MIN = 60_000, T0 = Date.UTC(2025, 0, 6, 0, 0)
const bars: Bar[] = Array.from({ length: N }, (_, i) => {
  const c = 20000 + Math.sin(i / 500) * 300 + (i % 7)
  return { t: T0 + Math.floor(i / 1330) * 86_400_000 + (i % 1330) * MIN, o: c, h: c + 2, l: c - 2, c: c + 1, v: 1 }
})
const ms = (f: () => void): number => { const s = performance.now(); f(); return performance.now() - s }
const STEPS = 300, START = N - 1000 // sample steps deep into a 300k-bar replay
const equityOf = (i: number) => 100_000 + (i % 50) * 3

describe(`perf @ ${N} 1m bars`, () => {
  it('per-step cost: legacy (copy every step) vs LiveSeries/DrawdownTracker', () => {
    const tf = 1 // worst case: series length == bar count
    const base = aggregate(bars.slice(0, START), 1, tf)
    // legacy: updateForming copied the array, ChartView copied its own again, equity curve was spread and fully rescanned by computeStats
    let series = base, chartCopy = base.slice(), curve: number[] = Array.from({ length: START }, (_, i) => equityOf(i))
    const legacy = ms(() => {
      for (let i = START; i < START + STEPS; i++) {
        series = updateForming(series, bars[i]!, tf)
        const l = series[series.length - 1]!
        chartCopy = chartCopy.at(-1)!.t === l.t ? [...chartCopy.slice(0, -1), l] : [...chartCopy, l]
        curve = [...curve, equityOf(i)]
        computeStats([], curve)
      }
    }) / STEPS
    const live = new LiveSeries(); live.load(base)
    const dd = new DrawdownTracker(); for (let i = 0; i < START; i++) dd.push(equityOf(i))
    const work: Bar[] = base.slice()
    const fresh = ms(() => {
      for (let i = START; i < START + STEPS; i++) {
        const l = live.fold(bars[i]!, tf)
        if (work.at(-1)!.t === l.t) work[work.length - 1] = l; else work.push(l)   // ChartView in-place update
        dd.push(equityOf(i))
        computeStats([], dd)
      }
    }) / STEPS
    console.log(`[perf] step @${START} bars: legacy ${legacy.toFixed(3)} ms/step -> now ${fresh.toFixed(4)} ms/step (x${(legacy / fresh).toFixed(0)})`)
    expect(fresh).toBeLessThan(0.5)
    expect(fresh).toBeLessThan(legacy)
  })

  it('replay begin (one-off): index lookup + aggregateUpTo', () => {
    for (const tf of [1, 5, 60, 1440]) {
      const t = ms(() => { const i = lastIndexAtOrBefore(bars, bars[N - 10]!.t); aggregateUpTo(bars, 1, tf, i) })
      console.log(`[perf] begin @300k, tf=${tf}m: ${t.toFixed(0)} ms`)
      expect(t).toBeLessThan(1000)
    }
  })

  it('IndexedDB: chunked columnar save + load', async () => {
    let dec: Bar[] = []
    const enc = ms(() => { dec = decodeBars(encodeBars(bars)) })
    const tSave = await (async () => { const s = performance.now(); await saveBars('PERF', 1, bars); return performance.now() - s })()
    const tLoad = await (async () => { const s = performance.now(); dec = await loadBars('PERF', 1); return performance.now() - s })()
    console.log(`[perf] encode+decode ${enc.toFixed(0)} ms, save ${tSave.toFixed(0)} ms, load ${tLoad.toFixed(0)} ms (fake-indexeddb, node)`)
    expect(dec).toHaveLength(N)
    expect(dec[N - 1]).toEqual(bars[N - 1])
  }, 60_000)
})
