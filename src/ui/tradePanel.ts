import type { ClosedTrade, OrderRequest, OrderType } from '../types'
import type { Stats } from '../broker/stats'
import { cls, h, money } from './dom'
import { displayStep, exitPrice, convertUnit, nextUnit, previewLine, rrTarget, sizeHint, toContracts, unitText, type ExitCtx, type ExitUnit } from './orderForm'
import { mountPositionCard, type CardHandlers, type CardView, type Result } from './positionCard'

export interface TradeView extends CardView {
  /** price decimals, tick, and the SL/TP/spread unit (pips for forex/gold, points for futures) come from CardView */
  contractNote?: string
  /** account was created with the 'Fractional sizes (simulation)' switch */
  fractional?: boolean
  /** fixed spread of the current account, in `unit`s */
  spreadUnits: number
  startCash: number; equity: number; cash: number
  trades: readonly ClosedTrade[]; stats: Stats
}
export interface TradeHandlers extends CardHandlers {
  onOrder(req: OrderRequest): string | undefined
  /** size field changed (contracts); lets chart-originated orders reuse it */
  onSize?(contracts: number): void
  /** `fractional` = state of the 'Fractional sizes (simulation)' checkbox */
  onReset(cash: number, commission: number, spreadUnits: number, fractional?: boolean): void
}

const num = (el: HTMLInputElement): number | undefined => (el.value.trim() === '' ? undefined : Number(el.value))
export type { Result }

interface ExitField { box: HTMLElement; input: HTMLInputElement; unitBtn: HTMLButtonElement; preview: HTMLElement; unit: ExitUnit }

export function mountTradePanel(host: HTMLElement, hd: TradeHandlers): (v: TradeView) => void {
  let view: TradeView | null = null
  let lastRef: number | null = null
  const noEnter = (el: HTMLInputElement): void => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault() })   // Enter must never fire an order

  const qty = h('input', { type: 'number', min: '1', step: '1', value: '1', 'aria-label': 'Size' })
  const qtyHint = h('div', { class: 'tb-dim', style: 'font-size:12px;margin-bottom:6px' })
  const type = h('select', { 'aria-label': 'Order type' }, h('option', { value: 'market' }, 'Market'), h('option', { value: 'limit' }, 'Limit'), h('option', { value: 'stop' }, 'Stop'))
  const price = h('input', { type: 'number', step: '0.25', placeholder: 'Price', 'aria-label': 'Order price' })
  const err = h('div', { class: 'err', role: 'alert' })
  const cash0 = h('input', { type: 'number', min: '1000', step: '1000', value: '50000', 'aria-label': 'Starting capital' })
  const comm = h('input', { type: 'number', min: '0', step: '0.25', value: '0', 'aria-label': 'Commission per contract per side', title: 'Commission per contract per side (USD)' })
  const spreadIn = h('input', { type: 'number', min: '0', step: '0.1', value: '0', 'aria-label': 'Spread' })
  const spreadNote = h('div', { class: 'tb-dim', style: 'font-size:12px' })
  const fracBox = h('input', { type: 'checkbox', 'aria-label': 'Fractional sizes (simulation)' })
  const fracLabel = h('label', { class: 'chk', title: 'SIMULATION: real exchanges trade whole contracts only. Futures accept sizes down to 0.01 contract. Applies on Reset account.' }, fracBox, 'Fractional sizes (simulation)')
  const live = h('div')
  const cardHost = h('div')
  for (const el of [qty, price, cash0, comm, spreadIn]) noEnter(el)

  const contractsNow = (): number => toContracts(Number(qty.value), view?.lotContracts)
  const ctx = (): ExitCtx => ({ unitSize: view?.unitSize ?? 1, pointValue: view?.pointValue ?? 0, contracts: contractsNow(), tick: view?.tick ?? 0.25 })
  const refNow = (): number | undefined => (type.value === 'market' ? lastRef ?? undefined : num(price))

  const exitField = (kind: 'sl' | 'tp'): ExitField => {
    const f = { unit: 'dist' as ExitUnit } as ExitField
    f.input = h('input', { type: 'number', step: '0.25', min: '0', 'aria-label': kind === 'sl' ? 'Stop loss value' : 'Take profit value' })
    f.unitBtn = h('button', { class: 'unit', title: 'Switch unit: distance / price / dollars', onclick: () => {
      const cur = num(f.input), to = nextUnit(f.unit)
      const conv = cur === undefined ? undefined : convertUnit(f.unit, to, cur, refNow() ?? NaN, ctx())
      f.unit = to; f.input.value = conv === undefined ? '' : String(conv)
      paintExit()
    } })
    f.preview = h('div', { class: 'pv' })
    f.input.addEventListener('input', () => paintExit()); noEnter(f.input)
    f.box = h('div', { class: 'xf' }, h('div', { class: 'row' }, f.input, f.unitBtn), f.preview)
    return f
  }
  const sl = exitField('sl'), tp = exitField('tp')
  const paintExit = (): void => {
    const d = view?.unit ?? 'pts'
    for (const [k, f] of [['sl', sl], ['tp', tp]] as const) {
      f.unitBtn.textContent = unitText(f.unit, d)
      f.input.placeholder = `${k.toUpperCase()} ${unitText(f.unit, d)}`
      f.input.step = f.unit === 'price' ? String(view?.tick ?? 0.25) : f.unit === 'usd' ? '1' : String(Number(((view?.tick ?? 0.25) / (view?.unitSize ?? 1)).toPrecision(6)))
      const v = num(f.input)
      f.preview.textContent = v === undefined ? '' : previewLine(k, f.unit, v, refNow(), ctx(), view?.precision ?? 2, d)
    }
    paintHint()
  }
  const rr = (mult: number): void => {
    const s = num(sl.input)
    const t = s === undefined ? undefined : rrTarget(sl.unit, s, tp.unit, mult, refNow(), ctx())
    if (!t) { err.textContent = 'Set a valid SL (and a price/reference) first.'; return }
    err.textContent = ''; tp.unit = t.unit; tp.input.value = String(t.value); paintExit()
  }
  const rrRow = h('div', { class: 'row rr' }, h('span', { class: 'tb-dim' }, 'R:R'), ...[1, 2, 3].map((m) => h('button', { title: `Set TP to ${m}x the SL distance`, onclick: () => rr(m) }, `${m}R`)))

  const send = (side: 'buy' | 'sell') => {
    const t = type.value as OrderType
    const ref = refNow()
    const q = contractsNow()
    if (ref === undefined || !Number.isFinite(ref)) { err.textContent = t === 'market' ? 'Start replay first.' : 'Enter a price.'; return }
    if (!(q > 0)) { err.textContent = 'Enter a size.'; return }
    const slv = num(sl.input), tpv = num(tp.input)
    // market buys are measured from the ask; distances/dollars are measured from `ref`, price fields are taken literally
    const from = t === 'market' && side === 'buy' ? ref + (view?.spreadUnits ?? 0) * (view?.unitSize ?? 1) : ref
    const c = { ...ctx(), contracts: q }
    const slP = slv === undefined ? undefined : exitPrice('sl', side, from, sl.unit, slv, c)
    const tpP = tpv === undefined ? undefined : exitPrice('tp', side, from, tp.unit, tpv, c)
    if ((slv !== undefined && slP === undefined) || (tpv !== undefined && tpP === undefined)) { err.textContent = 'Invalid SL/TP value.'; return }
    const req: OrderRequest = { side, type: t, qty: q, ...(t !== 'market' ? { price: num(price) } : {}), ...(slP !== undefined ? { sl: slP } : {}), ...(tpP !== undefined ? { tp: tpP } : {}) }
    err.textContent = hd.onOrder(req) ?? ''
  }
  const paintHint = (): void => {
    if (!view) return
    qtyHint.textContent = sizeHint(Number(qty.value), view)
    qty.title = view.contractNote ? `Size: ${view.contractNote}` : 'Size in contracts'
  }
  qty.addEventListener('input', () => { paintExit(); const c = contractsNow(); if (c > 0) hd.onSize?.(c) })
  price.addEventListener('input', paintExit)
  const buy = h('button', { class: 'buy', onclick: () => send('buy') }, 'Buy')
  const sell = h('button', { class: 'sell', onclick: () => send('sell') }, 'Sell')
  type.addEventListener('change', () => { price.disabled = type.value === 'market'; paintExit() })
  price.disabled = true

  host.append(
    h('div', { class: 'sec' }, h('h3', {}, 'Order'),
      h('div', { class: 'row' }, qty, type), qtyHint, h('div', { class: 'row' }, price),
      sl.box, tp.box, rrRow, h('div', { class: 'row' }, sell, buy), err),
    cardHost, live,
    h('div', { class: 'sec' }, h('h3', {}, 'Paper account'),
      h('div', { class: 'row' }, cash0, comm),
      h('div', { class: 'row' }, spreadIn), spreadNote, h('div', { class: 'row' }, fracLabel),
      h('div', { class: 'row' }, h('button', { onclick: () => hd.onReset(Number(cash0.value), Number(comm.value), Number(spreadIn.value) || 0, fracBox.checked) }, 'Reset account'))),
  )
  const paintCard = mountPositionCard(cardHost, hd)

  return (v) => {
    lastRef = v.last
    const symbolChanged = view?.symbol !== v.symbol
    view = v
    const step = displayStep(v)
    qty.min = qty.step = String(step)
    if (symbolChanged) { qty.value = String(step); fracBox.checked = !!v.fractional; hd.onSize?.(toContracts(step, v.lotContracts)) }
    qty.setAttribute('aria-label', v.lotContracts ? 'Size in lots' : 'Size in contracts')
    price.step = String(v.tick)
    spreadIn.step = String(Number((v.tick / v.unitSize).toPrecision(6)))
    spreadIn.placeholder = `Spread ${v.unit}`
    spreadIn.title = `Fixed spread in ${v.unit}, applied to buys (ask = bid + spread). 0 = bid prices only: Dukascopy candles are BID and spread is NOT modelled.`
    if (symbolChanged || document.activeElement !== spreadIn) spreadIn.value = String(Number(v.spreadUnits.toPrecision(6)))
    spreadNote.textContent = v.spreadUnits > 0 ? `Buys fill at bid + ${v.spreadUnits} ${v.unit}.` : v.unitSize !== 1 ? 'Spread not modelled: fills at bid prices.' : ''
    fracBox.disabled = !!v.lotContracts   // forex/gold are already sized in 0.01 lots
    paintExit()
    buy.disabled = sell.disabled = !v.replayActive
    paintCard(v)
    const s = v.stats
    const hist = v.trades.slice(-8).reverse().map((t) => h('tr', {}, h('td', {}, t.side === 'buy' ? 'Long' : 'Short'), h('td', {}, v.lotContracts ? (t.qty / v.lotContracts).toFixed(2) : String(t.qty)), h('td', {}, `${t.entry.toFixed(v.precision)}→${t.exit.toFixed(v.precision)}`), h('td', { class: cls(t.pnl) }, money(t.pnl)), h('td', { class: 'tb-dim' }, t.reason)))
    const kv = (a: string, b: string | Node, c = '') => h('div', { class: 'kv' }, h('span', {}, a), h('span', { class: c }, b))
    live.replaceChildren(
      h('div', { class: 'sec' }, h('h3', {}, v.symbol + ' account'),
        kv('Equity', money(v.equity), cls(v.equity - v.startCash)), kv('Balance', money(v.cash)), kv('Open P&L', money(v.openPnl), cls(v.openPnl)),
        v.unitSize === 1 ? kv('Point value', money(v.pointValue)) : kv(`Value per ${v.unit.replace(/s$/, '')} / contract`, money(v.pointValue * v.unitSize))),
      h('div', { class: 'sec' }, h('h3', {}, 'Statistics'),
        kv('Trades', String(s.trades)), kv('Win rate', s.trades ? (s.winRate * 100).toFixed(1) + '%' : '–'),
        kv('Profit factor', s.profitFactor === null ? '–' : s.profitFactor.toFixed(2)), kv('Expectancy', s.trades ? money(s.expectancy) : '–'),
        kv('Net P&L', money(s.netPnl), cls(s.netPnl)), kv('Max drawdown', `${money(s.maxDrawdown)} (${s.maxDrawdownPct.toFixed(1)}%)`)),
      h('div', { class: 'sec' }, h('h3', {}, 'Trade history'),
        h('table', {}, h('tr', {}, h('th', {}, 'Side'), h('th', {}, v.lotContracts ? 'Lots' : 'Qty'), h('th', {}, 'In→Out'), h('th', {}, 'P&L'), h('th', {}, 'Why')), ...(hist.length ? hist : [h('tr', {}, h('td', { colspan: '5', class: 'tb-dim' }, 'No closed trades yet'))]))),
    )
  }
}
