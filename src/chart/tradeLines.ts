import { TV } from './theme'
import { formatTag } from './tradeMath'
import type { TradeLinesView } from './tradeTypes'

export type LineKind = 'pos' | 'sl' | 'tp' | 'ord'

/** Everything one trade line needs to render; stored in the overlay's extendData. */
export interface LineData {
  id: string
  kind: LineKind
  price: number
  text: string
  lineColor: string
  tagColor: string
  tagShade: string      // darker tone of the tag colour, used for the ✕ box
  dashed: boolean
  draggable: boolean
  closable: boolean
  precision: number
  orderId?: number
}

const BLUE = { c: TV.accent, s: '#1e4fd6' }
const GREEN = { c: TV.up, s: '#067a67' }
const RED = { c: TV.down, s: '#c32b39' }
const GREY = { c: '#787b86', s: '#5b5f6b' }

/** Stable ids: 'pos', 'sl', 'tp', 'ord-<id>' (+ '-sl' / '-tp' for exits attached to a pending order). */
export function buildLines(view: TradeLinesView): LineData[] {
  const out: LineData[] = []
  const common = { precision: view.precision }
  const p = view.position
  if (p) {
    const live = view.lastPrice === null ? 0 : (view.lastPrice - p.avgPrice) * (p.side === 'buy' ? 1 : -1)
    const tag = view.lastPrice === null ? BLUE : live >= 0 ? GREEN : RED
    out.push({ ...common, id: 'pos', kind: 'pos', price: p.avgPrice, text: formatTag(view, { kind: 'pos' }), lineColor: BLUE.c, tagColor: tag.c, tagShade: tag.s, dashed: false, draggable: false, closable: true })
    if (p.sl != null) out.push({ ...common, id: 'sl', kind: 'sl', price: p.sl, text: formatTag(view, { kind: 'sl', price: p.sl }), lineColor: RED.c, tagColor: RED.c, tagShade: RED.s, dashed: false, draggable: true, closable: true })
    if (p.tp != null) out.push({ ...common, id: 'tp', kind: 'tp', price: p.tp, text: formatTag(view, { kind: 'tp', price: p.tp }), lineColor: GREEN.c, tagColor: GREEN.c, tagShade: GREEN.s, dashed: false, draggable: true, closable: true })
  }
  for (const o of view.orders) {
    const c = o.side === 'buy' ? BLUE : GREY
    out.push({ ...common, id: `ord-${o.id}`, kind: 'ord', orderId: o.id, price: o.price, text: formatTag(view, { kind: 'ord', order: o }), lineColor: c.c, tagColor: c.c, tagShade: c.s, dashed: true, draggable: true, closable: true })
    // exits attached to a pending order: shown for reference, not draggable (the broker contract moves them with the fill)
    if (o.sl != null) out.push({ ...common, id: `ord-${o.id}-sl`, kind: 'sl', orderId: o.id, price: o.sl, text: formatTag(view, { kind: 'sl', price: o.sl, order: o }), lineColor: RED.c, tagColor: RED.c, tagShade: RED.s, dashed: true, draggable: false, closable: false })
    if (o.tp != null) out.push({ ...common, id: `ord-${o.id}-tp`, kind: 'tp', orderId: o.id, price: o.tp, text: formatTag(view, { kind: 'tp', price: o.tp, order: o }), lineColor: GREEN.c, tagColor: GREEN.c, tagShade: GREEN.s, dashed: true, draggable: false, closable: false })
  }
  return out
}
