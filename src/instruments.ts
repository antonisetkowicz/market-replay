import type { Instrument, Side } from './types'
export const INSTRUMENTS: Instrument[] = [
  { symbol: 'NQ', name: 'E-mini Nasdaq-100 Futures', yahoo: 'NQ=F', tick: 0.25, pointValue: 20, exchange: 'CME' },
  { symbol: 'ES', name: 'E-mini S&P 500 Futures', yahoo: 'ES=F', tick: 0.25, pointValue: 50, exchange: 'CME' },
  // Micro E-minis: 1/10 of the E-mini, same prices as NQ/ES -> the local datasets are shared via dataSymbol (Yahoo MNQ=F / MES=F verified 2026-10-06).
  { symbol: 'MNQ', name: 'Micro E-mini Nasdaq-100 Futures', yahoo: 'MNQ=F', tick: 0.25, pointValue: 2, exchange: 'CME', dataSymbol: 'NQ' },
  { symbol: 'MES', name: 'Micro E-mini S&P 500 Futures', yahoo: 'MES=F', tick: 0.25, pointValue: 5, exchange: 'CME', dataSymbol: 'ES' },
  // Broker contract: 1 contract = 0.01 lot = 1,000 base-currency units -> 100 contracts = 1 standard lot (pointValue = USD per 1.0 price move).
  { symbol: 'EURUSD', name: 'Euro / US Dollar', yahoo: 'EURUSD=X', yahooKind: 'spot', tick: 0.00001, pointValue: 1000, exchange: 'FX',
    pricePrecision: 5, pip: 0.0001, unit: 'pips', sessionOpenHour: 17, lotContracts: 100, contractNote: '1 = 0.01 lot = 1,000 EUR' },
  { symbol: 'GBPUSD', name: 'British Pound / US Dollar', yahoo: 'GBPUSD=X', yahooKind: 'spot', tick: 0.00001, pointValue: 1000, exchange: 'FX',
    pricePrecision: 5, pip: 0.0001, unit: 'pips', sessionOpenHour: 17, lotContracts: 100, contractNote: '1 = 0.01 lot = 1,000 GBP' },
  // Dukascopy gold quotes have 3 decimals (267,975 of 268,099 2026 bars) -> tick 0.001; a 0.01 tick would round fills/SL/TP/limits off the data.
  // Yahoo has no XAUUSD=X (404, measured 2026-10-05): the recent Yahoo set is COMEX gold futures GC=F (basis vs spot), labelled as futures.
  { symbol: 'XAUUSD', name: 'Gold / US Dollar (spot)', yahoo: 'GC=F', yahooKind: 'futures', tick: 0.001, pointValue: 1, exchange: 'OTC',
    pricePrecision: 3, pip: 0.1, unit: 'pips', sessionOpenHour: 17, lotContracts: 100, contractNote: '1 = 1 troy oz (100 = 1 lot)' },
]

export const pricePrecision = (i: Instrument): number => i.pricePrecision ?? 2
/** Size (in price) of the unit SL/TP/spread inputs are expressed in: 1 pip for forex/gold, 1 point for futures. */
/** Key of the local/imported datasets an instrument uses (MNQ -> NQ); the instrument's own symbol unless aliased. */
export const dataKey = (i: Instrument): string => i.dataSymbol ?? i.symbol
/** Display tag, e.g. 'MNQ (data: NQ)' for aliased instruments, plain symbol otherwise. */
export const symbolTag = (i: Instrument): string => (i.dataSymbol ? `${i.symbol} (data: ${i.dataSymbol})` : i.symbol)
export const unitSize = (i: Instrument): number => i.pip ?? 1
export const unitLabel = (i: Instrument): string => i.unit ?? 'pts'
export const isSpot = (i: Instrument): boolean => i.exchange === 'FX' || i.exchange === 'OTC'

/** SL/TP absolute prices from distances in the instrument's unit (pips/points), measured from `ref` against the trade direction. */
export function exitPrices(side: Side, ref: number, slUnits: number | undefined, tpUnits: number | undefined, unit: number): { sl?: number; tp?: number } {
  const dir = side === 'buy' ? 1 : -1
  return {
    ...(slUnits ? { sl: ref - dir * slUnits * unit } : {}),
    ...(tpUnits ? { tp: ref + dir * tpUnits * unit } : {}),
  }
}
