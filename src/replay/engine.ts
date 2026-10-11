import type { Bar } from '../types'

export interface ReplayState {
  bars: readonly Bar[]
  /** index of the last revealed base bar; -1 = nothing revealed */
  idx: number
  playing: boolean
  /** ms between steps while playing (TradingView offers 10 / 3 / 1 / 0.5 / 0.3 / 0.1 s) */
  stepMs: number
}

type Listener = (state: ReplayState, revealed: Bar | null) => void

/** Forward-only replay clock: reveals one base bar at a time, never exposes future bars. */
export class ReplayEngine {
  private state: ReplayState = { bars: [], idx: -1, playing: false, stepMs: 1000 }
  private timer: ReturnType<typeof setTimeout> | null = null
  /** playback ran out of loaded bars while playing (waiting for append()); cleared by play/seek/load/pause-by-user */
  private dry = false
  private listeners = new Set<Listener>()

  get snapshot(): ReplayState { return this.state }

  /** Bars visible to the chart/indicators/broker: strictly up to idx. */
  get visible(): readonly Bar[] { return this.state.bars.slice(0, this.state.idx + 1) }

  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  load(bars: readonly Bar[]): void {
    this.clearTimer(); this.dry = false
    this.set({ bars, idx: -1, playing: false })
  }

  /**
   * Extend the loaded bars at the END (next data window) without touching idx / playing / the timer, so a running replay
   * and the account continue seamlessly. Forward-only: `more` must be strictly ascending and strictly after the last
   * loaded bar, otherwise it throws and nothing changes. No listener fires (nothing new is revealed).
   * If playback had run dry at the old end (the load was slower than the remaining bars) it resumes by itself.
   */
  append(more: readonly Bar[]): void {
    if (more.length === 0) return
    const last = this.state.bars[this.state.bars.length - 1]
    let prev = last ? last.t : -Infinity
    for (const b of more) {
      if (!(b.t > prev)) throw new Error(`append: bar ${b.t} is not after ${prev} (forward-only)`)
      prev = b.t
    }
    this.state = { ...this.state, bars: [...this.state.bars, ...more] }
    if (this.dry) this.play()
  }

  /** Start replay so that bars[0..idx] are visible. */
  seek(idx: number): void {
    this.pause(); this.dry = false
    const clamped = Math.max(-1, Math.min(idx, this.state.bars.length - 1))
    this.set({ idx: clamped }, null)
  }

  step(): boolean {
    const { bars, idx } = this.state
    if (idx + 1 >= bars.length) { this.dry = this.state.playing; this.pause(); return false }
    this.set({ idx: idx + 1 }, bars[idx + 1])
    return true
  }

  play(): void {
    if (this.state.playing || this.state.idx < 0) return
    this.dry = false
    this.set({ playing: true })
    const tick = () => {
      if (!this.state.playing) return
      if (!this.step()) return
      this.timer = setTimeout(tick, this.state.stepMs)
    }
    this.timer = setTimeout(tick, this.state.stepMs)
  }

  pause(): void {
    this.clearTimer()
    if (this.state.playing) this.set({ playing: false })
  }

  setSpeed(stepMs: number): void {
    if (!(stepMs >= 10)) throw new Error(`stepMs must be >= 10, got ${stepMs}`)
    const was = this.state.playing
    this.pause()
    this.set({ stepMs })
    if (was) this.play()
  }

  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null }

  private set(patch: Partial<ReplayState>, revealed: Bar | null = null): void {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn(this.state, revealed)
  }
}
