// Shared contracts. Times are epoch milliseconds (UTC). Prices are plain numbers.
export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

/** Base data timeframe in minutes (what is stored); chart timeframes are multiples of it. */
export type Minutes = number

export interface Instrument {
  symbol: string        // e.g. "NQ"
  name: string          // e.g. "E-mini Nasdaq-100 Futures"
  yahoo: string         // Yahoo symbol, e.g. "NQ=F"
  tick: number          // min price increment
  pointValue: number    // USD per 1.0 price point per contract
  exchange: string      // "CME" | "FX" | "OTC"
  // ---- optional (forex / gold); absent = futures defaults (2 decimals, SL/TP in points, CME 18:00 daily open) ----
  pricePrecision?: number   // decimals on the price axis / tables (default 2)
  pip?: number              // price size of one pip; SL/TP inputs are in pips when set, in points otherwise
  unit?: string             // label of the SL/TP/spread unit ('pips'); default 'pts'
  sessionOpenHour?: number  // New York hour at which a daily bar starts (default 18 = CME; FX/gold 17)
  contractNote?: string     // what 1 contract means, shown next to the qty input
  lotContracts?: number     // contracts per standard lot (100 for 1 = 0.01 lot)
  yahooKind?: 'spot' | 'futures'  // what `yahoo` returns (default futures)
  qtyStep?: number          // smallest order-size increment in contracts (default 1)
  dataSymbol?: 'NQ' | 'ES'  // reuse another instrument's local (Dukascopy / imported) datasets: micros track NQ/ES prices exactly
}

export type Side = 'buy' | 'sell'
export type OrderType = 'market' | 'limit' | 'stop'

export interface OrderRequest {
  side: Side
  type: OrderType
  qty: number           // contracts, > 0; a multiple of the account's qtyStep (decimals only in fractional mode)
  price?: number        // limit/stop trigger price
  sl?: number           // protective stop price (absolute)
  tp?: number           // take-profit price (absolute)
}

export interface Position { side: Side; qty: number; avgPrice: number; sl?: number; tp?: number; openedAt: number }
export interface ClosedTrade { side: Side; qty: number; entry: number; exit: number; pnl: number; openedAt: number; closedAt: number; reason: 'manual' | 'sl' | 'tp' | 'flip' }

// ---- Pine output (subset of PineTS drawing output the renderer needs) ----
export interface PineLine { id: number; x1: number; y1: number; x2: number; y2: number; color: string; width: number; style: string }
export interface PineLabel { id: number; x: number; y: number; text: string; textcolor: string; size: string }
export interface PineResult { lines: PineLine[]; labels: PineLabel[]; plots: Record<string, { t: number; v: number | null }[]> }
