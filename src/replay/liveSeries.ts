import type { Bar, Minutes } from '../types'
import { foldBar } from '../data/resample'

/**
 * Working copy of the chart series during replay. Mutated privately (O(1) amortised per step) instead of
 * copying the whole array every bar; callers only ever receive copies (tail/snapshot) or immutable Bars.
 */
export class LiveSeries {
  private bars: Bar[] = []

  /** Takes a copy of `bars`. */
  load(bars: readonly Bar[]): void { this.bars = bars.slice() }

  get length(): number { return this.bars.length }
  get last(): Bar | undefined { return this.bars[this.bars.length - 1] }

  /** Fold one base bar into the forming candle (or open a new one); returns the new forming candle. */
  fold(base: Bar, tfMinutes: Minutes, openHour?: number): Bar {
    const last = this.last
    const next = foldBar(last, base, tfMinutes, openHour)
    if (last && last.t === next.t) this.bars[this.bars.length - 1] = next
    else this.bars.push(next)
    return next
  }

  /** Copy of the newest n candles. */
  tail(n: number): Bar[] { return this.bars.slice(-n) }
  snapshot(): Bar[] { return this.bars.slice() }
}
