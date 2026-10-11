import { describe, expect, it } from 'vitest'
import { parseBarsCsv, parseTimestamp } from '../src/data/csv'

const T0 = Date.UTC(2026, 0, 5, 14, 30, 0) // 2026-01-05 14:30 UTC

describe('parseBarsCsv', () => {
  it('TradingView ISO time with header', () => {
    const r = parseBarsCsv('time,open,high,low,close,Volume\n2026-01-05T14:30:00Z,10,12,9,11,100\n2026-01-05T14:35:00Z,11,13,10,12,50')
    expect(r.warnings).toEqual([])
    expect(r.bars).toEqual([{ t: T0, o: 10, h: 12, l: 9, c: 11, v: 100 }, { t: T0 + 300_000, o: 11, h: 13, l: 10, c: 12, v: 50 }])
  })
  it('epoch seconds and epoch ms (Binance-style, extra columns)', () => {
    const s = parseBarsCsv(`time,open,high,low,close,volume\n${T0 / 1000},1,2,0.5,1.5,7`)
    expect(s.bars[0].t).toBe(T0)
    const b = parseBarsCsv(`open time,open,high,low,close,volume,close time\n${T0},1,2,0.5,1.5,7,${T0 + 299999}`)
    expect(b.bars[0]).toEqual({ t: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 })
  })
  it('Dukascopy Gmt time', () => {
    const r = parseBarsCsv('Gmt time,Open,High,Low,Close,Volume\n05.01.2026 14:30:00.000,1.1,1.3,1.0,1.2,5.5')
    expect(r.bars[0]).toEqual({ t: T0, o: 1.1, h: 1.3, l: 1.0, c: 1.2, v: 5.5 })
  })
  it('NinjaTrader headerless semicolon', () => {
    const r = parseBarsCsv('20260105 143000;100;101;99;100.5;12\n20260105 143500;100.5;102;100;101;3')
    expect(r.bars.map(b => b.t)).toEqual([T0, T0 + 300_000])
    expect(r.bars[0]).toMatchObject({ o: 100, h: 101, l: 99, c: 100.5, v: 12 })
  })
  it('separate date + time columns, tab delimiter', () => {
    const r = parseBarsCsv('date\ttime\topen\thigh\tlow\tclose\tvolume\n2026-01-05\t14:30:00\t1\t2\t0.5\t1.5\t7'.replace('\t14:30:00', '\t14:30:00'))
    expect(r.bars[0]?.t).toBe(T0)
  })
  it('naive times as New York incl. DST', () => {
    const jan = parseTimestamp('2026-01-05 09:30:00', 'America/New_York')
    const jul = parseTimestamp('2026-07-06 09:30:00', 'America/New_York')
    expect(jan).toBe(Date.UTC(2026, 0, 5, 14, 30))
    expect(jul).toBe(Date.UTC(2026, 6, 6, 13, 30))
    const r = parseBarsCsv('time,open,high,low,close\n2026-07-06 09:30:00,1,2,0.5,1.5', { timezone: 'America/New_York' })
    expect(r.bars[0].t).toBe(Date.UTC(2026, 6, 6, 13, 30))
  })
  it('explicit offset wins over timezone option', () => {
    expect(parseTimestamp('2026-01-05T09:30:00-05:00', 'Europe/Warsaw')).toBe(T0)
  })
  it('skips bad rows with warnings, sorts and dedupes', () => {
    const csv = [
      'time,open,high,low,close,volume',
      '2026-01-05T14:35:00Z,1,2,0.5,1.5,1',
      '2026-01-05T14:30:00Z,1,2,0.5,1.5,1',
      '2026-01-05T14:30:00Z,1,3,0.5,2,9',
      '2026-01-05T14:40:00Z,1,0.9,0.5,1.5,1', // high < open
      '2026-01-05T14:45:00Z,abc,2,0.5,1.5,1',
      'garbage,1,2,0.5,1.5,1',
    ].join('\n')
    const r = parseBarsCsv(csv)
    expect(r.bars.map(b => b.t)).toEqual([T0, T0 + 300_000])
    expect(r.bars[0].v).toBe(9)
    expect(r.warnings).toHaveLength(3)
  })
  it('caps warnings at 20 plus a count', () => {
    const rows = Array.from({ length: 30 }, () => 'x,1,2,0.5,1.5,1')
    const r = parseBarsCsv(['time,open,high,low,close,volume', ...rows].join('\n'))
    expect(r.bars).toEqual([])
    expect(r.warnings).toHaveLength(21)
    expect(r.warnings[20]).toContain('10 more')
  })
  it('reports missing header columns and empty input', () => {
    expect(parseBarsCsv('time,open,high\n1,2,3').warnings[0]).toContain('missing')
    expect(parseBarsCsv('').bars).toEqual([])
  })
})
