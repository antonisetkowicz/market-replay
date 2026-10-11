import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script
import {
  mergeLines, monthRanges, parseArgs, rowsToCsv, planJobs, gzipCsv, gunzipCsv, csvText, bodyLines, hasEnoughSpace, assertDiskSpace, DiskLowError,
  markMonthDone, markMonthFailed, failedMonths, isMonthDone, is429, gzipExisting, SOURCES, waitForRecovery, RateLimitStuckError,
} from '../scripts/download-dukascopy.mjs'

const d = (s: string) => new Date(`${s}T00:00:00Z`)

describe('download helpers (no network)', () => {
  it('monthRanges clips to [from,to) and flags full months', () => {
    const r = monthRanges(d('2025-11-15'), d('2026-01-10'))
    expect(r.map((x: { key: string }) => x.key)).toEqual(['2025-11', '2025-12', '2026-01'])
    expect(r.map((x: { full: boolean }) => x.full)).toEqual([false, true, false])
    expect(r[0].from).toEqual(d('2025-11-15')); expect(r[2].to).toEqual(d('2026-01-10'))
  })
  it('monthRanges rejects an empty range', () => expect(() => monthRanges(d('2026-01-01'), d('2026-01-01'))).toThrow())
  it('mergeLines unions by timestamp, newer wins, ascending', () => {
    expect(mergeLines(['3,a', '1,a'], ['2,b', '3,b'])).toEqual(['1,a', '2,b', '3,b'])
  })
  it('rowsToCsv matches the format csv.ts parses', () => {
    expect(rowsToCsv([{ timestamp: 1, open: 2, high: 3, low: 1, close: 2, volume: 0.5 }, { timestamp: 2, open: 2, high: 3, low: 1, close: 2 }])).toEqual(['1,2,3,1,2,0.5', '2,2,3,1,2,0'])
  })
  it('parseArgs validates input and never goes past today', () => {
    const now = new Date('2026-10-05T10:00:00Z')
    const a = parseArgs(['--from', '2025-10-01', '--to', '2030-01-01', '--symbols', 'usatechidxusd'], now)
    expect(a.to).toEqual(d('2026-10-05')); expect(a.symbols).toEqual(['USATECHIDXUSD'])
    expect(parseArgs([], now).from).toEqual(d('2025-10-05'))
    expect(() => parseArgs(['--from', 'nope'], now)).toThrow(/Invalid --from/)
    expect(() => parseArgs(['--symbols', 'FOO'], now)).toThrow(/Unknown symbol/)
  })
})

describe('deep-history downloader logic (no network)', () => {
  it('planJobs is newest-first: year desc, symbols interleaved per year, months desc', () => {
    const jobs = planJobs([{ symbol: 'A', from: d('2024-11-01') }, { symbol: 'B', from: d('2024-12-01') }], d('2025-02-10'))
    expect(jobs.map((j: { symbol: string; key: string }) => `${j.symbol}${j.key}`)).toEqual(['A2025-02', 'A2025-01', 'B2025-02', 'B2025-01', 'A2024-12', 'A2024-11', 'B2024-12'])
    expect(jobs[0].year).toBeGreaterThanOrEqual(jobs.at(-1).year)
  })
  it('full-history symbols are registered', () => {
    for (const s of ['EURUSD', 'GBPUSD', 'XAUUSD']) expect(SOURCES[s].fullHistory).toBe(true)
  })
  it('gz round trip keeps text and row count', () => {
    const lines = ['1,1.1,1.2,1.0,1.1,0.5', '2,1.1,1.3,1.1,1.2,0']
    const text = csvText(lines)
    const back = gunzipCsv(gzipCsv(text))
    expect(back).toBe(text); expect(bodyLines(back)).toEqual(lines)
  })
  it('disk guard: pure check and thrown error under the limit', async () => {
    const GB = 1024 ** 3
    expect(hasEnoughSpace(3 * GB, 3 * GB)).toBe(true); expect(hasEnoughSpace(3 * GB - 1, 3 * GB)).toBe(false); expect(hasEnoughSpace(NaN)).toBe(false)
    await expect(assertDiskSpace('/x', 3 * GB, async () => 1 * GB)).rejects.toBeInstanceOf(DiskLowError)
    expect(await assertDiskSpace('/x', 3 * GB, async () => 5 * GB)).toBe(5 * GB)
  })
  it('failed-month bookkeeping: failed stays retryable, success clears it, input is not mutated', () => {
    const m0 = { months: {}, failed: [] as { month: string }[] }
    const m1 = markMonthFailed(m0, '2010-03', 'HTTP 503', 't')
    expect(m0.failed).toEqual([]); expect(failedMonths(m1)).toEqual(['2010-03'])
    const month = { key: '2010-03', full: true }
    expect(isMonthDone(m1, month)).toBe(false)                       // re-run retries it
    const m2 = markMonthDone(markMonthFailed(m1, '2009-01', 'x', 't'), '2010-03', 100, true)
    expect(failedMonths(m2)).toEqual(['2009-01']); expect(isMonthDone(m2, month)).toBe(true)
    expect(isMonthDone(markMonthDone(m0, '2010-03', 1, true), { key: '2010-03', full: false })).toBe(false) // clipped range is never skipped
  })
  it('detects rate limiting', () => {
    expect(is429(new Error('Request failed with status 429'))).toBe(true); expect(is429(new Error('Too Many Requests'))).toBe(true); expect(is429(new Error('status 503'))).toBe(false)
  })
  it('waitForRecovery probes until the limit lifts, and gives up after maxMs', async () => {
    const sleeps: number[] = []; let n = 0
    const waited = await waitForRecovery(async () => ++n >= 3, async (ms: number) => { sleeps.push(ms) }, { stepsMs: [1, 2], maxMs: 100, logFn: () => {} })
    expect(sleeps).toEqual([1, 2, 2]); expect(waited).toBe(5)
    await expect(waitForRecovery(async () => false, async () => {}, { stepsMs: [10], maxMs: 30, logFn: () => {} })).rejects.toBeInstanceOf(RateLimitStuckError)
  })
  it('gzipExisting converts, verifies, updates meta and removes the original', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mr-gz-')); await mkdir(path.join(dir, 'S'))
    const text = csvText(['1,1,1,1,1,0', '2,1,2,1,2,0'])
    await writeFile(path.join(dir, 'S', 'S_1m_2025.csv'), text)
    await writeFile(path.join(dir, 'S', 'meta.json'), JSON.stringify({ files: [{ file: 'S_1m_2025.csv', year: 2025, count: 2, from: 1, to: 2 }] }))
    await gzipExisting(dir)
    expect((await readdir(path.join(dir, 'S'))).sort()).toEqual(['S_1m_2025.csv.gz', 'meta.json'])
    expect(gunzipCsv(await readFile(path.join(dir, 'S', 'S_1m_2025.csv.gz')))).toBe(text)
    expect(JSON.parse(await readFile(path.join(dir, 'S', 'meta.json'), 'utf8')).files[0]).toMatchObject({ file: 'S_1m_2025.csv.gz', count: 2 })
  })
})
