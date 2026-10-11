import { describe, expect, it } from 'vitest'
import { addMonths, clampWindow, defaultWindow, monthEnd, monthKey, monthsBetween, monthStart, nextAppend, windowAround, windowCovers, APPEND_AHEAD_MS } from '../src/data/window'

const B = { from: '2003-05', to: '2026-10' }

describe('month arithmetic', () => {
  it('keys, bounds, year wrap', () => {
    expect(monthKey(Date.UTC(2026, 0, 31, 23, 59))).toBe('2026-01')
    expect(monthStart('2026-02')).toBe(Date.UTC(2026, 1, 1))
    expect(monthEnd('2026-12')).toBe(Date.UTC(2027, 0, 1))
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2025-11', 3)).toBe('2026-02')
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
    expect(monthsBetween('2026-02', '2025-11')).toEqual([])
    expect(() => addMonths('2026-1', 1)).toThrow()
  })
})

describe('window planning', () => {
  it('default = last 6 months (12 on request), clamped to a short series', () => {
    expect(defaultWindow(B)).toEqual({ from: '2026-05', to: '2026-10' })
    expect(defaultWindow(B, 12)).toEqual({ from: '2025-11', to: '2026-10' })
    expect(defaultWindow({ from: '2026-08', to: '2026-10' })).toEqual({ from: '2026-08', to: '2026-10' })
  })
  it('go-to-date: 3 months before, 6 after, shifted (not shrunk) at the edges', () => {
    expect(windowAround(Date.UTC(2015, 5, 10), B)).toEqual({ from: '2015-03', to: '2015-12' })
    expect(windowAround(Date.UTC(2026, 9, 1), B)).toEqual({ from: '2026-01', to: '2026-10' })   // end clamp keeps 10 months
    expect(windowAround(Date.UTC(2003, 5, 1), B)).toEqual({ from: '2003-05', to: '2004-02' })   // start clamp keeps 10 months
  })
  it('clampWindow keeps length when possible', () => {
    expect(clampWindow({ from: '2026-08', to: '2027-03' }, B)).toEqual({ from: '2026-03', to: '2026-10' })
    expect(clampWindow({ from: '2001-01', to: '2001-06' }, B)).toEqual({ from: '2003-05', to: '2003-10' })
  })
  it('covers is [start of from, end of to)', () => {
    const w = { from: '2026-04', to: '2026-06' }
    expect(windowCovers(w, Date.UTC(2026, 3, 1))).toBe(true)
    expect(windowCovers(w, Date.UTC(2026, 5, 30, 23, 59))).toBe(true)
    expect(windowCovers(w, Date.UTC(2026, 6, 1))).toBe(false)
    expect(windowCovers(w, Date.UTC(2026, 2, 31, 23, 59))).toBe(false)
  })
})

describe('append planning (replay approaching the window end)', () => {
  const w = { from: '2026-01', to: '2026-03' }
  const end = monthEnd(w.to)
  it('nothing until within 2 weeks of the end', () => {
    expect(nextAppend(w, end - APPEND_AHEAD_MS - 1, B)).toBeNull()
    expect(nextAppend(w, end - APPEND_AHEAD_MS, B)).toBe('2026-04')
    expect(nextAppend(w, end - 1, B)).toBe('2026-04')
  })
  it('never past the end of the series', () => {
    expect(nextAppend({ from: '2026-05', to: '2026-10' }, Date.UTC(2026, 9, 30), B)).toBeNull()
  })
})
