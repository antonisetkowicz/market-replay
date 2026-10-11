import type { Bar } from '../types'
import { wallToUtc } from './resample'

export interface CsvOptions { timezone?: string }
export interface CsvResult { bars: Bar[]; warnings: string[] }

const MAX_WARNINGS = 20
const MS_EPOCH_MIN = 1e12     // >= this: epoch milliseconds
const US_EPOCH_MIN = 1e15     // >= this: epoch microseconds
const SEC_EPOCH_MIN = 1e9     // >= this: epoch seconds

const TIME_NAMES = ['time', 'timestamp', 'gmt time', 'datetime', 'date time', 'open time', 'opentime', 'ts', 't', 'local time']
const clean = (s: string) => s.trim().replace(/^"|"$/g, '').trim()

function detectDelimiter(line: string): string {
  const counts = [',', ';', '\t'].map(d => [d, line.split(d).length - 1] as const)
  return counts.sort((a, b) => b[1] - a[1])[0][0]
}

type Parts = [number, number, number, number, number, number, number]

function fraction(f: string | undefined): number {
  return f ? Math.round(Number(`0.${f}`) * 1000) : 0
}

/** Parse a timestamp cell to epoch ms (UTC). Naive wall times are interpreted in `tz` (default UTC). */
export function parseTimestamp(raw: string, tz?: string): number | null {
  const s = clean(raw)
  const naive = (p: Parts): number => (tz && tz !== 'UTC' ? wallToUtc(...p, tz) : Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5], p[6]))
  let m: RegExpMatchArray | null
  if (/^\d{9,}(\.\d+)?$/.test(s)) {
    const n = Number(s)
    if (n >= US_EPOCH_MIN) return Math.round(n / 1000)
    if (n >= MS_EPOCH_MIN) return Math.round(n)
    if (n >= SEC_EPOCH_MIN) return Math.round(n * 1000)
    if (/^\d{8}$/.test(s)) return naive([+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8), 0, 0, 0, 0])
    return null
  }
  if (/^\d{8}$/.test(s)) return naive([+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8), 0, 0, 0, 0])
  // ISO-ish: 2026-01-05, 2026-01-05T12:00:00Z, 2026/01/05 12:00, optional offset
  m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i)
  if (m) {
    const p: Parts = [+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), fraction(m[7])]
    if (!m[8]) return naive(p)
    const base = Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5], p[6])
    if (m[8].toUpperCase() === 'Z') return base
    const sign = m[8][0] === '-' ? -1 : 1
    const digits = m[8].slice(1).replace(':', '')
    return base - sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4)) * 60_000
  }
  // Dukascopy: dd.MM.yyyy HH:mm:ss.SSS
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/)
  if (m) return naive([+m[3], +m[2], +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), fraction(m[7])])
  // NinjaTrader: yyyyMMdd HHmmss  (also yyyyMMdd HH:mm:ss)
  m = s.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):?(\d{2}):?(\d{2})?(?:\.(\d+))?$/)
  if (m) return naive([+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0), fraction(m[7])])
  return null
}

interface Layout { time: number; date: number; o: number; h: number; l: number; c: number; v: number }

const POSITIONAL: Layout = { time: 0, date: -1, o: 1, h: 2, l: 3, c: 4, v: 5 }

function layoutFromHeader(cells: string[]): Layout | string {
  const names = cells.map(c => clean(c).toLowerCase())
  const find = (...cands: string[]) => names.findIndex(n => cands.includes(n))
  const dateIdx = find('date')
  const timeOnly = find('time')
  const combined = dateIdx >= 0 && timeOnly >= 0
  const time = combined ? timeOnly : names.findIndex(n => TIME_NAMES.includes(n)) >= 0 ? names.findIndex(n => TIME_NAMES.includes(n)) : dateIdx
  const layout: Layout = {
    time, date: combined ? dateIdx : -1,
    o: find('open', 'o'), h: find('high', 'h'), l: find('low', 'l'), c: find('close', 'c', 'last'),
    v: find('volume', 'vol', 'v', 'tick volume', 'tickvolume'),
  }
  const missing = (['time', 'o', 'h', 'l', 'c'] as const).filter(k => layout[k] < 0)
  return missing.length ? `Header missing columns: ${missing.join(', ')} (found: ${names.join(', ')})` : layout
}

function looksLikeHeader(cells: string[]): boolean {
  return cells.some(c => /[a-z]/i.test(clean(c)) && /open|high|low|close|time|date|volume/i.test(c))
}

function parseNumber(raw: string | undefined, decimalComma: boolean): number {
  if (raw === undefined) return NaN
  const s = clean(raw)
  if (s === '') return NaN
  return Number(decimalComma ? s.replace(',', '.') : s)
}

export function parseBarsCsv(text: string, opts: CsvOptions = {}): CsvResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length === 0) return { bars: [], warnings: ['Empty file'] }
  const delim = detectDelimiter(lines[0])
  const decimalComma = delim !== ','
  const split = (l: string) => l.split(delim)
  const first = split(lines[0])
  let layout: Layout = POSITIONAL
  let start = 0
  if (looksLikeHeader(first)) {
    const lay = layoutFromHeader(first)
    if (typeof lay === 'string') return { bars: [], warnings: [lay] }
    layout = lay
    start = 1
  } else if (first.length < 5) {
    return { bars: [], warnings: [`Cannot detect layout: ${first.length} columns and no header`] }
  } else if (first.length === 5) {
    layout = { ...POSITIONAL, v: -1 }
  }

  const bars: Bar[] = []
  const warnings: string[] = []
  const warn = (i: number, why: string) => warnings.push(`Line ${i + 1}: ${why}`)
  for (let i = start; i < lines.length; i++) {
    const cells = split(lines[i])
    const timeRaw = layout.date >= 0 ? `${clean(cells[layout.date] ?? '')} ${clean(cells[layout.time] ?? '')}` : cells[layout.time] ?? ''
    const t = parseTimestamp(timeRaw, opts.timezone)
    if (t === null) { warn(i, `bad timestamp "${clean(timeRaw)}"`); continue }
    const o = parseNumber(cells[layout.o], decimalComma), h = parseNumber(cells[layout.h], decimalComma)
    const l = parseNumber(cells[layout.l], decimalComma), c = parseNumber(cells[layout.c], decimalComma)
    if (![o, h, l, c].every(Number.isFinite)) { warn(i, 'non-finite OHLC'); continue }
    if (h < Math.max(o, c) || l > Math.min(o, c)) { warn(i, `inconsistent OHLC (${o},${h},${l},${c})`); continue }
    const vRaw = layout.v >= 0 ? parseNumber(cells[layout.v], decimalComma) : 0
    const v = Number.isFinite(vRaw) ? vRaw : 0
    bars.push({ t, o, h, l, c, v })
  }
  const dedup = new Map<number, Bar>()
  for (const b of bars) dedup.set(b.t, b)
  const sorted = [...dedup.values()].sort((a, b) => a.t - b.t)
  const shown = warnings.slice(0, MAX_WARNINGS)
  if (warnings.length > MAX_WARNINGS) shown.push(`... and ${warnings.length - MAX_WARNINGS} more skipped rows`)
  return { bars: sorted, warnings: shown }
}
