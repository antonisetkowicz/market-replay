#!/usr/bin/env node
// Polite, resumable HistData.com 1-minute ASCII downloader -> ../data/<SYMBOL>/<SYMBOL>_1m_<YYYY>.csv.gz (same layout as download-dukascopy.mjs).
// Personal use only (HistData: "shared for free", "Use the data at your own will and risk", "we're not selling the data" - see data/HISTDATA_NOTES.md).
// Fills ONLY the history before Dukascopy's earliest bar (Dukascopy wins on overlap). One request at a time, >= 2 s apart, no retry on 403/429.
// Years whose timezone rule is not verified (TZ_RULES) go to data/_quarantine/ and are never served.
// Usage: node scripts/download-histdata.mjs [--rebuild (purge HistData rows, redo all)] [--symbols EURUSD,GBPUSD,...] [--years 2012-2015] [--list] [--force (redo converted years)] [--fetch-only (needs MR_HD_CACHE)]
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { csvText, gzipCsv, gunzipCsv, bodyLines, assertDiskSpace, DiskLowError, DEFAULT_DATA_DIR, MIN_FREE_BYTES_DEFAULT } from './download-dukascopy.mjs'

export const BASE = 'https://www.histdata.com'
export const USER_AGENT = 'market-replay-personal-research/1.0 (private, non-commercial; polite 1 req / 2+ s)'
export const MIN_GAP_MS = Math.max(2000, Number(process.env.MR_HD_GAP_MS ?? 2500) || 2500)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)

/** HistData pair id -> our data folder (same names the app expects; CFD indices map to the Dukascopy index folders). */
export const SOURCES = {
  EURUSD: { folder: 'EURUSD', appSymbol: 'EURUSD', label: 'EUR/USD spot', fx: true },
  GBPUSD: { folder: 'GBPUSD', appSymbol: 'GBPUSD', label: 'GBP/USD spot', fx: true },
  XAUUSD: { folder: 'XAUUSD', appSymbol: 'XAUUSD', label: 'Gold XAU/USD spot', fx: true },
  NSXUSD: { folder: 'USATECHIDXUSD', appSymbol: 'NQ', label: 'NQ index CFD' },
  SPXUSD: { folder: 'USA500IDXUSD', appSymbol: 'ES', label: 'ES index CFD' },
}

// ---- URL / form building (pure) ----
export const pageUrl = (pair, year, month) => `${BASE}/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/${pair.toLowerCase()}/${year}${month ? `/${month}` : ''}`
export const listUrl = (pair) => `${BASE}/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/${pair.toLowerCase()}`
export const formBody = (tk, pair, year, month) => new URLSearchParams({ tk, date: String(year), datemonth: month ? `${year}${String(month).padStart(2, '0')}` : String(year), platform: 'ASCII', timeframe: 'M1', fxpair: pair }).toString()
/** Hidden CSRF-ish token of the download form (null when the page has none, e.g. a year that does not exist). */
export const parseToken = (html) => /name="tk"\s+id="tk"\s+value="([0-9a-f]{16,64})"/.exec(html)?.[1] ?? null
/** Whole-year pages offered for a pair on its listing page (current year is split by month and skipped on purpose: Dukascopy covers it). */
export function parseYears(html, pair) {
  const re = new RegExp(`1-minute-bar-quotes/${pair.toLowerCase()}/(\\d{4})(?![\\d/])`, 'g')
  return [...new Set([...html.matchAll(re)].map((m) => Number(m[1])))].sort((a, b) => a - b)
}

// ---- zip (stored/deflate only; HistData zips are < 4 GB, no zip64) ----
export function zipEntries(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_558); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('not a zip (no end-of-central-directory)')
  const n = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory')
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const dataStart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28)
    const raw = buf.subarray(dataStart, dataStart + csize)
    if (method !== 0 && method !== 8) throw new Error(`unsupported zip method ${method}`)
    out.set(name, () => (method === 8 ? inflateRawSync(raw) : Buffer.from(raw)))
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}
export const csvFromZip = (buf) => {
  const e = [...zipEntries(buf)].find(([n]) => /\.csv$/i.test(n))
  if (!e) throw new Error('zip has no .csv')
  return e[1]().toString('utf8')
}

// ---- timezone ----
// HistData's FAQ says "EST without DST" (UTC-5 all year). Measured against Dukascopy UTC bars + market structure (data/HISTDATA_NOTES.md):
//   fixed5  : UTC = local + 5h
//   nydst   : local is New York wall time incl. US DST (UTC-4 summer / UTC-5 winter)
//   eudst   : UTC-5 base, UTC-4 between the EU DST dates (last Sun Mar .. last Sun Oct), i.e. NOT in step with US DST in March / late Oct
//   unverified : not established with confidence -> data goes to data/_quarantine/
export const TZ_RULES = [
  { from: 2000, to: 2002, rule: 'unverified' },   // weekly open ~19:00 local, Friday last bar 16:28 / 23:59: fits no model -> quarantine
  { from: 2003, to: 2018, rule: 'nydst' },        // weekly open / Friday close / 08:30 ET + 09:30 ET spikes constant in local clock, incl. the US-vs-EU DST mismatch weeks
  { from: 2019, to: 9999, rule: 'eudst' },        // same markers shift 1 h in the mismatch weeks; 2024-2026 proven bar-for-bar against Dukascopy UTC (100.00% equal closes)
]
const nthSunday = (y, m0, n) => { const d = new Date(Date.UTC(y, m0, 1)); return 1 + ((7 - d.getUTCDay()) % 7) + (n - 1) * 7 }
const lastSunday = (y, m0) => { const d = new Date(Date.UTC(y, m0 + 1, 0)); return d.getUTCDate() - d.getUTCDay() }
/** US DST in effect for a NEW YORK WALL-CLOCK time (y, m 1-12, d, h)? 2007+: 2nd Sun Mar 02:00 .. 1st Sun Nov 02:00; 1987-2006: 1st Sun Apr .. last Sun Oct. */
export function usDstActive(y, m, d, h) {
  const t = (mo, day) => Date.UTC(y, mo, day, 2)
  const now = Date.UTC(y, m - 1, d, h)
  if (y >= 2007) return now >= t(2, nthSunday(y, 2, 2)) && now < t(10, nthSunday(y, 10, 1))
  return now >= t(3, nthSunday(y, 3, 1)) && now < t(9, lastSunday(y, 9))
}
/** EU summer time by local date (last Sun Mar .. last Sun Oct; the switch hour is irrelevant: FX/CFD markets are closed at 01:00Z on those Sundays). */
export const euDstActive = (y, m, d) => { const a = Date.UTC(y, m - 1, d); return a >= Date.UTC(y, 2, lastSunday(y, 2)) && a < Date.UTC(y, 9, lastSunday(y, 9)) }
/** Naive HistData wall time -> epoch ms UTC for a rule ('fixed5' | 'nydst' | 'eudst'). */
export function toUtcMs(y, mo, d, h, mi, rule) {
  const off = rule === 'nydst' ? (usDstActive(y, mo, d, h) ? 4 : 5) : rule === 'eudst' ? (euDstActive(y, mo, d) ? 4 : 5) : rule === 'fixed5' ? 5 : NaN
  if (Number.isNaN(off)) throw new Error(`no timezone rule "${rule}"`)
  return Date.UTC(y, mo - 1, d, h + off, mi)
}
export const tzRuleForYear = (year, rules = TZ_RULES) => rules.find((r) => year >= r.from && year <= r.to)?.rule ?? 'unverified'

// ---- CSV parsing (pure) ----
const ROW = /^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2});\s*([\d.]+)\s*;\s*([\d.]+)\s*;\s*([\d.]+)\s*;\s*([\d.]+)\s*;\s*(\d+)\s*$/   // 2004 files pad prices with spaces
/** One 'YYYYMMDD HHMMSS;O;H;L;C;V' line -> {local:[y,mo,d,h,mi], o,h,l,c} or null (malformed lines are skipped by the caller and counted). */
export function parseRow(line) {
  const m = ROW.exec(line)
  if (!m) return null
  return { local: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])], o: Number(m[7]), h: Number(m[8]), l: Number(m[9]), c: Number(m[10]) }
}
/** HistData csv text -> { lines: 'ts,o,h,l,c,0'[] (ascending, deduped), bad } for one timezone rule. */
export function convertCsv(text, rule) {
  const m = new Map()
  let bad = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const r = parseRow(line)
    if (!r || !(r.h >= r.l) || !(r.h >= Math.max(r.o, r.c)) || !(r.l <= Math.min(r.o, r.c))) { bad++; continue }
    const ts = toUtcMs(...r.local, rule)
    m.set(ts, `${ts},${r.o},${r.h},${r.l},${r.c},0`)
  }
  return { lines: [...m.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]), bad }
}

// ---- merge rules (pure) ----
export const tsOf = (line) => Number(line.slice(0, line.indexOf(',')))
export const utcYear = (ts) => new Date(ts).getUTCFullYear()
/** Rows grouped by UTC year (HistData's EST year file spills its last 5 h into the next UTC year). */
export function bucketByUtcYear(lines) {
  const out = new Map()
  for (const l of lines) { const y = utcYear(tsOf(l)); if (!out.has(y)) out.set(y, []); out.get(y).push(l) }
  return out
}
/** Existing rows always win (Dukascopy, or an earlier identical HistData run); incoming rows are added only strictly before `boundaryTs` (Dukascopy's first bar). */
export function fillBefore(existing, incoming, boundaryTs = Infinity) {
  const m = new Map()
  for (const l of incoming) { const t = tsOf(l); if (t < boundaryTs) m.set(t, l) }
  for (const l of existing) m.set(tsOf(l), l)
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])
}
/** Fully-covered-by-history years to fetch: skip years already converted (meta.histdata.years[y].done). */
export const planYears = (available, meta, only, force = false) => available.filter((y) => (!only || (y >= only[0] && y <= only[1])) && (force || !meta.histdata?.years?.[y]?.done))
/** [{from,to,provider}] boundary description: HistData up to (excl.) Dukascopy's first bar, Dukascopy afterwards. */
export const buildSources = (histFromTs, boundaryTs, toTs) => [
  ...(boundaryTs && histFromTs < boundaryTs ? [{ from: new Date(histFromTs).toISOString(), to: new Date(boundaryTs - 60_000).toISOString(), provider: 'histdata' }] : []),
  { from: new Date(boundaryTs).toISOString(), to: new Date(toTs).toISOString(), provider: 'dukascopy' },
]

export const TERMS_NOTE = 'HistData.com F.A.Q.: "Here, you\'ll be able to find historical data ready to be imported into your favorite application"; "Like you, tons of traders and developers are looking for data to backtest their trading systems. We are developers and traders too and, since we need also this information, why not sharing it with you?"; "Since it\'s free data, you\'ll not get from us any kind of warranty or certification. Use the data at your own will and risk."; Download-by-FTP page: "we\'re not selling the data!!!". No separate terms-of-service page exists (/terms-of-service/ is 404). Used here for free personal use only, never redistributed, one polite request at a time.'

/** meta after a HistData run: 'sources' boundary array, 'earliest' of the served files (the old Dukascopy probe is kept as dukascopyEarliest), notes. Pure. */
export function finalizeMeta(meta, now = new Date()) {
  if (!meta.files.length) return meta
  const from = Math.min(...meta.files.map((f) => f.from)), to = Math.max(...meta.files.map((f) => f.to))
  const boundaryTs = meta.histdata?.boundaryTs ?? null
  const hasHist = boundaryTs != null && from < boundaryTs
  const dukascopyEarliest = meta.dukascopyEarliest ?? (meta.earliest && !meta.earliest.provider ? meta.earliest : undefined)
  const quarantined = Object.entries(meta.histdata?.years ?? {}).filter(([, y]) => y.tz_unverified).map(([y]) => Number(y))
  return {
    ...meta,
    ...(dukascopyEarliest ? { dukascopyEarliest } : {}),
    earliest: { firstBarTs: from, firstBar: new Date(from).toISOString(), provider: hasHist ? 'histdata' : 'dukascopy', verifiedAt: now.toISOString() },
    sources: hasHist ? buildSources(from, boundaryTs, to) : [{ from: new Date(from).toISOString(), to: new Date(to).toISOString(), provider: 'dukascopy' }],
    source: hasHist ? `${String(meta.source ?? '').split(';')[0]}; before ${new Date(boundaryTs).toISOString().slice(0, 10)}: HistData.com M1 bid (free, personal use)` : meta.source,
    histdata: { ...meta.histdata, notes: TERMS_NOTE, tz_rules: TZ_RULES, tz_unverified_years: quarantined, tz_note: 'see data/HISTDATA_NOTES.md' },
  }
}

// ---- sanity (pure) ----
/** Spot FX / gold are closed Saturday, Friday >= 22:30Z and Sunday < 20:00Z (open is 21:00Z/22:00Z); HistData has stray quotes there in early 2004/2005. */
export function isClosedFx(ts) {
  const d = new Date(ts), dow = d.getUTCDay(), hm = d.getUTCHours() + d.getUTCMinutes() / 60
  return dow === 6 || (dow === 5 && hm >= 22.5) || (dow === 0 && hm < 20)
}
/** Quality report for ascending 'ts,o,h,l,c,v' lines. weekend = bars in closed FX hours, gaps2h = mid-week holes >= 2 h, jumps = bar-to-bar close moves > maxJump. */
export function sanity(lines, maxJump = 0.05) {
  let unsorted = 0, dups = 0, badOhlc = 0, weekend = 0, gaps2h = 0
  const jumps = []
  let prevTs = -Infinity, prevC = NaN
  for (const l of lines) {
    const [t, o, h, lo, c] = l.split(',').map(Number)
    if (t < prevTs) unsorted++; else if (t === prevTs) dups++
    if (!(h >= lo && h >= o && h >= c && lo <= o && lo <= c) || !(lo > 0)) badOhlc++
    const dow = new Date(prevTs).getUTCDay()
    if (isClosedFx(t)) weekend++
    if (t - prevTs >= 2 * 3600_000 && dow >= 1 && dow <= 4) gaps2h++   // hole of >= 2 h starting Mon-Thu (indices' daily break is 1 h)
    if (prevC > 0 && Math.abs(c / prevC - 1) > maxJump) jumps.push({ at: new Date(t).toISOString(), from: prevC, to: c })
    prevTs = t; prevC = c
  }
  return { count: lines.length, from: lines.length ? tsOf(lines[0]) : null, to: lines.length ? tsOf(lines.at(-1)) : null, unsorted, dups, badOhlc, weekend, gaps2h, jumps }
}

// ---- polite http ----
export class BlockedError extends Error {}
let lastReq = 0
async function polite(url, opts = {}) {
  const wait = lastReq + MIN_GAP_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastReq = Date.now()
  return fetch(url, { ...opts, headers: { 'User-Agent': USER_AGENT, ...opts.headers }, signal: AbortSignal.timeout(180_000) })
}
/** Retries transient failures (network / 5xx) with 15 s / 45 s / 135 s backoff; 403 / 429 = blocked -> stop at once, never hammer. */
export async function withRetry(fn, sleepFn = sleep, delays = [15_000, 45_000, 135_000]) {
  for (let i = 0; ; i++) {
    try { return await fn() } catch (e) {
      if (e instanceof BlockedError || i >= delays.length) throw e
      log(`transient failure (${e.message}); retry in ${delays[i] / 1000}s`)
      await sleepFn(delays[i])
    }
  }
}
const check = (res, what) => {
  if (res.status === 403 || res.status === 429) throw new BlockedError(`${what}: HTTP ${res.status} (blocked / rate limited) - stop, do not retry`)
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`)
}
export const fetchYears = (pair) => withRetry(async () => { const r = await polite(listUrl(pair)); check(r, `list ${pair}`); return parseYears(await r.text(), pair) })
export async function fetchZip(pair, year, month) {
  return withRetry(async () => {
    const page = pageUrl(pair, year, month)
    const pr = await polite(page); check(pr, `page ${pair} ${year}`)
    const tk = parseToken(await pr.text())
    if (!tk) throw new Error(`no download token on ${page}`)
    const r = await polite(`${BASE}/get.php`, { method: 'POST', headers: { Referer: page, 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody(tk, pair, year, month) })
    check(r, `get.php ${pair} ${year}`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error(`get.php ${pair} ${year}: response is not a zip (${buf.length} bytes)`)
    return buf
  })
}

// ---- zip cache (optional: MR_HD_CACHE=<dir>; lets the timezone analysis and the conversion share one download, delete the dir afterwards) ----
export async function getZip(pair, year, cacheDir = process.env.MR_HD_CACHE) {
  const f = cacheDir ? path.join(cacheDir, `${pair}_${year}.zip`) : null
  if (f && existsSync(f)) return readFile(f)
  const buf = await fetchZip(pair, year)
  if (f) { await mkdir(cacheDir, { recursive: true }); await writeAtomic(f, buf) }
  return buf
}

// ---- storage ----
async function writeAtomic(file, data) { await writeFile(`${file}.tmp`, data); await rename(`${file}.tmp`, file) }
async function readLines(file) { return existsSync(file) ? bodyLines(gunzipCsv(await readFile(file))) : [] }
async function readMeta(file, folder, src) {
  const base = { symbol: folder, appSymbol: src.appSymbol, label: src.label, resolutionMinutes: 1, months: {}, files: [], failed: [] }
  try { return { ...base, ...JSON.parse(await readFile(file, 'utf8')) } } catch { return base }
}
const fileEntry = (base, year, lines) => ({ file: base, year, count: lines.length, from: tsOf(lines[0]), to: tsOf(lines.at(-1)) })

/** Writes one converted HistData year (all UTC-year buckets) into <dir> (served) or <quarantine>; returns updated meta (immutable). */
export async function storeYear({ meta, folder, dataDir, histYear, lines, boundaryTs, quarantine }) {
  const dir = quarantine ? path.join(dataDir, '_quarantine', folder) : path.join(dataDir, folder)
  await mkdir(dir, { recursive: true })
  let files = meta.files
  for (const [y, rows] of bucketByUtcYear(lines)) {
    const base = `${folder}_1m_${y}.csv.gz`, file = path.join(dir, base)
    const merged = fillBefore(await readLines(file), rows, quarantine ? Infinity : boundaryTs)
    if (!merged.length) continue
    await writeAtomic(file, gzipCsv(csvText(merged)))
    if (!quarantine) files = [...files.filter((f) => f.file !== base), fileEntry(base, y, merged)].sort((a, b) => a.year - b.year)
  }
  return { ...meta, files }
}

/** --rebuild: drop everything HistData-owned (rows before the Dukascopy boundary) from the served files; Dukascopy rows (>= boundary) stay untouched. */
export async function purgeHistdata(meta, folder, dataDir, boundaryTs) {
  if (boundaryTs == null) return meta
  const dir = path.join(dataDir, folder)
  let files = []
  for (const f of meta.files) {
    const file = path.join(dir, f.file), kept = (await readLines(file)).filter((l) => tsOf(l) >= boundaryTs)
    if (!kept.length) { await rm(file, { force: true }); continue }
    await writeAtomic(file, gzipCsv(csvText(kept)))
    files = [...files, fileEntry(f.file, f.year, kept)]
  }
  const { years: _years, ...histdata } = meta.histdata ?? {}
  return { ...meta, files, histdata }
}

function parseArgs(argv) {
  const a = Object.fromEntries(argv.flatMap((x, i) => (x.startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--') ? [[x.slice(2), argv[i + 1]]] : [])))
  const symbols = (a.symbols ?? Object.keys(SOURCES).join(',')).split(',').map((s) => s.trim().toUpperCase())
  for (const s of symbols) if (!SOURCES[s]) throw new Error(`Unknown symbol ${s}. Known: ${Object.keys(SOURCES).join(', ')}`)
  const only = a.years ? a.years.split('-').map(Number).slice(0, 2) : null
  if (only && only.length === 1) only.push(only[0])
  const minFree = Number(process.env.MR_MIN_FREE_GB ?? 3) * 1024 ** 3
  return { symbols, only, list: argv.includes('--list'), fetchOnly: argv.includes('--fetch-only'), force: argv.includes('--force'), rebuild: argv.includes('--rebuild'), dataDir: process.env.MR_DATA_DIR ?? DEFAULT_DATA_DIR, minFreeBytes: Number.isFinite(minFree) ? minFree : MIN_FREE_BYTES_DEFAULT }
}

async function run() {
  const { symbols, only, list, fetchOnly, force, rebuild, dataDir, minFreeBytes } = parseArgs(process.argv.slice(2))
  await assertDiskSpace(dataDir, minFreeBytes)
  for (const pair of symbols) {
    const src = SOURCES[pair], metaFile = path.join(dataDir, src.folder, 'meta.json')
    await mkdir(path.join(dataDir, src.folder), { recursive: true })
    let meta = await readMeta(metaFile, src.folder, src)
    // Dukascopy's first bar = merge boundary; remembered so a re-run does not mistake HistData rows for Dukascopy.
    const dukaFrom = meta.histdata?.boundaryTs ?? (meta.files.length ? Math.min(...meta.files.map((f) => f.from)) : null)
    const available = meta.histdata?.available ?? await fetchYears(pair)
    meta = { ...meta, histdata: { ...meta.histdata, available, boundaryTs: dukaFrom, pair } }
    await writeAtomic(metaFile, JSON.stringify(meta, null, 1))
    log(`${pair} -> ${src.folder}: HistData years ${available[0]}..${available.at(-1)} (${available.length}); Dukascopy boundary ${dukaFrom ? new Date(dukaFrom).toISOString() : 'none'}`)
    if (list) continue
    const boundaryTs = dukaFrom ?? Infinity
    if (rebuild) { meta = await purgeHistdata(meta, src.folder, dataDir, dukaFrom); await writeAtomic(metaFile, JSON.stringify(meta, null, 1)); log(`${pair}: rebuild - HistData rows purged, ${meta.files.length} Dukascopy file(s) kept`) }
    for (const year of planYears(available, meta, only, force)) {
      if (dukaFrom && Date.UTC(year, 0, 1) - 5 * 3600_000 >= dukaFrom) { log(`${pair} ${year}: fully inside Dukascopy coverage, skipped`); continue }
      try { await assertDiskSpace(dataDir, minFreeBytes) } catch (e) { if (e instanceof DiskLowError) { log(`STOP: ${e.message}. Free space and re-run the same command.`); process.exit(3) } throw e }
      const t0 = Date.now()
      if (fetchOnly) {   // cache zips only (needs MR_HD_CACHE); nothing is converted or written to the data folders
        if (!process.env.MR_HD_CACHE) throw new Error('--fetch-only needs MR_HD_CACHE=<dir>')
        try { await getZip(pair, year); log(`${pair} ${year}: cached`) } catch (e) { if (e instanceof BlockedError) { log(`STOP: ${e.message}`); process.exit(4) } log(`${pair} ${year}: FAILED (${e.message})`) }
        continue
      }
      try {
        const rule = tzRuleForYear(year), unverified = rule === 'unverified'
        const conv = convertCsv(csvFromZip(await getZip(pair, year)), unverified ? 'fixed5' : rule)
        const lines = src.fx ? conv.lines.filter((l) => !isClosedFx(tsOf(l))) : conv.lines, bad = conv.bad, closedDropped = conv.lines.length - lines.length
        const sn = sanity(lines)
        meta = await storeYear({ meta, folder: src.folder, dataDir, histYear: year, lines, boundaryTs, quarantine: unverified })
        const entry = { done: true, rows: lines.length, bad, tz: rule, ...(unverified ? { tz_unverified: true } : {}), closedDropped, gaps2h: sn.gaps2h, jumps: sn.jumps.length, dups: sn.dups, badOhlc: sn.badOhlc, at: new Date().toISOString() }
        meta = { ...meta, failed: meta.failed.filter((f) => f.month !== String(year)), histdata: { ...meta.histdata, years: { ...meta.histdata.years, [year]: entry } }, updated: new Date().toISOString() }
        await writeAtomic(metaFile, JSON.stringify(meta, null, 1))
        log(`${pair} ${year}: ${lines.length} bars (bad ${bad}, closed-hours dropped ${closedDropped}, holes>=2h ${sn.gaps2h}, jumps>5% ${sn.jumps.length}) tz=${rule}${unverified ? ' QUARANTINED' : ''} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
        for (const j of sn.jumps) log(`  jump ${j.at} ${j.from} -> ${j.to}`)
      } catch (e) {
        if (e instanceof BlockedError) { log(`STOP: ${e.message}`); process.exit(4) }
        meta = { ...meta, failed: [...meta.failed.filter((f) => f.month !== String(year)), { month: String(year), error: String(e.message), at: new Date().toISOString() }] }
        await writeAtomic(metaFile, JSON.stringify(meta, null, 1))
        log(`${pair} ${year}: FAILED (${e.message}) - logged, continuing`)
      }
    }
    if (!fetchOnly) { meta = finalizeMeta(meta); await writeAtomic(metaFile, JSON.stringify(meta, null, 1)) }
  }
  log('finished. Re-run the same command to retry failed years.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((e) => { console.error(`FAILED: ${e.message}\nRe-run the same command to resume.`); process.exit(1) })
}
