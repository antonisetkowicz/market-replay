/**
 * Simulated futures broker for bar-by-bar replay. Pure functions, immutable state.
 *
 * Fill rules (all evaluated in onBar, once per NEWLY REVEALED bar):
 *  - market order : fills inside placeOrder at lastPrice (close of latest revealed bar).
 *  - buy limit    : if bar.low  <= limit -> fill at min(limit, open)  (gap-through fills at open)
 *  - sell limit   : if bar.high >= limit -> fill at max(limit, open)
 *  - buy stop     : if bar.high >= stop  -> fill at max(stop, open)
 *  - sell stop    : if bar.low  <= stop  -> fill at min(stop, open)
 *  - Order of work per bar: (1) SL/TP of the position that existed at the bar's open,
 *    (2) pending orders in id order, (3) SL/TP of a position opened/added by (2) on the SAME
 *    bar. Step 3 never fills better than the entry fill price (the open preceded the entry, so
 *    "gap-through at open" does not apply). Its TP may in reality have been touched before the
 *    entry (intrabar order is unknown) - an accepted optimistic approximation.
 *  - An order is only eligible on bars strictly after the one it was placed on (bar.t > createdAt);
 *    likewise a position's SL/TP are not evaluated on bars at/before its openedAt.
 *  - SL fills like a stop (gap-through at open); TP fills like a limit.
 *  - If SL and TP are both touched in one bar, SL is assumed hit first (conservative), unless the
 *    bar OPENS beyond TP (TP gap-through), which is chronologically first.
 *  - An order that only reduces the position does not change its SL/TP (they describe the
 *    opposite-side position the order would have opened).
 *  - Money (cash, commission, gross, pnl) is rounded to cents at every step to prevent drift.
 *
 * Position model: one net position per account. An opposite-side fill reduces, closes or
 * flips it (a flip closes the old position with reason 'flip', remainder opens a new one).
 * Entry sl/tp attach to the resulting position; the latest order specifying them wins.
 * There is no OCO: pending orders survive the position being closed.
 *
 * Costs: commissionPerSidePerContract is charged on every fill and subtracted from cash.
 * ClosedTrade.pnl is net of the round-trip commission (2 x per-side x closed qty).
 *
 * Contracts: qty is a multiple of qtyStep(state) contracts (integer by default; futures accept 0.01 steps only when the
 * account's SIMULATION switch `fractional` is on - real exchanges are integer-only). Sizes are rounded to 1e-8 so 0.01 steps
 * accumulate without float dust. USD P&L = price move x instrument.pointValue x qty.
 * Futures: NQ 20 / ES 50 USD per point. Forex: 1 contract = 0.01 lot = 1,000 base units (pointValue 1000), so
 * 100 contracts = 1 lot and a 10-pip (0.0010) move = $100. Gold: 1 contract = 1 troy oz (pointValue 1).
 * Micros: MNQ 2 / MES 5 USD per point. modifyPosition / modifyOrder / closePartial live in ./modify (re-exported here).
 *
 * Spread: Dukascopy candles are BID prices. By default the spread is NOT modelled (account.spread = 0, every fill is at
 * bid). With a fixed spread s > 0 (price units) buys execute on the ask = bid + s: market buys, closing a short, buy
 * limit/stop triggers (bar shifted by +s) and the SL/TP of shorts; a short is also marked to market at the ask.
 * Sells / long exits stay on the bid. Pending order levels are trigger levels against the ask for buys.
 *
 * NOT MODELLED: margin / buying power (orders are never rejected for lack of funds),
 * slippage, partial fills, fills on volume, session breaks, swaps and rollover.
 */
import type { Bar, ClosedTrade, Instrument, OrderRequest, Position, Side } from '../types'
import { isSpot } from '../instruments'
export { closePartial, modifyOrder, modifyPosition } from './modify'

export interface PendingOrder {
  id: number
  side: Side
  type: 'limit' | 'stop'
  qty: number
  price: number
  sl?: number
  tp?: number
  createdAt: number
}

export interface AccountState {
  readonly instrument: Instrument
  readonly startingCash: number
  readonly commission: number
  /** Fixed spread in price units (ask = bid + spread). 0 = bid-only fills. */
  readonly spread: number
  /** Realised cash: starting cash + closed gross P&L - all commissions paid. */
  readonly cash: number
  readonly position: Position | null
  readonly orders: readonly PendingOrder[]
  readonly trades: readonly ClosedTrade[]
  readonly nextOrderId: number
  /** SIMULATION option: futures accept sizes down to FRACTIONAL_STEP contracts (default false = integer contracts). */
  readonly fractional?: boolean
}

export type FillSource = 'market' | 'limit' | 'stop' | 'sl' | 'tp' | 'close'

export type BrokerEvent =
  | { type: 'fill'; source: FillSource; orderId?: number; side: Side; qty: number; price: number; time: number }
  | { type: 'trade'; trade: ClosedTrade }

export interface BrokerResult { state: AccountState; events: BrokerEvent[]; error?: string }

export const FRACTIONAL_STEP = 0.01
export const sign = (side: Side): 1 | -1 => (side === 'buy' ? 1 : -1)
export const opposite = (side: Side): Side => (side === 'buy' ? 'sell' : 'buy')
export const cents = (x: number): number => Math.round(x * 100) / 100
/** Sizes are decimal-safe: rounded to 1e-8 after every add/subtract. */
export const roundQty = (x: number): number => Math.round(x * 1e8) / 1e8

/** Smallest allowed size increment (contracts). Fractional mode only applies to futures: forex/gold already trade in 0.01-lot contracts. */
export const qtyStep = (state: Pick<AccountState, 'instrument' | 'fractional'>): number =>
  state.fractional && !isSpot(state.instrument) ? FRACTIONAL_STEP : state.instrument.qtyStep ?? 1

/** Error text when qty is not a positive multiple of step, else undefined. */
export function qtyError(qty: number, step: number): string | undefined {
  const k = qty / step
  if (typeof qty === 'number' && Number.isFinite(qty) && qty > 0 && Math.abs(k - Math.round(k)) < 1e-6 && Math.round(k) >= 1) return undefined
  return step === 1 ? 'qty must be a positive integer' : `qty must be a positive multiple of ${step}`
}

export function roundToTick(price: number, tick: number): number {
  return Number((Math.round(price / tick) * tick).toFixed(10))
}

export function createAccount(
  instrument: Instrument, startingCash = 50000, commissionPerSidePerContract = 0, spread = 0, options: { fractional?: boolean } = {},
): AccountState {
  return {
    instrument, startingCash, commission: commissionPerSidePerContract, spread, fractional: options.fractional ?? false,
    cash: startingCash, position: null, orders: [], trades: [], nextOrderId: 1,
  }
}

export function equity(state: AccountState, lastPrice: number): number {
  const p = state.position
  if (!p) return state.cash
  const mark = p.side === 'sell' ? lastPrice + state.spread : lastPrice   // a short is bought back at the ask
  return state.cash + (mark - p.avgPrice) * state.instrument.pointValue * p.qty * sign(p.side)
}

export interface Fill {
  side: Side; qty: number; price: number; time: number; source: FillSource
  orderId?: number; sl?: number; tp?: number; closeReason: 'manual' | 'sl' | 'tp'
}

export function applyFill(state: AccountState, f: Fill): BrokerResult {
  const events: BrokerEvent[] = [
    { type: 'fill', source: f.source, orderId: f.orderId, side: f.side, qty: f.qty, price: f.price, time: f.time },
  ]
  const pos = state.position
  const commission = cents(state.commission)
  let cash = cents(state.cash - f.qty * commission)
  const sl = f.sl
  const tp = f.tp

  if (!pos || pos.side === f.side) {
    const qty = roundQty((pos?.qty ?? 0) + f.qty)
    const avgPrice = pos ? (pos.avgPrice * pos.qty + f.price * f.qty) / qty : f.price
    const next: Position = {
      side: f.side, qty, avgPrice, openedAt: pos?.openedAt ?? f.time,
      ...((sl ?? pos?.sl) !== undefined && { sl: sl ?? pos?.sl }),
      ...((tp ?? pos?.tp) !== undefined && { tp: tp ?? pos?.tp }),
    }
    return { state: { ...state, cash, position: next }, events }
  }

  const closeQty = Math.min(f.qty, pos.qty)
  const remainder = roundQty(f.qty - closeQty)
  const gross = cents((f.price - pos.avgPrice) * state.instrument.pointValue * closeQty * sign(pos.side))
  cash = cents(cash + gross)
  const trade: ClosedTrade = {
    side: pos.side, qty: closeQty, entry: pos.avgPrice, exit: f.price,
    pnl: cents(gross - 2 * commission * closeQty),
    openedAt: pos.openedAt, closedAt: f.time,
    reason: remainder > 0 ? 'flip' : f.closeReason,
  }
  events.push({ type: 'trade', trade })

  let position: Position | null = null
  if (remainder > 0) {
    position = {
      side: f.side, qty: remainder, avgPrice: f.price, openedAt: f.time,
      ...(sl !== undefined && { sl }), ...(tp !== undefined && { tp }),
    }
  } else if (closeQty < pos.qty) {
    position = { ...pos, qty: roundQty(pos.qty - closeQty) }
  }
  return { state: { ...state, cash, position, trades: [...state.trades, trade] }, events }
}

/** SL must sit on the losing side of `entry` and TP on the winning side for a `side` position/order; undefined when ok. */
export function exitError(side: Side, entry: number, sl: number | undefined, tp: number | undefined): string | undefined {
  const dir = sign(side)
  if (sl !== undefined && !(Number.isFinite(sl) && (entry - sl) * dir > 0)) {
    return side === 'buy' ? 'SL must be below entry for a buy' : 'SL must be above entry for a sell'
  }
  if (tp !== undefined && !(Number.isFinite(tp) && (tp - entry) * dir > 0)) {
    return side === 'buy' ? 'TP must be above entry for a buy' : 'TP must be below entry for a sell'
  }
  return undefined
}

function validate(req: OrderRequest, entry: number | undefined, step: number): string | undefined {
  if (req.side !== 'buy' && req.side !== 'sell') return 'invalid side'
  if (req.type !== 'market' && req.type !== 'limit' && req.type !== 'stop') return 'invalid order type'
  const qErr = qtyError(req.qty, step)
  if (qErr) return qErr
  if (req.type !== 'market' && !(typeof req.price === 'number' && Number.isFinite(req.price) && req.price > 0)) {
    return `${req.type} order needs a positive price`
  }
  if (entry === undefined || !Number.isFinite(entry)) return 'no valid reference price'
  return exitError(req.side, entry, req.sl, req.tp)
}

export function placeOrder(state: AccountState, req: OrderRequest, now: number, lastPrice: number): BrokerResult {
  const tick = state.instrument.tick
  const rnd = (p?: number) => (p === undefined ? undefined : roundToTick(p, tick))
  const price = rnd(req.price)
  const fillAt = req.side === 'buy' && state.spread > 0 ? roundToTick(lastPrice + state.spread, tick) : lastPrice   // market buys pay the ask (rounded: no float dust like 4298.8550000000005)
  const entry = req.type === 'market' ? fillAt : price
  const rounded: OrderRequest = { ...req, qty: roundQty(req.qty), price, sl: rnd(req.sl), tp: rnd(req.tp) }
  const error = validate(rounded, entry, qtyStep(state))
  if (error) return { state, events: [], error }

  const exits = {
    ...(rounded.sl !== undefined && { sl: rounded.sl }),
    ...(rounded.tp !== undefined && { tp: rounded.tp }),
  }
  const id = state.nextOrderId
  const base = { ...state, nextOrderId: id + 1 }

  if (req.type === 'market') {
    return applyFill(base, { side: req.side, qty: rounded.qty, price: fillAt, time: now, source: 'market', orderId: id, closeReason: 'manual', ...exits })
  }
  const order: PendingOrder = { id, side: req.side, type: req.type, qty: rounded.qty, price: price as number, createdAt: now, ...exits }
  return { state: { ...base, orders: [...base.orders, order] }, events: [] }
}

export function cancelOrder(state: AccountState, orderId: number): BrokerResult {
  if (!state.orders.some((o) => o.id === orderId)) return { state, events: [], error: `order ${orderId} not found` }
  return { state: { ...state, orders: state.orders.filter((o) => o.id !== orderId) }, events: [] }
}

export function closePosition(state: AccountState, lastPrice: number, now: number): BrokerResult {
  const pos = state.position
  if (!pos) return { state, events: [], error: 'no open position' }
  const price = pos.side === 'sell' && state.spread > 0 ? roundToTick(lastPrice + state.spread, state.instrument.tick) : lastPrice   // closing a short = buying at the ask
  return applyFill(state, { side: opposite(pos.side), qty: pos.qty, price, time: now, source: 'close', closeReason: 'manual' })
}

/**
 * Fill price for a resting order on this bar, or null if not touched.
 * `ref` is the price that preceded the order's activity: the bar open for orders/positions that
 * existed at the open (gap-through), or the entry fill price for a position opened on this bar.
 */
function triggerPrice(side: Side, type: 'limit' | 'stop', level: number, bar0: Bar, ref0: number = bar0.o, spread = 0, tick = 0.01): number | null {
  // buys trade on the ask: shift the bid bar (and the reference price) up by the spread
  const ask = side === 'buy' && spread > 0
  const sh = (x: number): number => (ask ? roundToTick(x + spread, tick) : x)
  const bar: Bar = ask ? { ...bar0, o: sh(bar0.o), h: sh(bar0.h), l: sh(bar0.l), c: sh(bar0.c) } : bar0
  const ref = sh(ref0)
  if (side === 'buy' && type === 'limit') return bar.l <= level ? Math.min(level, ref) : null
  if (side === 'sell' && type === 'limit') return bar.h >= level ? Math.max(level, ref) : null
  if (side === 'buy') return bar.h >= level ? Math.max(level, ref) : null
  return bar.l <= level ? Math.min(level, ref) : null
}

function checkExits(state: AccountState, bar: Bar, ref: number, atOpen: boolean): BrokerResult {
  const pos = state.position
  if (!pos) return { state, events: [] }
  const exitSide = opposite(pos.side)
  // Exit levels are stops (SL) and limits (TP) on the exit side.
  const slFill = pos.sl === undefined ? null : triggerPrice(exitSide, 'stop', pos.sl, bar, ref, state.spread, state.instrument.tick)
  const tpFill = pos.tp === undefined ? null : triggerPrice(exitSide, 'limit', pos.tp, bar, ref, state.spread, state.instrument.tick)
  const tpAtOpen = atOpen && pos.tp !== undefined && (pos.side === 'buy' ? bar.o >= pos.tp : bar.o + state.spread <= pos.tp)
  const hit = tpFill !== null && tpAtOpen
    ? { price: tpFill, source: 'tp' as const }
    : slFill !== null ? { price: slFill, source: 'sl' as const }
    : tpFill !== null ? { price: tpFill, source: 'tp' as const } : null
  if (!hit) return { state, events: [] }
  return applyFill(state, { side: exitSide, qty: pos.qty, price: hit.price, time: bar.t, source: hit.source, closeReason: hit.source })
}

/** Advance the broker over one newly revealed bar. */
export function onBar(state: AccountState, bar: Bar): { state: AccountState; events: BrokerEvent[] } {
  const events: BrokerEvent[] = []

  // (1) exits of the position that existed at the open (never on/before the bar it was opened at)
  let current = state
  if (state.position && bar.t > state.position.openedAt) {
    const exited = checkExits(state, bar, bar.o, true)
    current = exited.state
    events.push(...exited.events)
  }

  // (2) pending orders, id order; never on/before the bar they were placed on
  const pendingFills: BrokerEvent[] = []
  for (const o of state.orders) {
    if (bar.t <= o.createdAt) continue
    const price = triggerPrice(o.side, o.type, o.price, bar, bar.o, state.spread, state.instrument.tick)
    if (price === null) continue
    const filled = applyFill(
      { ...current, orders: current.orders.filter((x) => x.id !== o.id) },
      { side: o.side, qty: o.qty, price, time: bar.t, source: o.type, orderId: o.id, closeReason: 'manual', sl: o.sl, tp: o.tp },
    )
    current = filled.state
    events.push(...filled.events)
    pendingFills.push(...filled.events)
  }

  // (3) exits of a position opened/added on this bar, from its entry fill (no gap-through at open)
  const side = current.position?.side
  const entry = [...pendingFills].reverse().find((e) => e.type === 'fill' && e.side === side)
  if (current.position && entry?.type === 'fill') {
    const exited = checkExits(current, bar, entry.price, false)
    current = exited.state
    events.push(...exited.events)
  }
  return { state: current, events }
}
