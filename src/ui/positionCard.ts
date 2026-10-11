// Open-position card + pending-order rows. Built once and patched in place on every repaint, so inputs never lose focus mid-edit.
import type { OrderRequest, Position } from '../types'
import { roundQty, type PendingOrder } from '../broker/broker'
import { cls, h, money } from './dom'
import { fmtSize, pnlAt, toContracts, toDisplay, displayStep, type SizeCtx } from './orderForm'

export type Result = string | undefined | void
export interface ExitPatch { sl?: number | null; tp?: number | null }
export interface CardView extends SizeCtx {
  last: number | null; precision: number; tick: number; openPnl: number
  position: Position | null; orders: readonly PendingOrder[]; replayActive: boolean
}
export interface CardHandlers {
  onClose(): void; onCancel(id: number): void; onOrder(req: OrderRequest): Result
  onModifyPosition?(patch: ExitPatch): Result
  onModifyOrder?(id: number, patch: { price?: number; sl?: number | null; tp?: number | null }): Result
  onClosePartial?(qty: number): Result
}

const setIdle = (el: HTMLInputElement, text: string): void => { if (document.activeElement !== el && el.value !== text) el.value = text }

/** Price input committing on Enter/blur: '' -> `onClear` (when allowed), a number -> `onSet`; Escape or a rejected value reverts. */
function priceInput(label: string, tick: number, model: () => number | undefined, fmt: (p: number) => string, onSet: (p: number) => Result, onClear: (() => Result) | null, say: (m: string) => void): HTMLInputElement {
  const input = h('input', { type: 'number', step: String(tick), min: '0', 'aria-label': label, placeholder: onClear ? 'none' : '' })
  const revert = (): void => { const m = model(); input.value = m === undefined ? '' : fmt(m) }
  input.addEventListener('change', () => {
    const raw = input.value.trim()
    const n = Number(raw)
    if (raw === '' ? !onClear : !(Number.isFinite(n) && n > 0)) { say(raw === '' ? 'Price required.' : 'Invalid price.'); revert(); return }
    const m = model()
    if (raw === '' ? m === undefined : m === n) return
    const e = raw === '' ? onClear!() : onSet(n)
    say(e ?? '')
    if (e) revert()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur() }
    else if (e.key === 'Escape') { revert(); input.blur() }
  })
  return input
}

export function mountPositionCard(host: HTMLElement, hd: CardHandlers): (v: CardView) => void {
  let v: CardView | null = null
  const fmt = (p: number): string => p.toFixed(v?.precision ?? 2)
  const err = h('div', { class: 'err', role: 'alert' })
  const say = (m: string): void => { err.textContent = m }

  // ---- position card ----
  const title = h('b'), avg = h('span', { class: 'tb-dim' }), pnl = h('b')
  const slIn = priceInput('Position stop loss price', 0.25, () => v?.position?.sl, fmt, (p) => hd.onModifyPosition?.({ sl: p }), () => hd.onModifyPosition?.({ sl: null }), say)
  const tpIn = priceInput('Position take profit price', 0.25, () => v?.position?.tp, fmt, (p) => hd.onModifyPosition?.({ tp: p }), () => hd.onModifyPosition?.({ tp: null }), say)
  const slMeta = h('span', { class: 'pv' }), tpMeta = h('span', { class: 'pv' })
  const slX = h('button', { class: 'x', title: 'Remove stop loss', 'aria-label': 'Remove stop loss', onclick: () => say(hd.onModifyPosition?.({ sl: null }) ?? '') }, '✕')
  const tpX = h('button', { class: 'x', title: 'Remove take profit', 'aria-label': 'Remove take profit', onclick: () => say(hd.onModifyPosition?.({ tp: null }) ?? '') }, '✕')
  const exitRow = (name: string, input: HTMLInputElement, x: HTMLButtonElement, meta: HTMLElement): HTMLElement =>
    h('div', { class: 'xrow' }, h('span', { class: 'xl' }, name), input, x, meta)
  const closeBtn = h('button', { title: 'Close the whole position at market', onclick: () => hd.onClose() }, 'Close')
  const halfBtn = h('button', { title: 'Close half of the position' }, '½')
  const partQty = h('input', { type: 'number', min: '0', 'aria-label': 'Partial close size', placeholder: 'size' })
  const partBtn = h('button', { title: 'Close this size at market' }, 'Close size')
  const revBtn = h('button', { title: 'Close and open the opposite side with the same size' }, 'Reverse')
  const callPartial = (q: number): void => say(hd.onClosePartial?.(q) ?? '')
  halfBtn.addEventListener('click', () => {
    const p = v?.position
    if (!p) return
    const step = v?.qtyStep ?? 1
    callPartial(roundQty(Math.floor(p.qty / 2 / step + 1e-9) * step))
  })
  partBtn.addEventListener('click', () => {
    const q = toContracts(Number(partQty.value), v?.lotContracts)
    if (!(q > 0)) { say('Enter a size to close.'); return }
    callPartial(q)
  })
  partQty.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault() })
  revBtn.addEventListener('click', () => {
    const p = v?.position
    if (p) say(hd.onOrder({ side: p.side === 'buy' ? 'sell' : 'buy', type: 'market', qty: roundQty(p.qty * 2) }) ?? '')   // one flip fill: closes, opens the remainder opposite
  })
  const card = h('div', { class: 'sec pcard', hidden: true },
    h('h3', {}, 'Open position'),
    h('div', { class: 'kv' }, title, avg), h('div', { class: 'kv' }, h('span', {}, 'P&L'), pnl),
    exitRow('SL', slIn, slX, slMeta), exitRow('TP', tpIn, tpX, tpMeta),
    h('div', { class: 'row' }, closeBtn, halfBtn, revBtn), h('div', { class: 'row' }, partQty, partBtn))

  // ---- pending orders ----
  const rows = new Map<number, { row: HTMLElement; label: HTMLElement; meta: HTMLElement; input: HTMLInputElement }>()
  const ordersBox = h('div', { class: 'sec', hidden: true }, h('h3', {}, 'Pending orders'))
  const orderRow = (id: number): { row: HTMLElement; label: HTMLElement; meta: HTMLElement; input: HTMLInputElement } => {
    const model = (): number | undefined => v?.orders.find((o) => o.id === id)?.price
    const input = priceInput('Order price', 0.25, model, fmt, (p) => hd.onModifyOrder?.(id, { price: p }), null, say)
    const label = h('span', { class: 'xl' }), meta = h('span', { class: 'pv' })
    const x = h('button', { class: 'x', title: 'Cancel order', 'aria-label': 'Cancel order', onclick: () => hd.onCancel(id) }, '✕')
    return { row: h('div', { class: 'xrow' }, label, input, x, meta), label, meta, input }
  }

  host.append(card, ordersBox, err)

  return (view) => {
    v = view
    const p = view.position
    const px = view.last
    card.hidden = !p
    if (p) {
      const long = p.side === 'buy'
      title.textContent = `${long ? 'Long' : 'Short'} ${fmtSize(p.qty, view)}${view.lotContracts ? '' : ' ' + view.symbol.split(' ')[0]}`
      avg.textContent = `@ ${fmt(p.avgPrice)}`
      const moved = px === null ? 0 : (px - p.avgPrice) * (long ? 1 : -1) / view.unitSize
      pnl.className = cls(view.openPnl)
      pnl.textContent = `${money(view.openPnl)} · ${moved >= 0 ? '+' : ''}${moved.toFixed(1)} ${view.unit}`
      slIn.step = tpIn.step = String(view.tick)
      setIdle(slIn, p.sl === undefined ? '' : fmt(p.sl)); setIdle(tpIn, p.tp === undefined ? '' : fmt(p.tp))
      const meta = (lvl: number | undefined): string => (lvl === undefined ? '' : money(pnlAt(p.side, p.avgPrice, lvl, view.pointValue, p.qty)))
      slMeta.textContent = meta(p.sl); slMeta.className = 'pv ' + cls(p.sl === undefined ? 0 : pnlAt(p.side, p.avgPrice, p.sl, view.pointValue, p.qty))
      tpMeta.textContent = meta(p.tp); tpMeta.className = 'pv ' + cls(p.tp === undefined ? 0 : pnlAt(p.side, p.avgPrice, p.tp, view.pointValue, p.qty))
      slX.disabled = p.sl === undefined || !hd.onModifyPosition; tpX.disabled = p.tp === undefined || !hd.onModifyPosition
      slIn.disabled = tpIn.disabled = !hd.onModifyPosition
      const step = view.qtyStep ?? 1
      halfBtn.disabled = !hd.onClosePartial || Math.floor(p.qty / 2 / step + 1e-9) < 1
      partBtn.disabled = partQty.disabled = !hd.onClosePartial
      partQty.step = String(displayStep(view)); partQty.max = String(toDisplay(p.qty, view.lotContracts))
      partQty.placeholder = view.lotContracts ? 'lots' : 'size'
      revBtn.disabled = !view.replayActive
    }
    ordersBox.hidden = view.orders.length === 0
    const live = new Set(view.orders.map((o) => o.id))
    for (const [id, r] of rows) if (!live.has(id)) { r.row.remove(); rows.delete(id) }
    for (const o of view.orders) {
      let r = rows.get(o.id)
      if (!r) { r = orderRow(o.id); rows.set(o.id, r); ordersBox.append(r.row) }
      r.label.textContent = `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.type} ${fmtSize(o.qty, view)}`
      r.input.step = String(view.tick); r.input.disabled = !hd.onModifyOrder
      setIdle(r.input, fmt(o.price))
      r.meta.textContent = [o.sl !== undefined ? `SL ${fmt(o.sl)}` : '', o.tp !== undefined ? `TP ${fmt(o.tp)}` : ''].filter(Boolean).join(' · ')
    }
  }
}
