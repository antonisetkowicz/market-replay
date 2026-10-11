import type { Bar } from '../types'
import { parseBarsCsv } from './csv'
import { listSeries, saveBars } from './store'

export interface LocalFile { file: string; from: number; to: number; count: number }
export interface LocalSeries {
  symbol: string; appSymbol: string; label: string; source: string
  resolutionMinutes: number; from: number; to: number; count: number; files: LocalFile[]
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const SAFE = /^[A-Za-z0-9_-]+$/
const SAFE_FILE = /^[A-Za-z0-9_.-]+\.csv(\.gz)?$/

/** Validates /local/index.json (external input): malformed entries are dropped, not trusted. */
export function parseLocalIndex(json: unknown): LocalSeries[] {
  if (!Array.isArray(json)) throw new Error('local index is not an array')
  const out: LocalSeries[] = []
  for (const e of json as Record<string, unknown>[]) {
    const files = Array.isArray(e?.files) ? (e.files as Record<string, unknown>[]) : []
    const okFiles = files.filter((f) => typeof f.file === 'string' && SAFE_FILE.test(f.file) && isNum(f.from) && isNum(f.to) && isNum(f.count)) as unknown as LocalFile[]
    if (typeof e?.symbol !== 'string' || !SAFE.test(e.symbol) || typeof e.appSymbol !== 'string' || !isNum(e.resolutionMinutes) || e.resolutionMinutes < 1
      || !isNum(e.from) || !isNum(e.to) || okFiles.length === 0) continue
    out.push({
      symbol: e.symbol, appSymbol: e.appSymbol, label: String(e.label ?? e.symbol), source: String(e.source ?? ''),
      resolutionMinutes: e.resolutionMinutes, from: e.from, to: e.to, count: isNum(e.count) ? e.count : 0, files: okFiles,
    })
  }
  return out
}

/** Available local series, or [] when the dev server has no data dir (never throws: local data is optional). */
export async function fetchLocalIndex(fetchFn: typeof fetch = fetch): Promise<LocalSeries[]> {
  try {
    const res = await fetchFn('/local/index.json')
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return []
    return parseLocalIndex(await res.json())
  } catch { return [] }
}

/** Pure: which files the archive (covering [from,to]) is still missing. */
export function filesToLoad(s: LocalSeries, archive: { from: number; to: number } | null): LocalFile[] {
  return archive ? s.files.filter((f) => f.to > archive.to || f.from < archive.from) : s.files
}

export interface LocalLoadResult { loaded: number; warnings: number }

/** Parses the missing CSV files into the IndexedDB archive (one file at a time, UI can show progress). */
export async function ensureLocalLoaded(
  s: LocalSeries, onProgress: (msg: string) => void, fetchFn: typeof fetch = fetch,
): Promise<LocalLoadResult> {
  const info = (await listSeries()).find((a) => a.symbol === s.symbol && a.intervalMinutes === s.resolutionMinutes) ?? null
  const todo = filesToLoad(s, info)
  let loaded = 0, warnings = 0
  for (const [i, f] of todo.entries()) {
    onProgress(`importing ${f.file} (${i + 1}/${todo.length})…`)
    const res = await fetchFn(`/local/${encodeURIComponent(s.symbol)}/${encodeURIComponent(f.file)}`)
    if (!res.ok) throw new Error(`Could not read ${f.file}: HTTP ${res.status}`)
    const parsed = parseBarsCsv(await res.text())
    if (parsed.bars.length === 0) throw new Error(`${f.file}: no valid bars (${parsed.warnings[0] ?? 'empty'})`)
    await saveBars(s.symbol, s.resolutionMinutes, parsed.bars as Bar[])
    loaded += parsed.bars.length; warnings += parsed.warnings.length
  }
  return { loaded, warnings }
}
