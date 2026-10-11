import { wallToUtc } from './resample'

const NY = 'America/New_York'
const RTH_OPEN = { h: 9, m: 30 }

/** "YYYY-MM-DD" (from <input type=date>) -> epoch ms of 09:30 New York that day; null if malformed/invalid. */
export function dateInputToTs(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!]
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
  return wallToUtc(y, mo, d, RTH_OPEN.h, RTH_OPEN.m, 0, 0, NY)
}

/** Clamp a target time into [first, last]; `clamped` says which side (or none) was out of range. */
export function clampToRange(ts: number, first: number, last: number): { ts: number; clamped: 'before' | 'after' | null } {
  if (ts < first) return { ts: first, clamped: 'before' }
  if (ts > last) return { ts: last, clamped: 'after' }
  return { ts, clamped: null }
}

/** Index of the last element with t <= ts (-1 if none). Bars sorted ascending. */
export function lastIndexAtOrBefore(bars: readonly { t: number }[], ts: number): number {
  let lo = 0, hi = bars.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid]!.t <= ts) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}
