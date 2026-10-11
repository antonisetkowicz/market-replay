import { describe, expect, it, vi } from 'vitest'
vi.mock('klinecharts', () => ({ registerOverlay: vi.fn() }))

import { createPineRunner } from '../src/pine/runner'
import { SCRIPTS } from '../src/pine/scripts'
import { DISPLAY_TZ, wallToUtc } from '../src/data/resample'
import type { Bar } from '../src/types'

const hhmm = (ms: number, tz: string): string =>
  new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

// 15m bars for one NY day from 18:00 prev evening to 16:00; the price jumps at 09:30 NY so the NY High label marks the open.
function day(y: number, mo: number, d: number): Bar[] {
  const start = wallToUtc(y, mo, d - 1, 18, 0, 0, 0, 'America/New_York')
  const out: Bar[] = []
  for (let t = start; t < start + 22 * 3_600_000; t += 15 * 60_000) {
    const afterOpen = t >= wallToUtc(y, mo, d, 9, 30, 0, 0, 'America/New_York')
    const p = afterOpen ? 200 : 100
    out.push({ t, o: p, h: p + 1, l: p - 1, c: p, v: 1 })
  }
  return out
}

describe('NY open in Warsaw time follows both DST calendars', () => {
  const runner = createPineRunner()
  const cases: [string, [number, number, number], string][] = [
    ['winter (both standard)', [2026, 1, 14], '15:30'],
    ['summer (both DST)', [2026, 7, 14], '15:30'],
    ['March gap (US DST, EU not yet)', [2026, 3, 16], '14:30'],
    ['Oct/Nov gap (EU standard, US DST)', [2026, 10, 28], '14:30'],
  ]
  for (const [name, [y, mo, d], expected] of cases) {
    it(`${name}: NY session starts ${expected} ${DISPLAY_TZ}`, async () => {
      const r = await runner.run(SCRIPTS[0]!.code, day(y, mo, d), 15, 'NQ')
      const nyLines = r.lines.filter((l) => l.color === 'rgb(60, 60, 60)')
      expect(nyLines.length).toBeGreaterThan(0)
      expect(hhmm(Math.min(...nyLines.map((l) => l.x1)), DISPLAY_TZ)).toBe(expected)
    })
  }
})
