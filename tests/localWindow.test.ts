import 'fake-indexeddb/auto'
import { gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { barsInMonths, ensureMonths, loadWindowBars, planImport, readCsvText, seriesBounds } from '../src/data/localWindow'
import { loadBarsRange, listSeries } from '../src/data/store'
import type { LocalSeries } from '../src/data/localData'

const D = (s: string) => Date.parse(s)
const HEAD = 'timestamp,open,high,low,close,volume'
/** one bar per day-of-month at 12:00Z for each given month */
const csv = (months: string[], days = [1, 15]) =>
  [HEAD, ...months.flatMap((m) => days.map((d) => { const t = D(`${m}-${String(d).padStart(2, '0')}T12:00:00Z`); return `${t},1,2,0.5,1.5,3` }))].join('\n') + '\n'

const file = (file: string, from: string, to: string, count = 4) => ({ file, from: D(from), to: D(to), count })
const series = (files: ReturnType<typeof file>[]): LocalSeries => ({
  symbol: 'EURUSD', appSymbol: 'EURUSD', label: 'l', source: 's', resolutionMinutes: 1,
  from: Math.min(...files.map((f) => f.from)), to: Math.max(...files.map((f) => f.to)), count: 0, files,
})

describe('planImport (pure)', () => {
  const f25 = file('E_2025.csv.gz', '2025-01-01T00:00:00Z', '2025-12-31T23:59:00Z')
  const f26 = file('E_2026.csv.gz', '2026-01-01T00:00:00Z', '2026-10-05T10:00:00Z')
  const s = series([f25, f26])
  it('maps months to the files covering them, one entry per file', () => {
    const p = planImport(s, ['2025-11', '2025-12', '2026-01', '2026-02'], {})
    expect(p.files.map((x) => [x.file.file, x.months])).toEqual([['E_2025.csv.gz', ['2025-11', '2025-12']], ['E_2026.csv.gz', ['2026-01', '2026-02']]])
  })
  it('skips months whose cached fingerprint still matches, redoes stale ones', () => {
    const first = planImport(s, ['2026-09', '2026-10'], {})
    expect(planImport(s, ['2026-09', '2026-10'], first.fp).files).toEqual([])
    const grown = series([f25, { ...f26, count: f26.count + 10, to: f26.to + 60000 }])
    expect(planImport(grown, ['2026-09', '2026-10'], first.fp).files[0]!.months).toEqual(['2026-09', '2026-10'])
  })
  it('ignores months no file covers', () => {
    expect(planImport(s, ['2024-05', '2027-01'], {})).toEqual({ files: [], fp: {} })
  })
  it('seriesBounds is the month range of the index', () => {
    expect(seriesBounds(s)).toEqual({ from: '2025-01', to: '2026-10' })
  })
})

describe('reading files', () => {
  it('barsInMonths keeps only the requested months', () => {
    const bars = barsInMonths(csv(['2025-01', '2025-02', '2025-03']), ['2025-01', '2025-03'])
    expect(bars.map((b) => new Date(b.t).toISOString().slice(0, 7))).toEqual(['2025-01', '2025-01', '2025-03', '2025-03'])
    expect(barsInMonths(csv(['2025-01']), ['2030-01'])).toEqual([])
  })
  it('readCsvText handles plain text and gzip (by magic bytes, wherever the decompression happened)', async () => {
    const text = csv(['2025-01'])
    expect(await readCsvText(new Response(text))).toBe(text)
    expect(await readCsvText(new Response(gzipSync(text)))).toBe(text)
  })
})

describe('windowed import into the chunk store', () => {
  beforeEach(() => { globalThis.indexedDB = new IDBFactory() })
  const f = file('E_2025.csv.gz', '2025-01-01T00:00:00Z', '2025-06-30T23:00:00Z')
  const s = series([f])
  const mkFetch = (body: () => string) => { const calls: string[] = []; const fn = (async (u: string) => { calls.push(u); return new Response(gzipSync(body())) }) as unknown as typeof fetch; return { fn, calls } }

  it('imports only the requested months, once; later loads are served from the cache', async () => {
    const { fn, calls } = mkFetch(() => csv(['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06']))
    const bars = await loadWindowBars(s, 'EURUSD.dukascopy', { from: '2025-02', to: '2025-04' }, undefined, fn)
    expect(bars).toHaveLength(6)
    expect(bars[0]!.t).toBe(D('2025-02-01T12:00:00Z')); expect(bars.at(-1)!.t).toBe(D('2025-04-15T12:00:00Z'))
    expect(calls).toEqual(['/local/EURUSD/E_2025.csv.gz'])
    expect((await listSeries())[0]).toMatchObject({ symbol: 'EURUSD.dukascopy', count: 6 })   // only the window is stored, not the whole file
    await loadWindowBars(s, 'EURUSD.dukascopy', { from: '2025-03', to: '2025-04' }, undefined, fn)
    expect(calls).toHaveLength(1)
    const wider = await loadWindowBars(s, 'EURUSD.dukascopy', { from: '2025-01', to: '2025-06' }, undefined, fn)
    expect(calls).toHaveLength(2); expect(wider).toHaveLength(12)                              // only the missing months were added, no duplicates
  })
  it('a grown source file (new fingerprint) refreshes cached months', async () => {
    const { fn, calls } = mkFetch(() => csv(['2025-06'], [1]))
    await loadWindowBars(s, 'X', { from: '2025-06', to: '2025-06' }, undefined, fn)
    const grown = series([{ ...f, count: f.count + 1, to: f.to + 1 }])
    const r = mkFetch(() => csv(['2025-06'], [1, 20]))
    expect(await loadWindowBars(grown, 'X', { from: '2025-06', to: '2025-06' }, undefined, r.fn)).toHaveLength(2)
    expect(calls).toHaveLength(1); expect(r.calls).toHaveLength(1)
  })
  it('reports progress and surfaces HTTP errors without recording the fingerprint', async () => {
    const msgs: string[] = []
    const bad = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(ensureMonths(s, 'Y', ['2025-02'], (m) => msgs.push(m), bad)).rejects.toThrow(/HTTP 500/)
    expect(msgs[0]).toMatch(/reading E_2025.csv.gz/)
    const ok = mkFetch(() => csv(['2025-02']))
    expect(await ensureMonths(s, 'Y', ['2025-02'], undefined, ok.fn)).toBe(2)                  // retried, not considered cached
  })
  it('loadBarsRange returns exactly the month range, ascending', async () => {
    const { fn } = mkFetch(() => csv(['2025-01', '2025-02', '2025-03']))
    await ensureMonths(s, 'Z', ['2025-01', '2025-02', '2025-03'], undefined, fn)
    const r = await loadBarsRange('Z', 1, '2025-02', '2025-02')
    expect(r.map((b) => b.t)).toEqual([D('2025-02-01T12:00:00Z'), D('2025-02-15T12:00:00Z')])
    expect(await loadBarsRange('Z', 1, '2024-01', '2024-12')).toEqual([])
  })
})
