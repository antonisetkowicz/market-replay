#!/usr/bin/env node
// Polite, resumable 1m downloader: Dukascopy public datafeed (via dukascopy-node) -> ../data/<SYMBOL>/<SYMBOL>_1m_<YYYY>.csv.gz
// Personal use only. BID candles of spot/CFD instruments (NOT futures). Throttled: MR_BATCH parallel (default 1, max 3), MR_PAUSE_MS between batches (default 1500, min 1000), retry/backoff, 429 -> pause + probe until lifted.
// Newest -> oldest (recent years usable first), symbols interleaved per year. Resume = run the same command again.
// Refuses to start/continue when free disk < MR_MIN_FREE_GB (default 3).
// Usage: node scripts/download-dukascopy.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--symbols EURUSD,GBPUSD,XAUUSD]
//        node scripts/download-dukascopy.mjs --probe [--symbols ...]       # verify earliest available date with real requests -> meta.json
//        node scripts/download-dukascopy.mjs --gzip-existing               # one-off: .csv -> .csv.gz (row counts verified before delete)
import { mkdir, readFile, writeFile, rename, readdir, unlink, statfs } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// fullHistory: no --from => go back to the earliest available minute candle (dukascopy-node instrument metadata, verified by --probe).
export const SOURCES = {
  USATECHIDXUSD: { id: 'usatechidxusd', appSymbol: 'NQ', label: 'NQ index CFD (Dukascopy NAS100, bid) - not futures' },
  USA500IDXUSD: { id: 'usa500idxusd', appSymbol: 'ES', label: 'ES index CFD (Dukascopy SPX500, bid) - not futures' },
  EURUSD: { id: 'eurusd', appSymbol: 'EURUSD', label: 'EUR/USD spot (Dukascopy, bid)', fullHistory: true },
  GBPUSD: { id: 'gbpusd', appSymbol: 'GBPUSD', label: 'GBP/USD spot (Dukascopy, bid)', fullHistory: true },
  XAUUSD: { id: 'xauusd', appSymbol: 'XAUUSD', label: 'Gold XAU/USD spot (Dukascopy, bid)', fullHistory: true },
}
export const HEADER = 'timestamp,open,high,low,close,volume'
export const MIN_FREE_BYTES_DEFAULT = 3 * 1024 ** 3
const DAY = 86_400_000
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_DATA_DIR = path.resolve(HERE, '../../data')
export const PAUSE_MS = Math.max(1000, Number(process.env.MR_PAUSE_MS ?? 1500) || 1500)   // >=1s between batches
export const BATCH = Math.min(3, Math.max(1, Number(process.env.MR_BATCH ?? 1) || 1))   // parallel requests, never more than 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)

/** Calendar months (UTC) overlapping [from, to); each range is clipped to [from, to). */
export function monthRanges(from, to) {
  if (!(from < to)) throw new Error('--from must be before --to')
  const out = []
  let cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1))
  while (cur < to) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1))
    const key = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`
    out.push({ key, year: cur.getUTCFullYear(), from: cur < from ? from : cur, to: next > to ? to : next, full: cur >= from && next <= to })
    cur = next
  }
  return out
}

/** Newest-first plan over several symbols: year desc, then symbol order, then month desc (recent years of ALL symbols come first). */
export function planJobs(specs, to) {
  const jobs = specs.flatMap((s, order) => monthRanges(s.from, to).map((m) => ({ ...m, symbol: s.symbol, order })))
  return jobs.sort((a, b) => b.year - a.year || a.order - b.order || b.key.localeCompare(a.key))
}

export const rowsToCsv = (rows) => rows.map((r) => `${r.timestamp},${r.open},${r.high},${r.low},${r.close},${r.volume ?? 0}`)

/** Union of CSV body lines (no header) by timestamp; later lines win; ascending. */
export function mergeLines(oldLines, newLines) {
  const m = new Map()
  for (const l of [...oldLines, ...newLines]) {
    const ts = Number(l.slice(0, l.indexOf(',')))
    if (Number.isFinite(ts)) m.set(ts, l)
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])
}

// ---- gzip storage ----
export const csvText = (lines) => `${HEADER}\n${lines.join('\n')}\n`
export const gzipCsv = (text) => gzipSync(Buffer.from(text, 'utf8'), { level: 9 })
export const gunzipCsv = (buf) => gunzipSync(buf).toString('utf8')
export const bodyLines = (text) => text.split('\n').slice(1).filter(Boolean)

// ---- disk guard ----
export const hasEnoughSpace = (freeBytes, minBytes = MIN_FREE_BYTES_DEFAULT) => Number.isFinite(freeBytes) && freeBytes >= minBytes
export class DiskLowError extends Error {}
export async function freeBytesOf(dir) { const s = await statfs(dir); return Number(s.bavail) * Number(s.bsize) }
export async function assertDiskSpace(dir, minBytes, freeFn = freeBytesOf) {
  const free = await freeFn(dir)
  if (!hasEnoughSpace(free, minBytes)) throw new DiskLowError(`free disk ${(free / 1024 ** 3).toFixed(2)} GB < ${(minBytes / 1024 ** 3).toFixed(2)} GB limit`)
  return free
}

// ---- meta bookkeeping (immutable) ----
export const markMonthDone = (meta, key, count, complete) => ({
  ...meta, months: { ...meta.months, [key]: { count, complete } }, failed: (meta.failed ?? []).filter((f) => f.month !== key),
})
export const markMonthFailed = (meta, key, error, at = new Date().toISOString()) => ({
  ...meta, failed: [...(meta.failed ?? []).filter((f) => f.month !== key), { month: key, error: String(error), at }].sort((a, b) => a.month.localeCompare(b.month)),
})
export const failedMonths = (meta) => (meta.failed ?? []).map((f) => f.month)
/** A month is skipped only when fully downloaded; failed months are never "complete", so a re-run retries exactly those (+ unfinished ones). */
export const isMonthDone = (meta, m) => Boolean(meta.months?.[m.key]?.complete) && m.full
export const is429 = (e) => /429|too many/i.test(String(e?.message ?? e))

export function parseArgs(argv, now = new Date()) {
  const flags = new Set(argv.filter((x) => x.startsWith('--')).map((x) => x.slice(2)))
  const a = Object.fromEntries(argv.flatMap((x, i) => (x.startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--') ? [[x.slice(2), argv[i + 1]]] : [])))
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const parse = (s, def, name) => {
    if (!s) return def
    const d = new Date(`${s}T00:00:00Z`)
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid --${name} "${s}" (use YYYY-MM-DD)`)
    return d
  }
  const from = parse(a.from, new Date(today.getTime() - 365 * DAY), 'from')
  const to = parse(a.to, today, 'to')
  const symbols = (a.symbols ?? Object.keys(SOURCES).join(',')).split(',').map((s) => s.trim().toUpperCase())
  for (const s of symbols) if (!SOURCES[s]) throw new Error(`Unknown symbol ${s}. Known: ${Object.keys(SOURCES).join(', ')}`)
  const minFree = Number(process.env.MR_MIN_FREE_GB ?? 3) * 1024 ** 3
  return {
    from, to: to > today ? today : to, symbols, explicitFrom: Boolean(a.from), probe: flags.has('probe'), gzipExisting: flags.has('gzip-existing'),
    dataDir: process.env.MR_DATA_DIR ?? DEFAULT_DATA_DIR, minFreeBytes: Number.isFinite(minFree) ? minFree : MIN_FREE_BYTES_DEFAULT,
  }
}

async function readLines(gzFile) {
  if (existsSync(gzFile)) return bodyLines(gunzipCsv(await readFile(gzFile)))
  const plain = gzFile.replace(/\.gz$/, '')   // legacy un-gzipped file (NQ/ES before --gzip-existing)
  return existsSync(plain) ? bodyLines(await readFile(plain, 'utf8')) : []
}
async function writeAtomic(file, data) { await writeFile(`${file}.tmp`, data); await rename(`${file}.tmp`, file) }

async function readMeta(file, symbol, src) {
  const base = { symbol, appSymbol: src.appSymbol, label: src.label, source: 'Dukascopy public datafeed (dukascopy-node), bid, personal use', resolutionMinutes: 1, months: {}, files: [], failed: [] }
  try { return { ...base, ...JSON.parse(await readFile(file, 'utf8')) } } catch { return base }
}

const fetchOpts = (src, from, to) => ({
  instrument: src.id, dates: { from, to }, timeframe: 'm1', format: 'json', volumes: true, ignoreFlats: true,
  useCache: false,   // cache would be ~30 KB/day/symbol of extra disk; resume is tracked per month in meta.json
  batchSize: BATCH, pauseBetweenBatchesMs: PAUSE_MS, retryCount: 4, pauseBetweenRetriesMs: 4000, retryOnEmpty: false, failAfterRetryCount: true,
})

/** Outer retry on top of dukascopy-node's own (non-429 errors only: 15s/45s). 429 is NOT retried here: it is an IP-wide limit, see waitForRecovery. */
async function downloadMonth(src, m) {
  const { getHistoricalRates } = await import('dukascopy-node')
  for (let attempt = 1; ; attempt++) {
    try { return await getHistoricalRates(fetchOpts(src, m.from, m.to)) } catch (e) {
      if (is429(e) || attempt >= 3) throw e
      const wait = 15_000 * 3 ** (attempt - 1)
      log(`${src.id} ${m.key}: attempt ${attempt} failed (${e.message}); sleeping ${wait / 1000}s`)
      await sleep(wait)
    }
  }
}

export class RateLimitStuckError extends Error {}
/** HTTP 429 from the datafeed is IP-wide (every file answers 429), so failing month after month is pointless: stay quiet, probe ONE file every few minutes, resume when it answers. */
export async function waitForRecovery(probe, sleepFn = sleep, { stepsMs = [180_000, 300_000, 480_000, 600_000], maxMs = 3 * 3600_000, logFn = log } = {}) {
  let waited = 0
  for (let i = 0; waited < maxMs; i++) {
    const step = stepsMs[Math.min(i, stepsMs.length - 1)]
    logFn(`rate limited (429): pausing ${step / 60000} min (waited ${(waited / 60000).toFixed(0)} min so far)`)
    await sleepFn(step); waited += step
    if (await probe()) { logFn('rate limit lifted, resuming'); return waited }
  }
  throw new RateLimitStuckError(`still rate limited after ${(waited / 3600000).toFixed(1)} h`)
}
const PROBE_URL = 'https://datafeed.dukascopy.com/datafeed/EURUSD/2025/00/10/BID_candles_min_1.bi5'
const probeLifted = async () => { try { return (await fetch(PROBE_URL)).status !== 429 } catch { return false } }

async function probeEarliest(symbol, src, dir, metaFile) {
  const { getHistoricalRates, instrumentMetaData } = await import('dukascopy-node')
  const startIso = instrumentMetaData[src.id].startDayForMinuteCandles
  const start = new Date(startIso)
  const get = (from, to) => getHistoricalRates(fetchOpts(src, from, to))
  const first = await get(start, new Date(start.getTime() + 3 * DAY))
  if (!first.length) throw new Error(`${symbol}: no bars in the 3 days after metadata start ${startIso}`)
  // samples strictly before the start must be empty (month before, and a week one and two years before)
  const before = []
  for (const [f, t] of [[-30, 0], [-365, -358], [-730, -723]]) before.push((await get(new Date(start.getTime() + f * DAY), new Date(start.getTime() + t * DAY))).length)
  const meta = await readMeta(metaFile, symbol, src)
  const earliest = { metadataStart: startIso, firstBarTs: first[0].timestamp, firstBar: new Date(first[0].timestamp).toISOString(), barsInFirst3Days: first.length, barsBeforeStart: before, verifiedAt: new Date().toISOString() }
  await mkdir(dir, { recursive: true })
  await writeAtomic(metaFile, JSON.stringify({ ...meta, earliest }, null, 1))
  log(`${symbol}: earliest ${earliest.firstBar} (metadata ${startIso}); bars before start (30d/1y/2y samples): ${before.join('/')}`)
  return earliest
}

/** One-off migration: <SYMBOL>_1m_<YYYY>.csv -> .csv.gz; originals are deleted only after the gz decodes to the identical text. */
export async function gzipExisting(dataDir) {
  for (const d of await readdir(dataDir)) {
    const dir = path.join(dataDir, d), metaFile = path.join(dir, 'meta.json')
    if (!existsSync(metaFile)) continue
    const meta = JSON.parse(await readFile(metaFile, 'utf8'))
    for (const f of (await readdir(dir)).filter((n) => /\.csv$/.test(n))) {
      const plain = path.join(dir, f), gz = `${plain}.gz`
      const text = await readFile(plain, 'utf8'), rows = bodyLines(text).length
      await writeAtomic(gz, gzipCsv(text))
      const back = gunzipCsv(await readFile(gz))
      if (back !== text || bodyLines(back).length !== rows) { await unlink(gz); throw new Error(`${f}: gz verification FAILED, original kept`) }
      meta.files = (meta.files ?? []).map((x) => (x.file === f ? { ...x, file: `${f}.gz`, count: rows } : x))
      await writeAtomic(metaFile, JSON.stringify(meta, null, 1))
      await unlink(plain)
      log(`${d}/${f}: ${rows} rows verified, ${(text.length / 1e6).toFixed(1)} MB -> ${(gzipCsv(text).length / 1e6).toFixed(1)} MB gz, original removed`)
    }
  }
}

async function run() {
  const { from, to, symbols, dataDir, explicitFrom, probe, gzipExisting: doGzip, minFreeBytes } = parseArgs(process.argv.slice(2))
  await mkdir(dataDir, { recursive: true })
  if (doGzip) return gzipExisting(dataDir)
  if (probe) {
    for (const s of symbols) { const dir = path.join(dataDir, s); await probeEarliest(s, SOURCES[s], dir, path.join(dir, 'meta.json')) }
    return
  }
  const { instrumentMetaData } = await import('dukascopy-node')
  const specs = symbols.map((symbol) => {
    const src = SOURCES[symbol]
    if (explicitFrom || !src.fullHistory) return { symbol, from }
    const e = new Date(instrumentMetaData[src.id].startDayForMinuteCandles)
    return { symbol, from: new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), 1)) }   // month start => the first month can be marked complete
  })
  const jobs = planJobs(specs, to)
  const metas = {}
  for (const s of symbols) { await mkdir(path.join(dataDir, s), { recursive: true }); metas[s] = await readMeta(path.join(dataDir, s, 'meta.json'), s, SOURCES[s]) }
  const free0 = await assertDiskSpace(dataDir, minFreeBytes)
  log(`start: ${jobs.length} month-jobs, newest -> oldest, symbols ${symbols.join(',')}, free disk ${(free0 / 1024 ** 3).toFixed(1)} GB (limit ${(minFreeBytes / 1024 ** 3).toFixed(1)} GB)`)
  if (!(await probeLifted())) await waitForRecovery(probeLifted)   // do not start while the IP is still rate limited
  log(`pacing: ${BATCH} parallel, ${PAUSE_MS} ms pause between batches`)
  let doneMonths = 0, bars = 0, days = 0
  const t00 = Date.now()
  for (const job of jobs) {
    const { symbol } = job, src = SOURCES[symbol], dir = path.join(dataDir, symbol), metaFile = path.join(dir, 'meta.json')
    if (isMonthDone(metas[symbol], job)) { doneMonths++; continue }
    try { await assertDiskSpace(dataDir, minFreeBytes) } catch (e) {
      log(`STOP: ${e.message}. Free space and re-run the same command to resume.`)
      process.exit(3)
    }
    const t0 = Date.now()
    try {
      let rows
      for (;;) {
        try { rows = await downloadMonth(src, job); break } catch (e) {
          if (!is429(e)) throw e
          await waitForRecovery(probeLifted)   // then retry the SAME month
        }
      }
      const base = `${symbol}_1m_${job.year}.csv.gz`, file = path.join(dir, base)
      let meta = metas[symbol]
      if (rows.length) {
        const lines = mergeLines(await readLines(file), rowsToCsv(rows))
        await writeAtomic(file, gzipCsv(csvText(lines)))
        const files = meta.files.filter((f) => f.file !== base && f.file !== base.replace(/\.gz$/, ''))
        files.push({ file: base, year: job.year, count: lines.length, from: Number(lines[0].split(',')[0]), to: Number(lines.at(-1).split(',')[0]) })
        meta = { ...meta, files: files.sort((a, b) => a.year - b.year) }
      }
      meta = { ...markMonthDone(meta, job.key, rows.length, job.full && job.to.getTime() <= to.getTime()), updated: new Date().toISOString() }
      metas[symbol] = meta
      await writeAtomic(metaFile, JSON.stringify(meta, null, 1))
      doneMonths++; bars += rows.length; days += (job.to - job.from) / DAY
      const mins = (Date.now() - t00) / 60000
      log(`${symbol} ${job.key}: ${rows.length} bars in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${base} | job ${doneMonths}/${jobs.length} | avg ${(days / mins).toFixed(0)} days/min, ${(bars / mins / 1000).toFixed(0)}k bars/min`)
    } catch (e) {
      if (e instanceof RateLimitStuckError) { log(`STOP: ${e.message}. Re-run the same command later to resume.`); process.exit(4) }
      metas[symbol] = markMonthFailed(metas[symbol], job.key, e.message)
      await writeAtomic(metaFile, JSON.stringify(metas[symbol], null, 1))
      log(`${symbol} ${job.key}: FAILED after retries (${e.message}) - logged, continuing`)
    }
  }
  const failed = symbols.flatMap((s) => failedMonths(metas[s]).map((k) => `${s} ${k}`))
  log(`finished. failed months (${failed.length}): ${failed.join(', ') || 'none'}${failed.length ? ' - re-run the same command to retry only those' : ''}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((e) => { console.error(`FAILED: ${e.message}\nRe-run the same command to resume.`); process.exit(1) })
}
