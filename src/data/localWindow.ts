import type { Bar, Minutes } from '../types'
import { parseBarsCsv } from './csv'
import type { LocalFile, LocalSeries } from './localData'
import { getFingerprints, loadBarsRange, saveBars, setFingerprints } from './store'
import { monthEnd, monthKey, monthsBetween, monthStart, type MonthWindow } from './window'

/** Full month range available in a local series (from the index, i.e. meta.json) — the "overview". */
export const seriesBounds = (s: Pick<LocalSeries, 'from' | 'to'>): MonthWindow => ({ from: monthKey(s.from), to: monthKey(s.to) })

const fileFp = (f: LocalFile): string => `${f.file}|${f.count}|${f.to}`
const covers = (f: LocalFile, month: string): boolean => f.from < monthEnd(month) && f.to >= monthStart(month)

export interface FilePlan { file: LocalFile; months: string[] }
export interface ImportPlan { files: FilePlan[]; /** fingerprint to record per month once imported (every requested month a file covers) */ fp: Record<string, string> }

/** Pure: which source files must be (re)read for `months`, given the fingerprints recorded at the last import. */
export function planImport(s: Pick<LocalSeries, 'files'>, months: readonly string[], known: Readonly<Record<string, string>>): ImportPlan {
  const byFile = new Map<LocalFile, string[]>()
  const fp: Record<string, string> = {}
  for (const m of months) {
    const fs = s.files.filter((f) => covers(f, m))
    if (!fs.length) continue
    const want = fs.map(fileFp).join(';')
    if (known[m] === want) continue
    fp[m] = want
    for (const f of fs) byFile.set(f, [...(byFile.get(f) ?? []), m])
  }
  return { files: [...byFile].map(([file, ms]) => ({ file, months: ms })), fp }
}

/** Response body -> text; gzip is detected by magic bytes so both .csv.gz as-is and Content-Encoding-decoded bodies work. */
export async function readCsvText(res: Response): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return new TextDecoder().decode(buf)
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
}

/** Pure: parse a (year) CSV keeping only bars inside the given months. Cheap pre-filter on the epoch-ms timestamp column. */
export function barsInMonths(text: string, months: readonly string[]): Bar[] {
  const ranges = months.map((m) => [monthStart(m), monthEnd(m)] as const)
  const inRange = (t: number) => ranges.some(([a, b]) => t >= a && t < b)
  const lines = text.split('\n')
  const body = lines.slice(1)
  const probe = Number(body[0]?.slice(0, body[0].indexOf(',')))
  const kept = probe >= 1e12 ? body.filter((l) => inRange(Number(l.slice(0, l.indexOf(','))))) : body
  const { bars } = parseBarsCsv([lines[0], ...kept].join('\n'))
  return bars.filter((b) => inRange(b.t))
}

type Fetch = typeof fetch
const url = (s: LocalSeries, f: LocalFile) => `/local/${encodeURIComponent(s.symbol)}/${encodeURIComponent(f.file)}`

/** Imports the missing/stale months into the IndexedDB chunk store (one source file at a time). Returns imported bar count. */
export async function ensureMonths(
  s: LocalSeries, storeSymbol: string, months: readonly string[], onProgress: (msg: string) => void = () => {}, fetchFn: Fetch = fetch,
): Promise<number> {
  const min: Minutes = s.resolutionMinutes
  const plan = planImport(s, months, await getFingerprints(storeSymbol, min, months))
  let n = 0
  for (const [i, { file, months: ms }] of plan.files.entries()) {
    onProgress(`reading ${file.file} (${i + 1}/${plan.files.length}) for ${ms[0]}${ms.length > 1 ? ` … ${ms[ms.length - 1]}` : ''}…`)
    const res = await fetchFn(url(s, file))
    if (!res.ok) throw new Error(`Could not read ${file.file}: HTTP ${res.status}`)
    const bars = barsInMonths(await readCsvText(res), ms)
    await saveBars(storeSymbol, min, bars)
    n += bars.length
  }
  await setFingerprints(storeSymbol, min, Object.keys(plan.fp), (m) => plan.fp[m]!)
  return n
}

/** Bars of the window (months from..to inclusive), importing from the local files first when not cached. */
export async function loadWindowBars(
  s: LocalSeries, storeSymbol: string, w: MonthWindow, onProgress?: (msg: string) => void, fetchFn?: Fetch,
): Promise<Bar[]> {
  const months = monthsBetween(w.from, w.to)
  await ensureMonths(s, storeSymbol, months, onProgress, fetchFn)
  return loadBarsRange(storeSymbol, s.resolutionMinutes, w.from, w.to)
}
