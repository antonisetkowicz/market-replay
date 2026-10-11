import type { Bar } from '../types'

export const YAHOO_BASE = '/yahoo'
export type YahooInterval = '1m' | '5m' | '15m' | '1h' | '1d'

/** Max history Yahoo serves per interval (measured). 1m: range 8d is rejected with HTTP 422. */
export const YAHOO_LIMITS: Record<YahooInterval, { maxRange: string }> = {
  '1m': { maxRange: '7d' },
  '5m': { maxRange: '60d' },
  '15m': { maxRange: '60d' },
  '1h': { maxRange: '730d' },
  '1d': { maxRange: 'max' },
}

export function maxRangeFor(interval: YahooInterval): string {
  const lim = YAHOO_LIMITS[interval]
  if (!lim) throw new Error(`Unsupported Yahoo interval: ${interval}`)
  return lim.maxRange
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)

/** Pure parser of a Yahoo v8 chart response. Drops bars with null OHLC; null volume -> 0. */
export function parseYahooChart(json: unknown): Bar[] {
  const chart = (json as { chart?: { error?: { code?: string; description?: string } | null; result?: unknown[] | null } } | null)?.chart
  if (!chart) throw new Error('Yahoo response has no "chart" field')
  if (chart.error) throw new Error(`Yahoo error: ${chart.error.code ?? 'unknown'} - ${chart.error.description ?? ''}`)
  const result = chart.result?.[0] as { timestamp?: unknown; indicators?: { quote?: Record<string, unknown>[] } } | undefined
  if (!result) throw new Error('Yahoo response has no result')
  const ts = result.timestamp
  if (ts === undefined) return [] // valid empty window (e.g. weekend)
  const q = result.indicators?.quote?.[0]
  if (!Array.isArray(ts) || !q) throw new Error('Yahoo response malformed: missing timestamp/quote arrays')
  const { open, high, low, close, volume } = q as Record<string, unknown[] | undefined>
  if (!open || !high || !low || !close) throw new Error('Yahoo response malformed: missing OHLC arrays')
  const bars: Bar[] = []
  for (let i = 0; i < ts.length; i++) {
    const t = num(ts[i]), o = num(open[i]), h = num(high[i]), l = num(low[i]), c = num(close[i])
    if (t === null || o === null || h === null || l === null || c === null) continue
    bars.push({ t: t * 1000, o, h, l, c, v: num(volume?.[i]) ?? 0 })
  }
  return bars
}

export async function fetchYahooBars(
  yahooSymbol: string, interval: YahooInterval, range: string, fetchFn: typeof fetch = fetch,
): Promise<Bar[]> {
  if (!(interval in YAHOO_LIMITS)) throw new Error(`Unsupported Yahoo interval: ${interval}`)
  const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${encodeURIComponent(range)}`
  const res = await fetchFn(url)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Yahoo HTTP ${res.status} for ${yahooSymbol} ${interval} ${range}: ${body.slice(0, 200)}`)
  }
  return parseYahooChart(await res.json())
}
