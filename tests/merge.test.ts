import { describe, expect, it } from 'vitest'
import { mergeBars } from '../src/data/store'
import { maxRangeFor, parseYahooChart } from '../src/data/yahoo'
import type { Bar } from '../src/types'

const bar = (t: number, c: number): Bar => ({ t, o: c, h: c, l: c, c, v: 1 })

describe('mergeBars', () => {
  it('unions, sorts, new data overwrites same t, inputs untouched', () => {
    const a = [bar(3, 1), bar(1, 1)]
    const b = [bar(2, 2), bar(3, 9)]
    const m = mergeBars(a, b)
    expect(m.map(x => [x.t, x.c])).toEqual([[1, 1], [2, 2], [3, 9]])
    expect(a.map(x => x.t)).toEqual([3, 1])
  })
  it('handles empties', () => {
    expect(mergeBars([], [])).toEqual([])
    expect(mergeBars([bar(1, 1)], [])).toHaveLength(1)
  })
})

describe('yahoo', () => {
  const ok = { chart: { error: null, result: [{ timestamp: [100, 160, 220], indicators: { quote: [{
    open: [1, null, 3], high: [2, 2, 4], low: [0, 0, 2], close: [1.5, 1, 3.5], volume: [10, 5, null] }] } }] } }
  it('parses, converts seconds to ms, drops null OHLC, null volume -> 0', () => {
    expect(parseYahooChart(ok)).toEqual([{ t: 100_000, o: 1, h: 2, l: 0, c: 1.5, v: 10 }, { t: 220_000, o: 3, h: 4, l: 2, c: 3.5, v: 0 }])
  })
  it('throws clear errors', () => {
    expect(() => parseYahooChart({})).toThrow(/chart/)
    expect(() => parseYahooChart({ chart: { error: { code: 'Bad', description: 'nope' } } })).toThrow(/Bad/)
    expect(() => parseYahooChart({ chart: { result: [] } })).toThrow(/no result/)
  })
  it('limits', () => {
    expect(maxRangeFor('1m')).toBe('7d')
    expect(maxRangeFor('5m')).toBe('60d')
    expect(maxRangeFor('1h')).toBe('730d')
  })
})
