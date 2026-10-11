import type { Bar } from '../types'
import { parseBarsCsv } from './csv'
import { saveBars } from './store'
import { IMPORT_SUFFIX } from './datasets'

export const MAX_IMPORT_BYTES = 300 * 1024 * 1024
const MS_PER_MIN = 60_000

/** Bar interval in whole minutes from the median gap of the first 2000 bars; throws if not a clean 1+ minute interval. */
export function inferIntervalMinutes(bars: readonly Bar[]): number {
  const gaps: number[] = []
  for (let i = 1; i < Math.min(bars.length, 2000); i++) gaps.push(bars[i]!.t - bars[i - 1]!.t)
  if (gaps.length === 0) throw new Error('Need at least 2 bars to detect the timeframe')
  gaps.sort((a, b) => a - b)
  const m = gaps[gaps.length >> 1]! / MS_PER_MIN
  if (!Number.isInteger(m) || m < 1) throw new Error(`Cannot detect a whole-minute timeframe (median gap ${m.toFixed(2)} min)`)
  return m
}

export interface ImportResult { storeSymbol: string; intervalMinutes: number; bars: number; warnings: string[] }

/** User's own CSV (broker / TradingView export) -> archive under "<SYMBOL>.import". */
export async function importCsvFile(file: File, timezone: string, symbol: string): Promise<ImportResult> {
  if (file.size === 0) throw new Error(`${file.name} is empty`)
  if (file.size > MAX_IMPORT_BYTES) throw new Error(`${file.name} is too large (${(file.size / 1e6).toFixed(0)} MB, max ${MAX_IMPORT_BYTES / 1e6} MB)`)
  const { bars, warnings } = parseBarsCsv(await file.text(), { timezone })
  if (bars.length === 0) throw new Error(`No usable bars in ${file.name}: ${warnings[0] ?? 'unknown format'}`)
  const intervalMinutes = inferIntervalMinutes(bars)
  const storeSymbol = `${symbol}${IMPORT_SUFFIX}`
  await saveBars(storeSymbol, intervalMinutes, bars)
  return { storeSymbol, intervalMinutes, bars: bars.length, warnings }
}
