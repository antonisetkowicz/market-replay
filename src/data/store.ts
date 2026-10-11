import type { Bar, Minutes } from '../types'

const DB_NAME = 'market-replay'
const CHUNKS = 'chunks'   // one record per series+UTC month, columnar Float64Array (fast structured clone, ~6x smaller than Bar[])
const META = 'meta'       // one small record per series (count/from/to) so listing never reads bars
const FP = 'fingerprints' // per series+month: fingerprint of the source file the chunk was imported from (cache validity)
const LEGACY = 'series'   // v1: one record per series holding a Bar[]; migrated lazily on first load
const DB_VERSION = 3
const FIELDS = 6

export interface SeriesInfo { symbol: string; intervalMinutes: Minutes; count: number; from: number; to: number }
interface MetaRecord extends SeriesInfo { key: string }
interface ChunkRecord { key: string; n: number; data: Float64Array }

const seriesKey = (symbol: string, m: Minutes) => `${symbol}|${m}`
const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7)

/** Pure: union by timestamp, b overwrites a on equal t; result sorted ascending, unique. */
export function mergeBars(a: readonly Bar[], b: readonly Bar[]): Bar[] {
  const map = new Map<number, Bar>()
  for (const x of a) map.set(x.t, x)
  for (const x of b) map.set(x.t, x)
  return [...map.values()].sort((p, q) => p.t - q.t)
}

export function encodeBars(bars: readonly Bar[]): Float64Array {
  const out = new Float64Array(bars.length * FIELDS)
  bars.forEach((b, i) => out.set([b.t, b.o, b.h, b.l, b.c, b.v], i * FIELDS))
  return out
}

export function decodeBars(d: Float64Array): Bar[] {
  const out: Bar[] = new Array(d.length / FIELDS)
  for (let i = 0; i < out.length; i++) {
    const k = i * FIELDS
    out[i] = { t: d[k]!, o: d[k + 1]!, h: d[k + 2]!, l: d[k + 3]!, c: d[k + 4]!, v: d[k + 5]! }
  }
  return out
}

/** Pure: group bars by UTC month ("YYYY-MM"). */
export function groupByMonth(bars: readonly Bar[]): Map<string, Bar[]> {
  const g = new Map<string, Bar[]>()
  for (const b of bars) {
    const k = monthOf(b.t)
    const arr = g.get(k)
    if (arr) arr.push(b); else g.set(k, [b])
  }
  return g
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      for (const s of [CHUNKS, META, FP]) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(new Error(`IndexedDB open failed: ${req.error?.message ?? 'unknown'}`))
  })
}

const wrap = <T>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })

/** Runs fn inside ONE transaction; fn may await IDB requests (wrap) but nothing else async. */
async function withTx<T>(mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openDb()
  try {
    const names = [CHUNKS, META, FP, ...(db.objectStoreNames.contains(LEGACY) ? [LEGACY] : [])]
    const t = db.transaction(names, mode)
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve()
      t.onerror = t.onabort = () => reject(new Error(`IndexedDB transaction failed: ${t.error?.message ?? 'unknown'}`))
    })
    done.catch(() => {}) // avoid unhandled rejection if fn throws first
    const result = await fn(t)
    await done
    return result
  } finally {
    db.close()
  }
}

const range = (sk: string) => IDBKeyRange.bound(`${sk}|`, `${sk}|￿`)

async function putMerged(t: IDBTransaction, symbol: string, m: Minutes, bars: readonly Bar[]): Promise<void> {
  const sk = seriesKey(symbol, m)
  const chunks = t.objectStore(CHUNKS)
  const old = await wrap<MetaRecord | undefined>(t.objectStore(META).get(sk))
  let count = old?.count ?? 0, from = old?.from ?? Infinity, to = old?.to ?? -Infinity
  for (const [month, group] of groupByMonth(bars)) {
    const key = `${sk}|${month}`
    const prev = await wrap<ChunkRecord | undefined>(chunks.get(key))
    const merged = mergeBars(prev ? decodeBars(prev.data) : [], group)
    await wrap(chunks.put({ key, n: merged.length, data: encodeBars(merged) } satisfies ChunkRecord))
    count += merged.length - (prev?.n ?? 0)
    from = Math.min(from, merged[0]!.t); to = Math.max(to, merged[merged.length - 1]!.t)
  }
  if (count > 0) await wrap(t.objectStore(META).put({ key: sk, symbol, intervalMinutes: m, count, from, to } satisfies MetaRecord))
}

async function migrateLegacy(symbol: string, m: Minutes): Promise<void> {
  await withTx('readwrite', async (t) => {
    if (!t.objectStoreNames.contains(LEGACY)) return
    const rec = await wrap<{ bars: Bar[] } | undefined>(t.objectStore(LEGACY).get(seriesKey(symbol, m)))
    if (!rec) return
    await putMerged(t, symbol, m, rec.bars)
    await wrap(t.objectStore(LEGACY).delete(seriesKey(symbol, m)))
  })
}

export async function loadBars(symbol: string, intervalMinutes: Minutes): Promise<Bar[]> {
  await migrateLegacy(symbol, intervalMinutes)
  const recs = await withTx('readonly', (t) => wrap<ChunkRecord[]>(t.objectStore(CHUNKS).getAll(range(seriesKey(symbol, intervalMinutes)))))
  return recs.sort((a, b) => (a.key < b.key ? -1 : 1)).flatMap((r) => decodeBars(r.data))
}

/** Only the UTC months fromMonth..toMonth ("YYYY-MM", inclusive) of a series, ascending — the windowed alternative to loadBars. */
export async function loadBarsRange(symbol: string, intervalMinutes: Minutes, fromMonth: string, toMonth: string): Promise<Bar[]> {
  await migrateLegacy(symbol, intervalMinutes)
  const sk = seriesKey(symbol, intervalMinutes)
  const recs = await withTx('readonly', (t) => wrap<ChunkRecord[]>(t.objectStore(CHUNKS).getAll(IDBKeyRange.bound(`${sk}|${fromMonth}`, `${sk}|${toMonth}`))))
  return recs.sort((a, b) => (a.key < b.key ? -1 : 1)).flatMap((r) => decodeBars(r.data))
}

/** Source-file fingerprints recorded for the given months (missing = never imported / unknown). */
export async function getFingerprints(symbol: string, intervalMinutes: Minutes, months: readonly string[]): Promise<Record<string, string>> {
  const sk = seriesKey(symbol, intervalMinutes)
  return withTx('readonly', async (t) => {
    const out: Record<string, string> = {}
    for (const m of months) {
      const r = await wrap<{ fp: string } | undefined>(t.objectStore(FP).get(`${sk}|${m}`))
      if (r) out[m] = r.fp
    }
    return out
  })
}

export async function setFingerprints(symbol: string, intervalMinutes: Minutes, months: readonly string[], fp: (month: string) => string): Promise<void> {
  const sk = seriesKey(symbol, intervalMinutes)
  await withTx('readwrite', async (t) => { for (const m of months) await wrap(t.objectStore(FP).put({ key: `${sk}|${m}`, fp: fp(m) })) })
}

/** Merges into the archive (touches only the months present in `bars`). */
export async function saveBars(symbol: string, intervalMinutes: Minutes, bars: readonly Bar[]): Promise<void> {
  if (bars.length === 0) return
  await migrateLegacy(symbol, intervalMinutes)
  await withTx('readwrite', (t) => putMerged(t, symbol, intervalMinutes, bars))
}

export async function listSeries(): Promise<SeriesInfo[]> {
  const recs = await withTx('readonly', (t) => wrap<MetaRecord[]>(t.objectStore(META).getAll()))
  return recs
    .map(({ symbol, intervalMinutes, count, from, to }) => ({ symbol, intervalMinutes, count, from, to }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.intervalMinutes - b.intervalMinutes)
}

export async function clearSeries(symbol: string, intervalMinutes: Minutes): Promise<void> {
  const sk = seriesKey(symbol, intervalMinutes)
  await withTx('readwrite', async (t) => {
    await wrap(t.objectStore(CHUNKS).delete(range(sk)))
    await wrap(t.objectStore(META).delete(sk))
    await wrap(t.objectStore(FP).delete(range(sk)))
    if (t.objectStoreNames.contains(LEGACY)) await wrap(t.objectStore(LEGACY).delete(sk))
  })
}
