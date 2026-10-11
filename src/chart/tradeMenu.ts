import type { Chart, Point } from 'klinecharts'
import { TV } from './theme'
import { formatPrice, snapToTick, tickOf } from './tradeMath'
import type { ChartOrderRequest, TradeLinesView, TradeOverlayCallbacks } from './tradeTypes'

export interface MenuItem { label: string; req: ChartOrderRequest; enabled: boolean }

const CANDLE_PANE = 'candle_pane'

/** Pixel (viewport coords) -> raw price in the candle pane, or null when the pointer is outside it. */
export function pixelToPrice(chart: Chart, clientX: number, clientY: number): number | null {
  const dom = chart.getDom(CANDLE_PANE, 'main')
  if (!dom) return null
  const r = dom.getBoundingClientRect()
  const x = clientX - r.left
  const y = clientY - r.top
  if (x < 0 || y < 0 || x > r.width || y > r.height) return null
  // klinecharts v10: array in, array out; the crosshair action payload has no price so we convert ourselves
  const out = chart.convertFromPixel([{ x, y }], { paneId: CANDLE_PANE }) as Array<Partial<Point>>
  const v = out[0]?.value
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Menu entries for a tick-rounded price; orders on the wrong side of the market are listed but disabled. */
export function contextMenuItems(view: TradeLinesView, rawPrice: number): MenuItem[] {
  const price = snapToTick(rawPrice, tickOf(view))
  const last = view.lastPrice
  const below = last === null || price < last
  const above = last === null || price > last
  const at = ` @ ${formatPrice(price, view.precision)}`
  return [
    { label: 'Buy Market', req: { side: 'buy', type: 'market' }, enabled: true },
    { label: 'Sell Market', req: { side: 'sell', type: 'market' }, enabled: true },
    { label: `Buy Limit${at}`, req: { side: 'buy', type: 'limit', price }, enabled: below },
    { label: `Sell Limit${at}`, req: { side: 'sell', type: 'limit', price }, enabled: above },
    { label: `Buy Stop${at}`, req: { side: 'buy', type: 'stop', price }, enabled: above },
    { label: `Sell Stop${at}`, req: { side: 'sell', type: 'stop', price }, enabled: below },
  ]
}

function buildMenu(items: MenuItem[], onPick: (req: ChartOrderRequest) => void): HTMLDivElement {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  Object.assign(menu.style, {
    position: 'fixed', zIndex: '10000', minWidth: '210px', padding: '4px 0', background: TV.panel, color: TV.text,
    border: `1px solid ${TV.border}`, borderRadius: '6px', boxShadow: '0 6px 24px rgba(0,0,0,.5)', font: `13px ${TV.font}`, userSelect: 'none',
  })
  items.forEach((it, i) => {
    if (i === 2) { // separator between market and pending orders
      const hr = document.createElement('div')
      Object.assign(hr.style, { height: '1px', margin: '4px 0', background: TV.border })
      menu.append(hr)
    }
    const row = document.createElement('div')
    row.setAttribute('role', 'menuitem')
    row.textContent = it.label
    Object.assign(row.style, { padding: '6px 14px', color: it.enabled ? (it.req.side === 'buy' ? TV.up : TV.down) : TV.textDim, cursor: it.enabled ? 'pointer' : 'default', opacity: it.enabled ? '1' : '0.55' })
    if (it.enabled) {
      row.addEventListener('mouseenter', () => { row.style.background = TV.border })
      row.addEventListener('mouseleave', () => { row.style.background = '' })
      row.addEventListener('click', () => onPick(it.req))
    }
    menu.append(row)
  })
  return menu
}

/**
 * Right-click on the chart opens a small TradingView-style order menu at the cursor.
 * `toPrice` is injectable (viewport coords -> raw price) so the price logic is testable without a DOM.
 */
export function mountChartContextMenu(
  host: HTMLElement, chart: Chart, getView: () => TradeLinesView | null, cb: TradeOverlayCallbacks,
  toPrice: (clientX: number, clientY: number) => number | null = (x, y) => pixelToPrice(chart, x, y),
): () => void {
  let menu: HTMLDivElement | null = null
  let closeAll: AbortController | null = null
  const close = () => { closeAll?.abort(); closeAll = null; menu?.remove(); menu = null }

  const onContext = (e: MouseEvent) => {
    const view = getView()
    const raw = view ? toPrice(e.clientX, e.clientY) : null
    if (!view || raw === null) return // outside the price pane / no instrument: leave the browser menu alone
    e.preventDefault()
    close()
    const el = buildMenu(contextMenuItems(view, raw), (req) => { close(); cb.onChartOrder(req) })
    document.body.append(el)
    const { width, height } = el.getBoundingClientRect()
    el.style.left = `${Math.max(0, Math.min(e.clientX, window.innerWidth - width - 4))}px`
    el.style.top = `${Math.max(0, Math.min(e.clientY, window.innerHeight - height - 4))}px`
    menu = el
    const ac = new AbortController()
    closeAll = ac
    const opts = { signal: ac.signal, capture: true }
    document.addEventListener('pointerdown', (ev) => { if (!el.contains(ev.target as Node)) close() }, opts)
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close() }, opts)
    window.addEventListener('blur', close, opts)
    window.addEventListener('resize', close, opts)
    window.addEventListener('wheel', close, { signal: ac.signal, passive: true })
  }

  host.addEventListener('contextmenu', onContext)
  return () => { host.removeEventListener('contextmenu', onContext); close() }
}
