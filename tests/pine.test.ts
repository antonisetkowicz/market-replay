import { describe, expect, it, vi } from 'vitest'
// klinecharts touches `window` on import; the diff logic only needs the Chart interface
vi.mock('klinecharts', () => ({ registerOverlay: vi.fn() }))

import fixture from './fixtures/nq5m.json'
import { createPineRunner, PineError, stripCtx, tfString } from '../src/pine/runner'
import { SCRIPTS } from '../src/pine/scripts'
import { normalizeColor, syncPineOverlays } from '../src/chart/pineOverlay'
import type { Bar, PineResult } from '../src/types'
import type { Chart } from 'klinecharts'

const bars: Bar[] = (fixture as { openTime: number; open: number; high: number; low: number; close: number; volume: number }[])
  .map((b) => ({ t: b.openTime, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }))
const code = SCRIPTS[0]!.code
const runner = createPineRunner()
const go = (n: number) => runner.run(code, bars.slice(0, n), 5, 'NQ')

const COLORS = { Asia: 'rgb(95, 175, 115)', London: 'rgb(24, 203, 227)', 'New York': 'rgb(60, 60, 60)' } as const
// NY-minute-of-day windows where a session's extreme may be set (core + carry)
const WINDOWS: Record<string, [number, number][]> = {
  Asia: [[18 * 60, 24 * 60], [0, 2 * 60]],
  London: [[2 * 60, 9 * 60 + 30]],
  'New York': [[9 * 60 + 30, 16 * 60]],
}
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
function nyMinute(ms: number): number {
  const p = fmt.formatToParts(new Date(ms))
  return Number(p.find((x) => x.type === 'hour')!.value) * 60 + Number(p.find((x) => x.type === 'minute')!.value)
}
const inWindows = (name: string, ms: number) => WINDOWS[name]!.some(([a, b]) => nyMinute(ms) >= a && nyMinute(ms) < b)

describe('pine runner on real script', () => {
  let full: PineResult
  it('draws Asia/London/NY lines and labels inside their sessions', async () => {
    full = await go(700)
    for (const [name, color] of Object.entries(COLORS)) {
      const lines = full.lines.filter((l) => l.color === color)
      const labels = full.labels.filter((l) => l.text.startsWith(name))
      expect(lines.length, `${name} lines`).toBeGreaterThan(0)
      expect(labels.map((l) => l.text).sort()).toEqual([`${name} High`, `${name} Low`])
      for (const l of lines) {
        expect(inWindows(name, l.x1), `${name} x1 window`).toBe(true)
        expect(l.y1).toBe(l.y2)
      }
      const [hi, lo] = [Math.max(...lines.map((l) => l.y1)), Math.min(...lines.map((l) => l.y1))]
      expect(hi).toBeGreaterThanOrEqual(lo)
    }
    expect(JSON.stringify(full)).not.toContain('_deleted')
  })

  it('has no lookahead on prefixes', async () => {
    for (const k of [300, 420, 550, 650]) {
      const prefix = bars.slice(0, k)
      const r = await go(k)
      const last = prefix[k - 1]!
      const highs = new Set(prefix.map((b) => b.h))
      const lows = new Set(prefix.map((b) => b.l))
      for (const l of r.lines) {
        expect(l.x1).toBeLessThanOrEqual(last.t)
        expect(highs.has(l.y1) || lows.has(l.y1), `price ${l.y1} from future`).toBe(true)
      }
      // sessions finished before the cut (and not yet restarted) are identical on a longer prefix
      const later = await go(k + 12)
      const laterLast = bars[k + 11]!
      const keyOf = (l: { color: string; x1: number; y1: number }) => `${l.color}|${l.x1}|${l.y1}`
      const laterKeys = new Set(later.lines.map(keyOf))
      for (const [name, color] of Object.entries(COLORS)) {
        if (inWindows(name, last.t) || inWindows(name, laterLast.t)) continue
        for (const l of r.lines.filter((x) => x.color === color)) expect(laterKeys.has(keyOf(l))).toBe(true)
      }
    }
  })
})

describe('runner behaviour', () => {
  it('coalesces concurrent calls to the latest request', async () => {
    const calls: number[] = []
    const r = createPineRunner({
      exec: async (_c, b) => { calls.push(b.length); await new Promise((x) => setTimeout(x, 10)); return { lines: [], labels: [], plots: { n: [{ t: 0, v: b.length }] } } },
    })
    const mk = (n: number) => r.run('x', bars.slice(0, n), 5, 'NQ')
    const res = await Promise.all([mk(1), mk(2), mk(3), mk(4)])
    expect(calls).toEqual([1, 4])
    expect(res.map((x) => x.plots.n![0]!.v)).toEqual([1, 4, 4, 4])
  })

  it('rejects superseded callers with the latest error, no stray rejections', async () => {
    const r = createPineRunner({ exec: async (_c, b) => { if (b.length === 3) throw new PineError('boom'); return { lines: [], labels: [], plots: {} } } })
    const out = await Promise.allSettled([1, 2, 3].map((n) => r.run('x', bars.slice(0, n), 5, 'NQ')))
    expect(out[0]!.status).toBe('fulfilled')
    expect(out[1]!.status).toBe('rejected')
    expect(out[2]!.status).toBe('rejected')
    await expect(r.run('x', bars.slice(0, 1), 5, 'NQ')).resolves.toBeDefined() // still usable
  })

  it('wraps invalid Pine in PineError', async () => {
    await expect(runner.run('//@version=5\nindicator("x")\nx = 1 +\n', bars.slice(0, 50), 5, 'NQ')).rejects.toBeInstanceOf(PineError)
  })

  it('returns plot() series by name', async () => {
    const r = await runner.run('//@version=5\nindicator("x", overlay=true)\nplot(close, "px")\n', bars.slice(0, 20), 5, 'NQ')
    expect(r.plots.px).toHaveLength(20)
    expect(r.plots.px![5]).toEqual({ t: bars[5]!.t, v: bars[5]!.c })
  })

  it('helpers', () => {
    expect(tfString(1440)).toBe('D')
    expect(() => tfString(7)).toThrow(PineError)
    const circ: Record<string, unknown> = { a: 1, f: () => 1 }
    circ.self = circ
    expect(stripCtx(circ)).toEqual({ a: 1 })
  })
})

describe('overlay diff', () => {
  const line = (id: number, y: number) => ({ id, x1: 1, y1: y, x2: 2, y2: y, color: 'rgb(1, 2, 3)', width: 2, style: 'solid' })
  const label = (id: number, y: number) => ({ id, x: 2, y, text: 'T', textcolor: '#fff', size: 'tiny' })
  const fake = () => {
    const c = { createOverlay: vi.fn(), removeOverlay: vi.fn(), overrideOverlay: vi.fn() }
    return { c, chart: c as unknown as Chart }
  }

  it('creates, overrides moved, removes vanished, leaves unchanged', () => {
    const { c, chart } = fake()
    syncPineOverlays(chart, { lines: [line(1, 10), line(2, 20)], labels: [label(1, 10)], plots: {} }, 'g')
    expect(c.createOverlay.mock.calls[0]![0]).toHaveLength(3)
    syncPineOverlays(chart, { lines: [line(1, 11)], labels: [label(1, 10)], plots: {} }, 'g')
    expect(c.overrideOverlay).toHaveBeenCalledTimes(1)
    expect(c.overrideOverlay.mock.calls[0]![0].id).toBe('pine-line-1')
    expect(c.removeOverlay).toHaveBeenCalledWith({ id: 'pine-line-2' })
    expect(c.createOverlay).toHaveBeenCalledTimes(1)
    syncPineOverlays(chart, { lines: [line(1, 11)], labels: [label(1, 10)], plots: {} }, 'g')
    expect(c.overrideOverlay).toHaveBeenCalledTimes(1)
  })

  it('locks overlays', () => {
    const { c, chart } = fake()
    syncPineOverlays(chart, { lines: [line(1, 1)], labels: [label(1, 1)], plots: {} }, 'g')
    for (const o of c.createOverlay.mock.calls[0]![0]) expect(o.lock).toBe(true)
  })

  it('normalizes colors', () => {
    expect(normalizeColor('rgb(95, 175, 115)')).toBe('rgba(95, 175, 115, 1)')
    expect(normalizeColor('rgba(1,2,3,0.5)')).toBe('rgba(1, 2, 3, 0.5)')
    expect(normalizeColor('#f00')).toBe('rgba(255, 0, 0, 1)')
    expect(normalizeColor('#00ff0080')).toBe('rgba(0, 255, 0, 0.502)')
  })
})
