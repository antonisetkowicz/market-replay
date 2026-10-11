import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { clearSeries, decodeBars, encodeBars, groupByMonth, listSeries, loadBars, saveBars } from '../src/data/store'
import type { Bar } from '../src/types'

const bar = (t: number, c: number): Bar => ({ t, o: c, h: c + 1, l: c - 1, c, v: 2 })
const D = (s: string) => Date.parse(s)

beforeEach(() => { globalThis.indexedDB = new IDBFactory() })

describe('columnar encoding', () => {
  it('round-trips bars exactly', () => {
    const bars = [bar(1, 1.25), bar(2, 3.5)]
    expect(decodeBars(encodeBars(bars))).toEqual(bars)
  })
  it('groups by UTC month', () => {
    const g = groupByMonth([bar(D('2025-01-31T23:59:00Z'), 1), bar(D('2025-02-01T00:00:00Z'), 2)])
    expect([...g.keys()]).toEqual(['2025-01', '2025-02'])
  })
})

describe('chunked archive', () => {
  it('saves across months, loads sorted and unique, merges overwrite', async () => {
    const a = [bar(D('2025-03-01T00:00:00Z'), 1), bar(D('2025-01-15T00:00:00Z'), 2), bar(D('2025-02-10T00:00:00Z'), 3)]
    await saveBars('NQ', 5, a)
    await saveBars('NQ', 5, [bar(D('2025-02-10T00:00:00Z'), 99), bar(D('2025-02-11T00:00:00Z'), 4)])
    const out = await loadBars('NQ', 5)
    expect(out.map((b) => b.c)).toEqual([2, 99, 4, 1])
    expect(out.map((b) => b.t)).toEqual([...out.map((b) => b.t)].sort((x, y) => x - y))
  })
  it('keeps series isolated and lists meta without reading bars', async () => {
    await saveBars('NQ', 5, [bar(D('2025-01-01T00:00:00Z'), 1), bar(D('2025-01-02T00:00:00Z'), 1)])
    await saveBars('NQ', 15, [bar(D('2025-01-01T00:00:00Z'), 1)])
    await saveBars('NQ.import', 1, [bar(D('2025-06-01T00:00:00Z'), 1)])
    expect((await loadBars('NQ', 5))).toHaveLength(2)
    expect((await loadBars('NQ', 1))).toHaveLength(0)
    const list = await listSeries()
    expect(list.map((s) => [s.symbol, s.intervalMinutes, s.count])).toEqual([['NQ', 5, 2], ['NQ', 15, 1], ['NQ.import', 1, 1]])
    expect(list[0]).toMatchObject({ from: D('2025-01-01T00:00:00Z'), to: D('2025-01-02T00:00:00Z') })
  })
  it('meta count stays correct when re-saving overlapping bars', async () => {
    const b = [bar(D('2025-01-01T00:00:00Z'), 1), bar(D('2025-01-02T00:00:00Z'), 1)]
    await saveBars('NQ', 5, b); await saveBars('NQ', 5, b)
    expect((await listSeries())[0]!.count).toBe(2)
  })
  it('clearSeries removes bars and meta', async () => {
    await saveBars('NQ', 5, [bar(1_700_000_000_000, 1)])
    await clearSeries('NQ', 5)
    expect(await loadBars('NQ', 5)).toEqual([])
    expect(await listSeries()).toEqual([])
  })
  it('migrates a v1 whole-series record on first load', async () => {
    await new Promise<void>((res, rej) => {
      const r = indexedDB.open('market-replay', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('series', { keyPath: 'key' })
      r.onsuccess = () => {
        const t = r.result.transaction('series', 'readwrite')
        t.objectStore('series').put({ key: 'NQ|5', symbol: 'NQ', intervalMinutes: 5, bars: [bar(D('2025-01-01T00:00:00Z'), 7)] })
        t.oncomplete = () => { r.result.close(); res() }
        t.onerror = () => rej(t.error)
      }
    })
    expect((await loadBars('NQ', 5)).map((b) => b.c)).toEqual([7])
    expect((await listSeries())[0]).toMatchObject({ symbol: 'NQ', count: 1 })
    expect((await loadBars('NQ', 5))).toHaveLength(1) // migrated once, not duplicated
  })
})
