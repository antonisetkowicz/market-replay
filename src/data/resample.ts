import type { Bar, Minutes } from '../types'

export const MS_PER_MIN = 60_000
export const SESSION_TZ = 'America/New_York'
/** Chart axis / status clock. Sessions stay anchored to New York, so NY open = 15:30 here (14:30 in the ~3 weeks US and EU DST differ). */
export const DISPLAY_TZ = 'Europe/Warsaw'
/** CME Globex daily session opens 18:00 New York time (previous evening). */
export const SESSION_OPEN_HOUR = 18
const DAILY_MINUTES = 1440
const OFFSET_CACHE_GRANULARITY_MS = 15 * MS_PER_MIN

const formatters = new Map<string, Intl.DateTimeFormat>()
const offsetCache = new Map<string, number>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    formatters.set(tz, f)
  }
  return f
}

/** Offset (local - UTC) in ms of `tz` at instant `t`. Cached per 15-minute slot (zone changes never fall inside one). */
export function tzOffsetMs(t: number, tz: string): number {
  const slot = Math.floor(t / OFFSET_CACHE_GRANULARITY_MS)
  const key = `${tz}|${slot}`
  const hit = offsetCache.get(key)
  if (hit !== undefined) return hit
  const p: Record<string, number> = {}
  for (const part of formatter(tz).formatToParts(new Date(t))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const off = asUtc - Math.floor(t / 1000) * 1000
  offsetCache.set(key, off)
  return off
}

/** Convert a wall-clock time in `tz` to epoch ms. Ambiguous/skipped local times resolve deterministically. */
export function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms)
  const first = guess - tzOffsetMs(guess, tz)
  return guess - tzOffsetMs(first, tz)
}

/** Start (epoch ms) of the daily session (default CME 18:00; FX/gold pass 17) in New York containing instant t. DST-correct. */
export function sessionStart(t: number, openHour: number = SESSION_OPEN_HOUR): number {
  const local = new Date(t + tzOffsetMs(t, SESSION_TZ))
  const dayShift = local.getUTCHours() < openHour ? -1 : 0
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayShift))
  return wallToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), openHour, 0, 0, 0, SESSION_TZ)
}

/**
 * Bucket start for timeframe tfMinutes.
 * - tf < 1440: aligned to epoch multiples of tf. For whole-hour tfs this equals New York wall-clock alignment
 *   (NY offsets are whole hours), e.g. 60m buckets start on the hour in both UTC and NY.
 * - tf == 1440: session starting `openHour`:00 America/New_York (default 18 = CME; forex/gold use 17 like TradingView).
 * Weekly / multi-day timeframes are intentionally unsupported (throws).
 */
export function bucketStart(t: number, tfMinutes: Minutes, openHour: number = SESSION_OPEN_HOUR): number {
  if (tfMinutes < DAILY_MINUTES) {
    const size = tfMinutes * MS_PER_MIN
    return Math.floor(t / size) * size
  }
  if (tfMinutes === DAILY_MINUTES) return sessionStart(t, openHour)
  throw new Error(`Unsupported timeframe ${tfMinutes}m: only intraday (<1440) and daily (1440) are supported`)
}

function validate(baseMinutes: Minutes, tfMinutes: Minutes): void {
  if (!(baseMinutes > 0) || !(tfMinutes > 0)) throw new Error('Timeframes must be positive')
  if (tfMinutes < baseMinutes || tfMinutes % baseMinutes !== 0) {
    throw new Error(`Timeframe ${tfMinutes}m is not a multiple of base ${baseMinutes}m`)
  }
}

export function startBar(b: Bar, t: number): Bar {
  return { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }
}

export function mergeInto(cur: Bar, b: Bar): Bar {
  return { t: cur.t, o: cur.o, h: Math.max(cur.h, b.h), l: Math.min(cur.l, b.l), c: b.c, v: cur.v + b.v }
}

/** TradingView-style aggregation of time-sorted base bars. Pure; input is not modified. */
export function aggregate(baseBars: readonly Bar[], baseMinutes: Minutes, tfMinutes: Minutes, openHour: number = SESSION_OPEN_HOUR): Bar[] {
  validate(baseMinutes, tfMinutes)
  if (tfMinutes === baseMinutes) return baseBars.map(b => ({ ...b }))
  const out: Bar[] = []
  for (const b of baseBars) {
    const t = bucketStart(b.t, tfMinutes, openHour)
    const last = out[out.length - 1]
    if (last && last.t === t) out[out.length - 1] = mergeInto(last, b)
    else out.push(startBar(b, t))
  }
  return out
}

/**
 * Incremental update: returns a NEW series with `newBase` folded into the forming (last) candle, or appended as a
 * new candle. O(1) compute, O(n) array copy (immutability). Base bars must arrive in time order.
 */
export function updateForming(prevSeries: readonly Bar[], newBase: Bar, tfMinutes: Minutes, openHour: number = SESSION_OPEN_HOUR): Bar[] {
  const last = prevSeries[prevSeries.length - 1]
  const next = foldBar(last, newBase, tfMinutes, openHour)
  return last && last.t === next.t ? [...prevSeries.slice(0, -1), next] : [...prevSeries, next]
}

/** Candle that results from folding `base` into `last` (same bucket) or starting a new one. Pure, O(1). */
export function foldBar(last: Bar | undefined, base: Bar, tfMinutes: Minutes, openHour: number = SESSION_OPEN_HOUR): Bar {
  const t = bucketStart(base.t, tfMinutes, openHour)
  return last && last.t === t ? mergeInto(last, base) : startBar(base, t)
}

/** Series as of base bar idxInclusive: last candle is still forming, built only from base bars <= idx (no lookahead). */
export function aggregateUpTo(baseBars: readonly Bar[], baseMinutes: Minutes, tfMinutes: Minutes, idxInclusive: number, openHour: number = SESSION_OPEN_HOUR): Bar[] {
  return aggregate(baseBars.slice(0, idxInclusive + 1), baseMinutes, tfMinutes, openHour)
}
