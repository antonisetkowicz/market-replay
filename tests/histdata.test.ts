import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script
import * as hd from '../scripts/download-histdata.mjs'
// @ts-expect-error plain .mjs script
import { gunzipCsv, bodyLines } from '../scripts/download-dukascopy.mjs'

const utc = (iso: string) => Date.parse(iso)
const line = (ts: number, c = 1) => `${ts},${c},${c},${c},${c},0`

/** Minimal single-entry zip (deflate) for the reader test. */
function makeZip(name: string, text: string): Buffer {
  const data = deflateRawSync(Buffer.from(text)), nm = Buffer.from(name)
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(text.length, 22); lh.writeUInt16LE(nm.length, 26)
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(text.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42)
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(46 + nm.length, 12); eo.writeUInt32LE(30 + nm.length + data.length, 16)
  return Buffer.concat([lh, nm, data, cd, nm, eo])
}

describe('histdata: URL / form building', () => {
  it('builds page, list and form bodies like the site does', () => {
    expect(hd.pageUrl('EURUSD', 2012)).toBe('https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/eurusd/2012')
    expect(hd.pageUrl('NSXUSD', 2026, 3)).toMatch(/nsxusd\/2026\/3$/)
    expect(hd.listUrl('XAUUSD')).toMatch(/1-minute-bar-quotes\/xauusd$/)
    expect(hd.formBody('abc123', 'EURUSD', 2012)).toBe('tk=abc123&date=2012&datemonth=2012&platform=ASCII&timeframe=M1&fxpair=EURUSD')
    expect(hd.formBody('t', 'EURUSD', 2026, 3)).toContain('datemonth=202603')
  })
  it('parses the hidden token and the whole-year list (month-split current year is ignored)', () => {
    expect(hd.parseToken('<input type="hidden" name="tk" id="tk" value="4bb833922b717734796b67b087aa2343" />')).toBe('4bb833922b717734796b67b087aa2343')
    expect(hd.parseToken('<html>nothing</html>')).toBeNull()
    const html = '<a href="x?/ascii/1-minute-bar-quotes/eurusd/2011">a</a><a href=".../1-minute-bar-quotes/eurusd/2010"></a><a href=".../1-minute-bar-quotes/eurusd/2026/3"></a><a href=".../1-minute-bar-quotes/gbpusd/2001">'
    expect(hd.parseYears(html, 'EURUSD')).toEqual([2010, 2011])
  })
})

describe('histdata: zip reader', () => {
  it('extracts the csv from a deflate zip and ignores the txt report', () => {
    const csv = '20120102 020000;1.29;1.30;1.28;1.29;0\n'
    expect(hd.csvFromZip(makeZip('DAT_ASCII_EURUSD_M1_2012.csv', csv))).toBe(csv)
    expect(() => hd.csvFromZip(Buffer.from('<html>not a zip</html>'))).toThrow()
    expect(() => hd.csvFromZip(makeZip('x.txt', 'hi'))).toThrow(/no \.csv/)
  })
})

describe('histdata: CSV row parsing', () => {
  it('parses a HistData row and rejects malformed ones', () => {
    expect(hd.parseRow('20120201 000100;1.306570;1.306570;1.306470;1.306560;0')).toEqual({ local: [2012, 2, 1, 0, 1], o: 1.30657, h: 1.30657, l: 1.30647, c: 1.30656 })
    expect(hd.parseRow('20040307 170700;1.2397    ;1.2397    ;1.2396    ;1.2396    ;0')).toMatchObject({ local: [2004, 3, 7, 17, 7], o: 1.2397, l: 1.2396 })   // 2004 files pad prices
    expect(hd.parseRow('garbage')).toBeNull()
    expect(hd.parseRow('2012-02-01 00:01;1;1;1;1;0')).toBeNull()
  })
  it('convertCsv sorts, dedupes (last wins), drops invalid OHLC and counts them', () => {
    const csv = ['20250110 000100;1.1;1.2;1.0;1.15;0', '20250110 000000;1.1;1.1;1.1;1.1;0', '20250110 000100;1.1;1.3;1.0;1.2;0', '20250110 000200;1.5;1.0;1.1;1.2;0', ''].join('\n')
    const { lines, bad } = hd.convertCsv(csv, 'fixed5')
    expect(bad).toBe(1)
    expect(lines).toEqual([`${utc('2025-01-10T05:00:00Z')},1.1,1.1,1.1,1.1,0`, `${utc('2025-01-10T05:01:00Z')},1.1,1.3,1,1.2,0`])
  })
})

describe('histdata: timezone rules (calibrated, see data/HISTDATA_NOTES.md)', () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number, rule: string) => new Date(hd.toUtcMs(y, mo, d, h, mi, rule)).toISOString()
  it('eudst (2019+): UTC-5, UTC-4 between the EU DST dates - proven against Dukascopy', () => {
    expect(at(2025, 3, 9, 16, 0, 'eudst')).toBe('2025-03-09T21:00:00.000Z')   // weekly open in the US-DST/EU-winter mismatch week
    expect(at(2025, 3, 30, 17, 0, 'eudst')).toBe('2025-03-30T21:00:00.000Z')  // EU switch Sunday
    expect(at(2024, 10, 27, 17, 0, 'eudst')).toBe('2024-10-27T22:00:00.000Z')
    expect(at(2025, 10, 26, 16, 0, 'eudst')).toBe('2025-10-26T21:00:00.000Z')
    expect(at(2025, 1, 10, 12, 0, 'eudst')).toBe('2025-01-10T17:00:00.000Z')
    expect(at(2025, 7, 10, 12, 0, 'eudst')).toBe('2025-07-10T16:00:00.000Z')
  })
  it('nydst (2003-2018): New York wall clock, US DST rules (2007 change included)', () => {
    expect(at(2012, 3, 11, 17, 0, 'nydst')).toBe('2012-03-11T21:00:00.000Z')   // weekly open on the US DST-start Sunday: 21:00Z
    expect(at(2012, 11, 4, 17, 0, 'nydst')).toBe('2012-11-04T22:00:00.000Z')   // and 22:00Z on the DST-end Sunday
    expect(at(2006, 3, 26, 17, 0, 'nydst')).toBe('2006-03-26T22:00:00.000Z')   // pre-2007: US DST only starts 1st Sunday of April
    expect(at(2006, 4, 2, 17, 0, 'nydst')).toBe('2006-04-02T21:00:00.000Z')
    expect(at(2007, 3, 11, 17, 0, 'nydst')).toBe('2007-03-11T21:00:00.000Z')   // 2007: 2nd Sunday of March
    expect(at(2006, 10, 29, 17, 0, 'nydst')).toBe('2006-10-29T22:00:00.000Z')
    expect(at(2012, 7, 4, 9, 30, 'nydst')).toBe('2012-07-04T13:30:00.000Z')
  })
  it('usDstActive / euDstActive boundaries', () => {
    expect(hd.usDstActive(2025, 3, 9, 1)).toBe(false); expect(hd.usDstActive(2025, 3, 9, 2)).toBe(true)
    expect(hd.usDstActive(2025, 11, 2, 1)).toBe(true); expect(hd.usDstActive(2025, 11, 2, 2)).toBe(false)
    expect(hd.euDstActive(2025, 3, 29)).toBe(false); expect(hd.euDstActive(2025, 3, 30)).toBe(true)
    expect(hd.euDstActive(2025, 10, 25)).toBe(true); expect(hd.euDstActive(2025, 10, 26)).toBe(false)
  })
  it('tzRuleForYear: per era, unknown / early years are unverified (quarantined)', () => {
    expect(hd.tzRuleForYear(2000)).toBe('unverified'); expect(hd.tzRuleForYear(2002)).toBe('unverified')
    expect(hd.tzRuleForYear(2003)).toBe('nydst'); expect(hd.tzRuleForYear(2018)).toBe('nydst')
    expect(hd.tzRuleForYear(2019)).toBe('eudst'); expect(hd.tzRuleForYear(2025)).toBe('eudst')
    expect(hd.tzRuleForYear(1999)).toBe('unverified')
    expect(() => hd.toUtcMs(2020, 1, 1, 0, 0, 'unverified')).toThrow()
  })
})

describe('histdata: merge rules and planning', () => {
  it('fillBefore: existing (Dukascopy) always wins, HistData only fills strictly before the boundary', () => {
    const duka = [line(100, 9), line(101, 9)]
    const hist = [line(98, 1), line(99, 1), line(100, 1), line(101, 1), line(102, 1)]
    expect(hd.fillBefore(duka, hist, 100)).toEqual([line(98, 1), line(99, 1), line(100, 9), line(101, 9)])
    expect(hd.fillBefore([], hist)).toHaveLength(5)
    expect(hd.fillBefore(hd.fillBefore(duka, hist, 100), hist, 100)).toEqual(hd.fillBefore(duka, hist, 100))   // idempotent re-run
  })
  it('bucketByUtcYear: the last 5 h of an EST year spill into the next UTC year', () => {
    const { lines } = hd.convertCsv('20181231 185900;1;1;1;1;0\n20181231 190000;1;1;1;1;0\n', 'fixed5')
    const b = hd.bucketByUtcYear(lines)
    expect([...b.keys()]).toEqual([2018, 2019])
  })
  it('planYears skips converted years and honours --years', () => {
    const meta = { histdata: { years: { 2011: { done: true } } } }
    expect(hd.planYears([2010, 2011, 2012], meta)).toEqual([2010, 2012])
    expect(hd.planYears([2010, 2011, 2012], meta, [2012, 2013])).toEqual([2012])
    expect(hd.planYears([2010, 2011, 2012], meta, undefined, true)).toEqual([2010, 2011, 2012])
  })
  it('buildSources describes the boundary', () => {
    const s = hd.buildSources(utc('2010-01-03T22:00:00Z'), utc('2024-07-01T00:00:00Z'), utc('2026-10-06T00:00:00Z'))
    expect(s).toEqual([
      { from: '2010-01-03T22:00:00.000Z', to: '2024-06-30T23:59:00.000Z', provider: 'histdata' },
      { from: '2024-07-01T00:00:00.000Z', to: '2026-10-06T00:00:00.000Z', provider: 'dukascopy' },
    ])
  })
  it('finalizeMeta sets earliest/sources, keeps the Dukascopy probe, lists quarantined years', () => {
    const meta = {
      source: 'Dukascopy public datafeed (dukascopy-node), bid, personal use', earliest: { metadataStart: '2003-05-04' }, failed: [],
      files: [{ file: 'a.csv.gz', year: 2010, count: 1, from: utc('2010-01-04T00:00:00Z'), to: utc('2011-01-01T00:00:00Z') }, { file: 'b.csv.gz', year: 2025, count: 1, from: utc('2025-01-01T00:00:00Z'), to: utc('2026-10-05T00:00:00Z') }],
      histdata: { boundaryTs: utc('2024-07-01T00:00:00Z'), years: { 2001: { tz_unverified: true }, 2010: { done: true } } },
    }
    const m = hd.finalizeMeta(meta, new Date('2026-10-06T00:00:00Z'))
    expect(m.earliest).toMatchObject({ firstBar: '2010-01-04T00:00:00.000Z', provider: 'histdata' })
    expect(m.dukascopyEarliest).toEqual({ metadataStart: '2003-05-04' })
    expect(m.sources.map((s: { provider: string }) => s.provider)).toEqual(['histdata', 'dukascopy'])
    expect(m.histdata.tz_unverified_years).toEqual([2001])
    expect(hd.finalizeMeta(hd.finalizeMeta(meta)).dukascopyEarliest).toEqual({ metadataStart: '2003-05-04' })   // idempotent
  })
})

describe('histdata: sanity report', () => {
  it('flags unsorted/dup/invalid bars, weekend bars and >5% jumps', () => {
    const fri = utc('2025-01-10T12:00:00Z'), sat = utc('2025-01-11T12:00:00Z')
    const lines = [line(fri, 1), line(fri + 60_000, 1.2), `${fri + 120_000},1,0.5,2,1,0`, line(fri + 120_000, 1.2), line(sat, 1.2), line(fri, 1.2)]
    const s = hd.sanity(lines)
    expect(s).toMatchObject({ count: 6, dups: 1, unsorted: 1, badOhlc: 1, weekend: 1 })
    expect(s.jumps).toHaveLength(3)   // 1 -> 1.2, 1.2 -> 1 (the invalid bar's close), 1 -> 1.2 (its duplicate)
    expect(hd.sanity([line(utc('2025-01-12T22:00:00Z'), 1), line(utc('2025-01-13T12:00:00Z'), 1)]).weekend).toBe(0)
  })
  it('isClosedFx and mid-week holes', () => {
    expect(hd.isClosedFx(utc('2025-01-11T10:00:00Z'))).toBe(true)    // Saturday
    expect(hd.isClosedFx(utc('2025-01-10T22:30:00Z'))).toBe(true)    // Friday after the close
    expect(hd.isClosedFx(utc('2025-01-10T21:59:00Z'))).toBe(false)
    expect(hd.isClosedFx(utc('2025-01-12T19:59:00Z'))).toBe(true)    // Sunday before the open
    expect(hd.isClosedFx(utc('2025-01-12T21:00:00Z'))).toBe(false)
    const hole = [line(utc('2025-01-14T10:00:00Z')), line(utc('2025-01-14T13:00:00Z')), line(utc('2025-01-14T14:00:00Z'))]
    expect(hd.sanity(hole).gaps2h).toBe(1)
    expect(hd.sanity([line(utc('2025-01-10T10:00:00Z')), line(utc('2025-01-12T22:00:00Z'))]).gaps2h).toBe(0)   // weekend closure is not a hole
  })
})

describe('histdata: retry + storage', () => {
  it('withRetry retries transient errors with backoff but never retries a block (403/429)', async () => {
    const waits: number[] = []
    let n = 0
    const ok = await hd.withRetry(async () => { if (++n < 3) throw new Error('503'); return 'fine' }, async (ms: number) => { waits.push(ms) })
    expect(ok).toBe('fine'); expect(waits).toEqual([15_000, 45_000])
    let calls = 0
    await expect(hd.withRetry(async () => { calls++; throw new hd.BlockedError('HTTP 429') }, async () => {})).rejects.toThrow(/429/)
    expect(calls).toBe(1)
    await expect(hd.withRetry(async () => { throw new Error('boom') }, async () => {})).rejects.toThrow('boom')
  })
  it('storeYear merges under Dukascopy rows, quarantine bypasses meta.files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hd-'))
    const base = { files: [] as unknown[], failed: [] }
    const boundary = utc('2025-01-01T00:00:00Z')
    const hist = [line(utc('2024-12-31T23:59:00Z'), 1), line(utc('2025-01-01T00:01:00Z'), 1)]
    const m1 = await hd.storeYear({ meta: base, folder: 'EURUSD', dataDir: dir, histYear: 2024, lines: hist, boundaryTs: boundary, quarantine: false })
    expect(m1.files.map((f: { file: string }) => f.file)).toEqual(['EURUSD_1m_2024.csv.gz'])   // the row at/after the boundary is dropped
    expect(bodyLines(gunzipCsv(await readFile(path.join(dir, 'EURUSD', 'EURUSD_1m_2024.csv.gz'))))).toEqual([hist[0]])
    const q = await hd.storeYear({ meta: base, folder: 'EURUSD', dataDir: dir, histYear: 2001, lines: hist, boundaryTs: boundary, quarantine: true })
    expect(q.files).toEqual([])
    await hd.storeYear({ meta: base, folder: 'EURUSD', dataDir: dir, histYear: 2002, lines: [line(utc('2024-12-31T22:00:00Z'), 7)], boundaryTs: boundary, quarantine: true })
    const keep = hd.fillBefore([line(5)], [line(5, 9), line(6, 9)], Infinity)
    expect(keep).toEqual([line(5), line(6, 9)])   // quarantine re-writes keep the spill rows of neighbouring years
    for (const y of [2024, 2025]) expect(bodyLines(gunzipCsv(await readFile(path.join(dir, '_quarantine', 'EURUSD', `EURUSD_1m_${y}.csv.gz`)))).length).toBe(y === 2024 ? 2 : 1)   // by UTC year, boundary ignored, merged with the earlier run
  })
  it('purgeHistdata removes HistData-owned rows and files, keeps Dukascopy rows (>= boundary)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hd-'))
    const boundary = utc('2025-01-01T00:00:00Z')
    const lines = [line(utc('2024-06-01T00:00:00Z'), 1), line(utc('2024-12-31T23:59:00Z'), 1), line(utc('2025-01-01T00:00:00Z'), 9)]
    let meta = await hd.storeYear({ meta: { files: [] as unknown[], failed: [], histdata: { years: { 2024: { done: true } } } }, folder: 'X', dataDir: dir, histYear: 2024, lines: lines.slice(0, 2), boundaryTs: Infinity, quarantine: false })
    meta = await hd.storeYear({ meta, folder: 'X', dataDir: dir, histYear: 2025, lines: lines.slice(2), boundaryTs: Infinity, quarantine: false })
    const out = await hd.purgeHistdata(meta, 'X', dir, boundary)
    expect(out.files.map((f: { file: string }) => f.file)).toEqual(['X_1m_2025.csv.gz'])
    expect(out.histdata.years).toBeUndefined()
    expect(bodyLines(gunzipCsv(await readFile(path.join(dir, 'X', 'X_1m_2025.csv.gz'))))).toEqual([lines[2]])
  })
})
