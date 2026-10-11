import type { ClosedTrade } from '../types'

export interface Stats {
  trades: number
  /** wins / trades, 0..1 (0 when no trades). Breakeven trades count as neither win nor loss. */
  winRate: number
  /** gross profit / gross loss; null when there are no losses (undefined/infinite). */
  profitFactor: number | null
  avgWin: number
  /** Mean P&L of losing trades, signed (negative or 0). */
  avgLoss: number
  /** Mean P&L per trade. */
  expectancy: number
  netPnl: number
  /** Largest peak-to-trough fall of the equity curve, in currency. */
  maxDrawdown: number
  /** Largest peak-relative fall, in percent (0-100). */
  maxDrawdownPct: number
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const cents = (x: number) => Math.round(x * 100) / 100

function drawdown(curve: number[]): { abs: number; pct: number } {
  let peak = -Infinity
  let abs = 0
  let pct = 0
  for (const v of curve) {
    if (!Number.isFinite(v)) continue
    peak = Math.max(peak, v)
    abs = Math.max(abs, peak - v)
    if (peak > 0) pct = Math.max(pct, ((peak - v) / peak) * 100)
  }
  return { abs, pct }
}

/** O(1)-per-bar drawdown accumulator (replay can run 100k+ bars; rescanning the curve every step is quadratic). */
export class DrawdownTracker {
  private peak = -Infinity
  private abs = 0
  private pct = 0
  constructor(first?: number) { if (first !== undefined) this.push(first) }
  push(v: number): void {
    if (!Number.isFinite(v)) return
    this.peak = Math.max(this.peak, v)
    this.abs = Math.max(this.abs, this.peak - v)
    if (this.peak > 0) this.pct = Math.max(this.pct, ((this.peak - v) / this.peak) * 100)
  }
  get result(): { abs: number; pct: number } { return { abs: this.abs, pct: this.pct } }
}

export function computeStats(trades: readonly ClosedTrade[], equity: number[] | DrawdownTracker): Stats {
  const pnls = trades.map((t) => t.pnl)
  const wins = pnls.filter((p) => p > 0)
  const losses = pnls.filter((p) => p < 0)
  const grossLoss = Math.abs(sum(losses))
  const dd = Array.isArray(equity) ? drawdown(equity) : equity.result
  const n = trades.length
  return {
    trades: n,
    winRate: n ? wins.length / n : 0,
    profitFactor: grossLoss > 0 ? sum(wins) / grossLoss : null,
    avgWin: wins.length ? sum(wins) / wins.length : 0,
    avgLoss: losses.length ? sum(losses) / losses.length : 0,
    expectancy: n ? sum(pnls) / n : 0,
    netPnl: cents(sum(pnls)),
    maxDrawdown: dd.abs,
    maxDrawdownPct: dd.pct,
  }
}
