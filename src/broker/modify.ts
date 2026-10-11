/**
 * Editing live positions/orders (TradingView-style drag of SL/TP/limit lines, partial close). Pure, immutable.
 * Re-exported from ./broker; the import below is a cycle that is only used inside functions (safe in ESM).
 *
 * Patch semantics: key absent or undefined = leave unchanged, number = set (tick-rounded), null = remove.
 * Side-of-market uses the exit-side price: a short is closed (and its SL/TP triggered) on the ask = lastPrice + spread.
 */
import type { Side } from '../types'
import {
  applyFill, closePosition, exitError, opposite, qtyError, qtyStep, roundQty, roundToTick,
  type AccountState, type BrokerResult, type PendingOrder,
} from './broker'

export type ExitPatch = { sl?: number | null; tp?: number | null }

const fail = (state: AccountState, error: string): BrokerResult => ({ state, events: [], error })
const validPrice = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0

/** Applies a patch to one optional level: undefined keeps, null removes, number sets (rounded). Returns an error text for bad numbers. */
function patchLevel(cur: number | undefined, patch: number | null | undefined, tick: number, name: string): { value: number | undefined } | { error: string } {
  if (patch === undefined) return { value: cur }
  if (patch === null) return { value: undefined }
  if (!validPrice(patch)) return { error: `invalid ${name} price` }
  return { value: roundToTick(patch, tick) }
}

/** Sets / moves / removes the open position's SL and TP. SL must be on the losing side of the market, TP on the winning side. */
export function modifyPosition(state: AccountState, patch: ExitPatch, lastPrice: number): BrokerResult {
  const pos = state.position
  if (!pos) return fail(state, 'no open position')
  if (!Number.isFinite(lastPrice)) return fail(state, 'no valid reference price')
  const tick = state.instrument.tick
  const sl = patchLevel(pos.sl, patch.sl, tick, 'SL')
  if ('error' in sl) return fail(state, sl.error)
  const tp = patchLevel(pos.tp, patch.tp, tick, 'TP')
  if ('error' in tp) return fail(state, tp.error)
  // only the levels being set are checked against the market; untouched ones may already be in the money (e.g. a trailed-through TP)
  const ref = pos.side === 'sell' ? roundToTick(lastPrice + state.spread, tick) : lastPrice
  const error = exitError(pos.side, ref, typeof patch.sl === 'number' ? sl.value : undefined, typeof patch.tp === 'number' ? tp.value : undefined)
  if (error) return fail(state, error)
  const { sl: _sl, tp: _tp, ...rest } = pos
  const position = { ...rest, ...(sl.value !== undefined && { sl: sl.value }), ...(tp.value !== undefined && { tp: tp.value }) }
  return { state: { ...state, position }, events: [] }
}

/** Order types need their trigger on a specific side of the market: buy limit / sell stop below it, sell limit / buy stop above. */
function sideOfMarketError(o: Pick<PendingOrder, 'side' | 'type'>, price: number, ref: number): string | undefined {
  const below = (o.side === 'buy') === (o.type === 'limit')   // buy limit, sell stop
  if (below ? price < ref : price > ref) return undefined
  return `${o.side} ${o.type} must be ${below ? 'below' : 'above'} the market`
}

/** Moves a pending limit/stop and/or edits the SL/TP it will carry onto the position when filled. */
export function modifyOrder(
  state: AccountState, orderId: number, patch: ExitPatch & { price?: number }, lastPrice: number,
): BrokerResult {
  const o = state.orders.find((x) => x.id === orderId)
  if (!o) return fail(state, `order ${orderId} not found`)
  if (!Number.isFinite(lastPrice)) return fail(state, 'no valid reference price')
  const tick = state.instrument.tick
  let price = o.price
  if (patch.price !== undefined) {
    if (!validPrice(patch.price)) return fail(state, `${o.type} order needs a positive price`)
    price = roundToTick(patch.price, tick)
    const ref = o.side === 'buy' && state.spread > 0 ? roundToTick(lastPrice + state.spread, tick) : lastPrice   // buys trade on the ask
    const e = sideOfMarketError(o, price, ref)
    if (e) return fail(state, e)
  }
  const sl = patchLevel(o.sl, patch.sl, tick, 'SL')
  if ('error' in sl) return fail(state, sl.error)
  const tp = patchLevel(o.tp, patch.tp, tick, 'TP')
  if ('error' in tp) return fail(state, tp.error)
  // exits are measured from the order's (possibly new) trigger price; moving the order under an existing SL/TP is rejected, not silently dropped
  const error = exitError(o.side, price, sl.value, tp.value)
  if (error) return fail(state, error)
  const { sl: _sl, tp: _tp, ...rest } = o
  const next: PendingOrder = { ...rest, price, ...(sl.value !== undefined && { sl: sl.value }), ...(tp.value !== undefined && { tp: tp.value }) }
  return { state: { ...state, orders: state.orders.map((x) => (x.id === orderId ? next : x)) }, events: [] }
}

/** Closes `qty` of the position at the market (manual). qty == position size closes it fully; SL/TP of the remainder are kept. */
export function closePartial(state: AccountState, qty: number, lastPrice: number, now: number): BrokerResult {
  const pos = state.position
  if (!pos) return fail(state, 'no open position')
  const q = roundQty(qty)
  const err = qtyError(q, qtyStep(state))
  if (err) return fail(state, err)
  if (q > pos.qty) return fail(state, `cannot close ${q}: position is ${pos.qty}`)
  if (q === pos.qty) return closePosition(state, lastPrice, now)
  const exitSide: Side = opposite(pos.side)
  const price = pos.side === 'sell' && state.spread > 0 ? roundToTick(lastPrice + state.spread, state.instrument.tick) : lastPrice
  return applyFill(state, { side: exitSide, qty: q, price, time: now, source: 'close', closeReason: 'manual' })
}
