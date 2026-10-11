// Pure planning of the in-memory data window: a contiguous range of UTC months ("YYYY-MM", inclusive) of a local series.
export interface MonthWindow { from: string; to: string }

export const DEFAULT_MONTHS = 6          // default window: last 6 months
export const GOTO_BEFORE = 3, GOTO_AFTER = 6   // go-to-date window: 3 months before, 6 after the target month
export const APPEND_AHEAD_MS = 14 * 86_400_000 // during replay, load the next month when < 2 weeks of loaded data remain

const RE = /^(\d{4})-(\d{2})$/
const idx = (k: string): number => { const m = RE.exec(k); if (!m) throw new Error(`bad month key ${k}`); return +m[1]! * 12 + (+m[2]! - 1) }
const key = (i: number): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`

export const monthKey = (t: number): string => new Date(t).toISOString().slice(0, 7)
export const monthStart = (k: string): number => Date.UTC(Math.floor(idx(k) / 12), idx(k) % 12, 1)
/** Exclusive end (= start of the next month). */
export const monthEnd = (k: string): number => monthStart(addMonths(k, 1))
export const addMonths = (k: string, n: number): string => key(idx(k) + n)
export const monthsBetween = (from: string, to: string): string[] => Array.from({ length: Math.max(0, idx(to) - idx(from) + 1) }, (_, i) => addMonths(from, i))

/** Fit [from,to] inside bounds, keeping its length when possible (shifts instead of shrinking). */
export function clampWindow(w: MonthWindow, bounds: MonthWindow): MonthWindow {
  const len = idx(w.to) - idx(w.from)
  let from = idx(w.from), to = idx(w.to)
  const bf = idx(bounds.from), bt = idx(bounds.to)
  if (to > bt) { to = bt; from = to - len }
  if (from < bf) { from = bf; to = Math.min(bf + len, bt) }
  return { from: key(from), to: key(to) }
}

export const defaultWindow = (bounds: MonthWindow, months = DEFAULT_MONTHS): MonthWindow =>
  clampWindow({ from: addMonths(bounds.to, -(months - 1)), to: bounds.to }, bounds)

export const windowAround = (ts: number, bounds: MonthWindow, before = GOTO_BEFORE, after = GOTO_AFTER): MonthWindow => {
  const m = monthKey(ts)
  return clampWindow({ from: addMonths(m, -before), to: addMonths(m, after) }, bounds)
}

export const windowCovers = (w: MonthWindow, ts: number): boolean => ts >= monthStart(w.from) && ts < monthEnd(w.to)

/** Month to append next when the revealed time gets within APPEND_AHEAD_MS of the window end; null if not needed / at the series end. */
export function nextAppend(w: MonthWindow, revealedTs: number, bounds: MonthWindow): string | null {
  if (idx(w.to) >= idx(bounds.to)) return null
  return revealedTs >= monthEnd(w.to) - APPEND_AHEAD_MS ? addMonths(w.to, 1) : null
}
