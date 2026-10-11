// Glue between the broker (pure) and its two UIs (chart trade lines, side panel). No DOM / klinecharts: unit-testable in node.
import type { OrderRequest } from './types'
import {
  cancelOrder, closePartial, closePosition, modifyOrder, modifyPosition, placeOrder,
  type AccountState, type BrokerResult,
} from './broker/broker'
import { pricePrecision, unitLabel, unitSize } from './instruments'
import type { ChartOrderRequest, TradeLinesView, TradeOverlayCallbacks } from './chart/tradeTypes'

export interface LastBar { t: number; c: number }

/** What the chart overlay needs, derived from the account (forex/gold are shown in lots, futures in contracts). */
export function linesView(account: AccountState, last: number | null): TradeLinesView {
  const i = account.instrument
  return {
    pointValue: i.pointValue, precision: pricePrecision(i), lastPrice: last,
    position: account.position, orders: account.orders,
    unit: i.lotContracts ? 'lots' : 'contracts', lotFactor: i.lotContracts ? 1 / i.lotContracts : 1,
    tick: i.tick, distUnit: unitLabel(i), distSize: unitSize(i),
  }
}

export interface TradeCtx {
  account(): AccountState
  set(a: AccountState): void
  last(): LastBar | null
  /** re-render panel + chart lines; called after EVERY attempted mutation */
  changed(): void
  /** non-panel feedback (chart actions have no error field) */
  say(msg: string): void
  /** size in contracts used by chart-originated orders (mirrors the panel's size field) */
  size(): number
}

type Patch = { sl?: number | null; tp?: number | null }

export function tradeActions(ctx: TradeCtx) {
  const run = (fn: (a: AccountState, l: LastBar) => BrokerResult): string | undefined => {
    const l = ctx.last()
    if (!l) return 'Start replay first.'
    const r = fn(ctx.account(), l)
    if (!r.error) ctx.set(r.state)
    ctx.changed()
    return r.error
  }
  const act = {
    order: (req: OrderRequest) => run((a, l) => placeOrder(a, req, l.t, l.c)),
    close: () => run((a, l) => closePosition(a, l.c, l.t)),
    cancel: (id: number) => run((a) => cancelOrder(a, id)),
    modifyPosition: (p: Patch) => run((a, l) => modifyPosition(a, p, l.c)),
    modifyOrder: (id: number, p: Patch & { price?: number }) => run((a, l) => modifyOrder(a, id, p, l.c)),
    partial: (q: number) => run((a, l) => closePartial(a, q, l.c, l.t)),
  }
  const report = (e: string | undefined): void => { if (e) ctx.say(e) }
  const chart: TradeOverlayCallbacks = {
    onMoveSl: (price) => report(act.modifyPosition({ sl: price })),
    onMoveTp: (price) => report(act.modifyPosition({ tp: price })),
    onRemoveSl: () => report(act.modifyPosition({ sl: null })),
    onRemoveTp: () => report(act.modifyPosition({ tp: null })),
    onMoveOrder: (id, price) => report(act.modifyOrder(id, { price })),
    onCancelOrder: (id) => report(act.cancel(id)),
    onClosePosition: () => report(act.close()),
    onChartOrder: (r: ChartOrderRequest) => report(act.order({ side: r.side, type: r.type, qty: ctx.size(), ...(r.price !== undefined ? { price: r.price } : {}) })),
  }
  const panel = {
    onOrder: act.order,
    onClose: () => { report(act.close()) },
    onCancel: (id: number) => { report(act.cancel(id)) },
    onModifyPosition: act.modifyPosition,
    onModifyOrder: act.modifyOrder,
    onClosePartial: act.partial,
  }
  return { chart, panel }
}
