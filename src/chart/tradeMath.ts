import type { PendingOrder } from '../broker/broker'
import type { Side } from '../types'
import type { TradeLinesView } from './tradeTypes'

// Pure P&L / label / snapping helpers for the trade overlay (no klinecharts import, so they run in node tests).

const EPS = 1e-9
const round = (x: number, digits: number): number => Number(x.toFixed(digits))

export const tickOf = (v: Pick<TradeLinesView, 'tick' | 'precision'>): number =>
  v.tick !== undefined && v.tick > 0 ? v.tick : 10 ** -v.precision

export function snapToTick(price: number, tick: number): number {
  return round(Math.round(price / tick) * tick, 10)
}

/** Unrealised P&L in USD of `qty` contracts opened at `entry`, marked at `price`; rounded to cents. */
export function pnlOf(side: Side, qty: number, entry: number, price: number, pointValue: number): number {
  const dir = side === 'buy' ? 1 : -1
  const cents = Math.round((price - entry) * dir * qty * pointValue * 100) / 100
  return cents === 0 ? 0 : cents // never -0
}

/** P&L of the open position if price were `price` (0 without a position). */
export function pnlAt(view: Pick<TradeLinesView, 'position' | 'pointValue'>, price: number): number {
  const p = view.position
  return p ? pnlOf(p.side, p.qty, p.avgPrice, price, view.pointValue) : 0
}

export function formatMoney(v: number): string {
  const abs = Math.abs(v) < 0.005 ? 0 : Math.abs(v)
  return `${v < 0 && abs !== 0 ? '-' : '+'}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export const formatPrice = (p: number, precision: number): string =>
  p.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision })

export function formatSize(view: Pick<TradeLinesView, 'unit' | 'lotFactor'>, qty: number): string {
  const n = String(round(qty * view.lotFactor, 8))
  return view.unit === 'contracts' ? n : `${n} ${view.unit}`
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export type TagSpec =
  | { kind: 'pos' }
  | { kind: 'sl' | 'tp'; price: number; order?: PendingOrder }
  | { kind: 'ord'; order: PendingOrder; price?: number }

/** Tag text, e.g. 'Long 2 · +$120.00', 'SL  -$80.00 · 20 pts', 'TP +$160.00 · 40 pts', 'Buy Limit 1 @ 31,200.00'. */
export function formatTag(view: TradeLinesView, spec: TagSpec): string {
  if (spec.kind === 'pos') {
    const p = view.position
    if (!p) return ''
    const head = `${p.side === 'buy' ? 'Long' : 'Short'} ${formatSize(view, p.qty)}`
    return view.lastPrice === null ? head : `${head} · ${formatMoney(pnlAt(view, view.lastPrice))}`
  }
  if (spec.kind === 'ord') {
    const price = spec.price ?? spec.order.price
    return `${cap(spec.order.side)} ${cap(spec.order.type)} ${formatSize(view, spec.order.qty)} @ ${formatPrice(price, view.precision)}`
  }
  const owner = spec.order
    ? { side: spec.order.side, qty: spec.order.qty, entry: spec.order.price }
    : view.position && { side: view.position.side, qty: view.position.qty, entry: view.position.avgPrice }
  if (!owner) return ''
  const pnl = pnlOf(owner.side, owner.qty, owner.entry, spec.price, view.pointValue)
  const dist = round(Math.abs(spec.price - owner.entry) / (view.distSize ?? 1), 2)
  const head = spec.kind === 'sl' ? 'SL ' : 'TP' // 'SL ' is padded so the amounts align like in the spec
  return `${head} ${formatMoney(pnl)} · ${dist} ${view.distUnit ?? 'pts'}`
}

// ---- drag constraints ----
export interface Bounds { min: number; max: number }
const strictlyAbove = (ref: number, tick: number): number => (Math.floor(ref / tick + EPS) + 1) * tick
const strictlyBelow = (ref: number, tick: number): number => (Math.ceil(ref / tick - EPS) - 1) * tick

/**
 * Valid price range for dragging a line: SL on the losing and TP on the winning side of the last price
 * (for the position's direction); a pending order on its own side of the market. Mirrors broker validation.
 */
export function dragBounds(view: TradeLinesView, kind: 'sl' | 'tp' | 'ord', order?: PendingOrder): Bounds {
  const tick = tickOf(view)
  const open: Bounds = { min: tick, max: Number.POSITIVE_INFINITY }
  if (kind === 'ord') {
    if (!order || view.lastPrice === null) return open
    const above = (order.type === 'limit') === (order.side === 'sell') // sell limit / buy stop sit above the market
    return above ? { min: strictlyAbove(view.lastPrice, tick), max: open.max } : { min: open.min, max: strictlyBelow(view.lastPrice, tick) }
  }
  const p = view.position
  if (!p) return open
  const ref = view.lastPrice ?? p.avgPrice
  const above = (kind === 'tp') === (p.side === 'buy') // long TP / short SL sit above the market
  return above ? { min: strictlyAbove(ref, tick), max: open.max } : { min: open.min, max: strictlyBelow(ref, tick) }
}

/** Snap a raw dragged price to the tick grid and clamp it to the line's valid side. */
export function clampDrag(view: TradeLinesView, kind: 'sl' | 'tp' | 'ord', raw: number, order?: PendingOrder): number {
  const { min, max } = dragBounds(view, kind, order)
  const snapped = snapToTick(raw, tickOf(view))
  return snapToTick(Math.min(max, Math.max(min, snapped)), tickOf(view))
}

// ---- tag geometry (shared by drawing and click hit-testing) ----
export const TAG = { x: 12, size: 11, padX: 6, padY: 4, closeW: 18 } as const
export type Measure = (text: string, size: number) => number
export const estimateWidth: Measure = (text, size) => text.length * size * 0.58

export interface TagLayout { x: number; w: number; h: number; closeX0: number; closeX1: number }
export function tagLayout(text: string, closable: boolean, measure: Measure = estimateWidth): TagLayout {
  const w = TAG.padX * 2 + measure(text, TAG.size)
  const closeX0 = TAG.x + w
  return { x: TAG.x, w, h: TAG.size + TAG.padY * 2, closeX0, closeX1: closable ? closeX0 + TAG.closeW : closeX0 }
}
