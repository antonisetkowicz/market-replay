import type { Instrument, Minutes } from '../types'
import { INSTRUMENTS, dataKey, isSpot, symbolTag } from '../instruments'
import type { SeriesInfo } from './store'
import type { LocalSeries } from './localData'

/** A selectable data set. Sources are NEVER spliced: futures (Yahoo) and index CFD (Dukascopy) have different prices (basis). */
export interface Dataset {
  id: string
  symbol: string          // app instrument (NQ / ES)
  storeSymbol: string     // key in the IndexedDB archive
  baseMin: Minutes
  kind: 'yahoo' | 'local' | 'imported'
  label: string           // data selector
  short: string           // status line
  local?: LocalSeries
}

export const IMPORT_SUFFIX = '.import'
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10)
const span = (from: number, to: number) => `${ymd(from)} → ${ymd(to)}`
const tf = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`)

/** Yahoo sets are 'spot' (EURUSD=X) or 'futures' (NQ=F, GC=F for gold: Yahoo has no XAUUSD=X). */
export function yahooDatasets(inst: Instrument): Dataset[] {
  const kind = inst.yahooKind ?? 'futures'
  return ([[5, '60d'], [1, '7d']] as const).map(([m, depth]) => ({
    id: `yahoo:${inst.symbol}:${m}`, symbol: inst.symbol,
    // spot symbols share their name with the Dukascopy folder (EURUSD): keep the Yahoo archive separate so the two are never spliced
    storeSymbol: kind === 'spot' ? `${inst.symbol}.yahoo` : inst.symbol, baseMin: m, kind: 'yahoo' as const,
    label: `${inst.symbol} ${kind}${inst.yahoo.startsWith(inst.symbol) ? '' : ` (${inst.yahoo})`} · Yahoo ${tf(m)} (last ${depth})`, short: `${kind} (Yahoo ${tf(m)})`,
  }))
}

/** Archive key of a Dukascopy series: its folder name, except when that equals an app symbol (EURUSD) which would collide with other sets. */
export const localStoreSymbol = (folder: string): string => (INSTRUMENTS.some((i) => i.symbol === folder) ? `${folder}.dukascopy` : folder)

export function datasetsFor(inst: Instrument, local: readonly LocalSeries[], archive: readonly SeriesInfo[]): Dataset[] {
  const spot = isSpot(inst)
  const key = dataKey(inst), tag = symbolTag(inst)   // MNQ/MES resolve the very same series (and IndexedDB keys) as NQ/ES
  const localSets = local.filter((l) => l.appSymbol === key).map((l): Dataset => ({
    id: `local:${l.symbol}`, symbol: inst.symbol, storeSymbol: localStoreSymbol(l.symbol), baseMin: l.resolutionMinutes, kind: 'local', local: l,
    label: spot ? `${tag} · Dukascopy spot ${tf(l.resolutionMinutes)} bid (${span(l.from, l.to)})`
      : `${tag} index CFD · Dukascopy ${tf(l.resolutionMinutes)} (${span(l.from, l.to)}) — not futures`,
    short: spot ? 'spot (Dukascopy bid, no spread)' : 'index CFD (Dukascopy, NOT futures)',
  }))
  const imported = archive.filter((a) => a.symbol === `${key}${IMPORT_SUFFIX}`).map((a): Dataset => ({
    id: `import:${a.symbol}:${a.intervalMinutes}`, symbol: inst.symbol, storeSymbol: a.symbol, baseMin: a.intervalMinutes, kind: 'imported',
    label: `${tag} · imported CSV ${tf(a.intervalMinutes)} (${span(a.from, a.to)})`, short: 'imported CSV',
  }))
  return [...yahooDatasets(inst), ...localSets, ...imported]
}

export const instrumentOf = (symbol: string): Instrument => INSTRUMENTS.find((i) => i.symbol === symbol) ?? INSTRUMENTS[0]!
