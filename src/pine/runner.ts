import { PineTS } from 'pinets'
import type { Bar, PineLabel, PineLine, PineResult } from '../types'

export const MAX_BARS = 1500
const MS_PER_MIN = 60_000

const TF_BY_MINUTES: Record<number, string> = { 1: '1', 5: '5', 15: '15', 60: '60', 240: '240', 1440: 'D' }

export function tfString(tfMinutes: number): string {
  const tf = TF_BY_MINUTES[tfMinutes]
  if (!tf) throw new PineError(`Unsupported timeframe: ${tfMinutes} min`)
  return tf
}

export class PineError extends Error {
  readonly pineMessage: string
  constructor(message: string, cause?: unknown) {
    super(`Pine error: ${message}`, { cause })
    this.name = 'PineError'
    this.pineMessage = message
  }
}

/** Drop non-JSON-safe / circular context refs (functions, `ctx`-like back references). */
export function stripCtx<T>(value: T): T {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(value, (k, v) => {
    if (typeof v === 'function' || k === 'ctx' || k === 'context') return undefined
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return undefined
      seen.add(v)
    }
    return v
  })
  return json === undefined ? value : (JSON.parse(json) as T)
}

type Raw = Record<string, unknown>
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

function snapshot(plots: Raw | undefined, key: string): Raw[] {
  const first = (plots?.[key] as { data?: { value?: unknown }[] } | undefined)?.data?.[0]?.value
  return Array.isArray(first) ? (first as Raw[]).filter((o) => o && !o._deleted) : []
}

function toLine(o: Raw): PineLine {
  return {
    id: num(o.id), x1: num(o.x1), y1: num(o.y1), x2: num(o.x2), y2: num(o.y2),
    color: str(o.color, 'rgb(41, 98, 255)'), width: num(o.width, 1), style: str(o.style, 'solid'),
  }
}

function toLabel(o: Raw): PineLabel {
  return {
    id: num(o.id), x: num(o.x), y: num(o.y), text: str(o.text),
    textcolor: str(o.textcolor, 'rgb(120, 120, 120)'), size: str(o.size, 'normal'),
  }
}

function toPlots(plots: Raw | undefined): PineResult['plots'] {
  const out: PineResult['plots'] = {}
  for (const [name, p] of Object.entries(plots ?? {})) {
    if (name.startsWith('__')) continue
    const data = (p as { data?: Raw[] }).data
    if (!Array.isArray(data)) continue
    out[name] = data.map((d) => ({ t: num(d.time), v: typeof d.value === 'number' && Number.isFinite(d.value) ? d.value : null }))
  }
  return out
}

async function execute(code: string, bars: Bar[], tfMinutes: number, symbol: string): Promise<PineResult> {
  const tf = tfString(tfMinutes)
  const pineBars = bars.slice(-MAX_BARS).map((b) => ({
    openTime: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
    closeTime: b.t + tfMinutes * MS_PER_MIN - 1,
  }))
  try {
    const ctx = await new PineTS(pineBars, symbol, tf).run(code)
    const plots = ctx.plots as Raw | undefined
    return {
      lines: snapshot(plots, '__lines__').map(toLine),
      labels: snapshot(plots, '__labels__').map(toLabel),
      plots: toPlots(plots),
    }
  } catch (e) {
    if (e instanceof PineError) throw e
    throw new PineError(e instanceof Error ? e.message : String(e), e)
  }
}

interface Request { code: string; bars: Bar[]; tf: number; symbol: string }
interface Waiter { resolve: (r: PineResult) => void; reject: (e: unknown) => void }

export interface PineRunner {
  run(code: string, bars: Bar[], tfMinutes: number, symbol: string): Promise<PineResult>
}

export interface PineRunnerOptions {
  /** Injectable executor (tests). */
  exec?: typeof execute
}

/**
 * Serialised runner. While a run is in flight only the newest queued request is kept;
 * every superseded caller resolves (or rejects) with the outcome of that newest run.
 */
export function createPineRunner(opts: PineRunnerOptions = {}): PineRunner {
  const exec = opts.exec ?? execute
  let busy = false
  let pending: { req: Request; waiters: Waiter[] } | null = null

  async function drain(first: { req: Request; waiters: Waiter[] }): Promise<void> {
    busy = true
    let job: { req: Request; waiters: Waiter[] } | null = first
    while (job) {
      const { req, waiters } = job
      try {
        const res = await exec(req.code, req.bars, req.tf, req.symbol)
        waiters.forEach((w) => w.resolve(res))
      } catch (e) {
        waiters.forEach((w) => w.reject(e))
      }
      job = pending
      pending = null
    }
    busy = false
  }

  return {
    run(code, bars, tfMinutes, symbol) {
      return new Promise<PineResult>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject }
        const req: Request = { code, bars, tf: tfMinutes, symbol }
        if (busy) {
          pending = { req, waiters: [...(pending?.waiters ?? []), waiter] }
        } else {
          void drain({ req, waiters: [waiter] })
        }
      })
    },
  }
}
