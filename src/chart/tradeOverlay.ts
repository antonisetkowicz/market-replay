import { registerOverlay, utils } from 'klinecharts'
import type { Chart, OverlayCreate, OverlayEvent, OverlayFigure } from 'klinecharts'
import { TV } from './theme'
import { buildLines, type LineData } from './tradeLines'
import { clampDrag, formatPrice, formatTag, tagLayout, TAG, estimateWidth, type Measure } from './tradeMath'
import type { TradeLinesView, TradeOverlayCallbacks } from './tradeTypes'

export type { TradeLinesView, TradeOverlayCallbacks, ChartOrderRequest } from './tradeTypes'
export { pnlAt, formatTag, formatMoney, snapToTick, clampDrag, dragBounds } from './tradeMath'
export { mountChartContextMenu } from './tradeMenu'

const NAME = 'tradeLine'
const GROUP = 'trade-lines'
const HIT_HALF = 5 // px above/below the line that still grab it
// right-click is left to the chart context menu (klinecharts would otherwise delete the overlay); double click does nothing
const IGNORED = ['onRightClick', 'onDoubleClick'] as OverlayFigure['ignoreEvent']

interface Applied { sig: string; data: LineData; points: OverlayCreate['points'] }
interface Ctx { view: TradeLinesView | null; cb: TradeOverlayCallbacks | null; applied: Map<string, Applied>; dragId: string | null; syncs: number }
const ctxs = new WeakMap<Chart, Ctx>()

function ctxOf(chart: Chart): Ctx {
  let c = ctxs.get(chart)
  if (!c) { c = { view: null, cb: null, applied: new Map(), dragId: null, syncs: 0 }; ctxs.set(chart, c) }
  return c
}

const measure: Measure = (text, size) => {
  try { return utils.calcTextWidth(text, size, 'normal', TV.font) } catch { return estimateWidth(text, size) } // no canvas (tests)
}

function figures(d: LineData, width: number, y: number): OverlayFigure[] {
  const lay = tagLayout(d.text, d.closable, measure)
  const box = { style: 'fill', size: TAG.size, family: TV.font, weight: 'normal', color: '#fff', borderSize: 0, borderRadius: 2, paddingTop: TAG.padY, paddingBottom: TAG.padY }
  const out: OverlayFigure[] = [
    { key: 'hit', type: 'rect', ignoreEvent: IGNORED, attrs: { x: 0, y: y - HIT_HALF, width, height: HIT_HALF * 2 }, styles: { style: 'fill', color: 'rgba(0,0,0,0)', borderSize: 0 } },
    { key: 'line', type: 'line', ignoreEvent: true, attrs: { coordinates: [{ x: 0, y }, { x: width, y }] }, styles: { style: d.dashed ? 'dashed' : 'solid', color: d.lineColor, size: 1, dashedValue: [5, 4] } },
    { key: 'tag', type: 'text', ignoreEvent: IGNORED, attrs: { x: lay.x, y, text: d.text, align: 'left', baseline: 'middle' }, styles: { ...box, backgroundColor: d.tagColor, paddingLeft: TAG.padX, paddingRight: TAG.padX } },
  ]
  if (d.closable) out.push({ key: 'x', type: 'text', ignoreEvent: IGNORED, attrs: { x: lay.closeX0, y, text: '✕', width: TAG.closeW, align: 'left', baseline: 'middle' }, styles: { ...box, backgroundColor: d.tagShade, paddingLeft: 4, paddingRight: 0 } })
  return out
}

let registered = false

export function registerTradeOverlays(): void {
  if (registered) return
  registered = true
  registerOverlay<LineData>({
    name: NAME,
    totalStep: 1,
    lock: false,
    zLevel: 10,
    fixedZLevel: true,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ overlay, coordinates, bounding }) => {
      const c = coordinates[0]
      return overlay.extendData && c ? figures(overlay.extendData, bounding.width, c.y) : []
    },
    createYAxisFigures: ({ overlay, coordinates, bounding, yAxis }) => {
      const d = overlay.extendData
      const c = coordinates[0]
      if (!d || !c) return []
      const left = yAxis?.isFromZero() ?? false
      return {
        type: 'text', ignoreEvent: true,
        attrs: { x: left ? 0 : bounding.width, y: c.y, text: formatPrice(d.price, d.precision), align: left ? 'left' : 'right', baseline: 'middle' },
        styles: { style: 'fill', color: '#fff', size: TAG.size, family: TV.font, backgroundColor: d.tagColor, borderSize: 0, borderRadius: 2, paddingLeft: 4, paddingRight: 4, paddingTop: 3, paddingBottom: 3 },
      }
    },
    onPressedMoveStart: ({ chart, overlay }) => { ctxOf(chart).dragId = overlay.id },
    onPressedMoving: onMoving,
    onPressedMoveEnd: onMoveEnd,
    onClick: onClick,
  })
}

const orderOf = (view: TradeLinesView, d: LineData) => (d.orderId === undefined ? undefined : view.orders.find((o) => o.id === d.orderId))

/** Live drag: horizontal lock (only `value` is ever set), snap to tick, clamp to the valid side, refresh the tag. */
function onMoving({ chart, overlay }: OverlayEvent<LineData>): void {
  const c = ctxOf(chart)
  const d = overlay.extendData
  const raw = overlay.points[0]?.value
  if (!c.view || !d || !d.draggable || raw === undefined || d.kind === 'pos') return
  const order = orderOf(c.view, d)
  const price = clampDrag(c.view, d.kind, raw, order)
  const text = d.kind === 'ord' && order
    ? formatTag(c.view, { kind: 'ord', order, price })
    : formatTag(c.view, { kind: d.kind, price } as { kind: 'sl' | 'tp'; price: number })
  chart.overrideOverlay({ id: overlay.id, points: [{ value: price }], extendData: { ...d, price, text } })
}

function commit(cb: TradeOverlayCallbacks, d: LineData, price: number): void {
  if (d.kind === 'sl') cb.onMoveSl(price)
  else if (d.kind === 'tp') cb.onMoveTp(price)
  else if (d.kind === 'ord' && d.orderId !== undefined) cb.onMoveOrder(d.orderId, price)
}

function onMoveEnd({ chart, overlay }: OverlayEvent<LineData>): void {
  const c = ctxOf(chart)
  c.dragId = null
  const d = overlay.extendData
  const base = c.applied.get(overlay.id)
  if (!c.cb || !d || !base || d.price === base.data.price) return // a plain click on the tag: nothing moved
  const sig = base.sig
  base.sig = '' // whatever the broker says, the next sync must re-apply the authoritative position of this line
  const before = c.syncs
  commit(c.cb, d, d.price)
  if (c.syncs === before) { // nobody re-synced (commit rejected / app idle): snap the line back now
    chart.overrideOverlay({ id: overlay.id, points: base.points, extendData: base.data })
    base.sig = sig
  }
}

function onClick({ chart, overlay, x }: OverlayEvent<LineData>): void {
  const c = ctxOf(chart)
  const d = overlay.extendData
  if (!c.cb || !d || !d.closable || x === undefined) return
  const lay = tagLayout(d.text, true, measure)
  if (x < lay.closeX0 || x > lay.closeX1) return
  if (d.kind === 'pos') c.cb.onClosePosition()
  else if (d.kind === 'sl') c.cb.onRemoveSl()
  else if (d.kind === 'tp') c.cb.onRemoveTp()
  else if (d.orderId !== undefined) c.cb.onCancelOrder(d.orderId)
}

function toCreate(d: LineData): OverlayCreate<LineData> {
  return {
    id: d.id, groupId: GROUP, name: NAME, lock: !d.draggable, visible: true, zLevel: 10, fixedZLevel: true,
    needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
    points: [{ value: d.price }], extendData: d,
  } as OverlayCreate<LineData>
}

/**
 * Diff the trade lines against what the chart shows (ids 'pos','sl','tp','ord-<id>'): create new, override
 * changed in place (tags update live every replay step), remove vanished. The line being dragged is left alone.
 */
export function syncTradeOverlays(chart: Chart, view: TradeLinesView, cb: TradeOverlayCallbacks): void {
  const c = ctxOf(chart)
  c.view = view
  c.cb = cb
  c.syncs++
  const live = new Set(chart.getOverlays({ groupId: GROUP }).map((o) => o.id)) // self-heals if something else cleared them
  const next = new Map<string, Applied>()
  const created: OverlayCreate<LineData>[] = []
  for (const d of buildLines(view)) {
    const prev = c.applied.get(d.id)
    if (c.dragId === d.id && prev && live.has(d.id)) { next.set(d.id, prev); continue }
    const create = toCreate(d)
    const sig = JSON.stringify(d)
    next.set(d.id, { sig, data: d, points: create.points })
    if (!live.has(d.id)) created.push(create)
    else if (prev?.sig !== sig) chart.overrideOverlay({ id: d.id, lock: create.lock, points: create.points, extendData: d })
  }
  for (const id of live) {
    if (next.has(id)) continue
    chart.removeOverlay({ id })
    if (c.dragId === id) c.dragId = null
  }
  if (created.length) chart.createOverlay(created as OverlayCreate[])
  c.applied = next
}
