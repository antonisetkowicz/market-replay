import { h } from './dom'
import { DEFAULT_RECT, RECT_SELECTED, registerRectOverlay, type RectSelected, type RectStyle } from '../chart/rectangle'

const ico = (d: string) => `<svg viewBox="0 0 24 24">${d}</svg>`
export const TOOLS: { name: string; title: string; icon: string }[] = [
  { name: 'segment', title: 'Trend line', icon: ico('<path d="M4 19 20 5"/><circle cx="4" cy="19" r="1.5"/><circle cx="20" cy="5" r="1.5"/>') },
  { name: 'rayLine', title: 'Ray', icon: ico('<path d="M4 19 22 3"/><circle cx="4" cy="19" r="1.5"/>') },
  { name: 'horizontalStraightLine', title: 'Horizontal line', icon: ico('<path d="M2 12h20"/>') },
  { name: 'verticalStraightLine', title: 'Vertical line', icon: ico('<path d="M12 2v20"/>') },
  { name: 'parallelStraightLine', title: 'Parallel channel', icon: ico('<path d="M3 17 21 9M3 11 21 3"/>') },
  { name: 'rect', title: 'Rectangle', icon: ico('<rect x="4" y="6" width="16" height="12" rx="1"/>') },
  { name: 'fibonacciLine', title: 'Fib retracement', icon: ico('<path d="M3 5h18M3 10h18M3 15h18M3 20h18"/>') },
]

/** Floating colour + fill-opacity panel for rectangles; edits the selected shape and the default for new ones. */
function mountRectPanel(anchor: HTMLElement): { show(): void; hide(): void } {
  let style: RectStyle = { ...DEFAULT_RECT }
  let selected: RectSelected | null = null
  registerRectOverlay(() => style)

  const color = h('input', { type: 'color', value: style.color, 'aria-label': 'Rectangle colour' })
  const range = h('input', { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(style.opacity * 100)), 'aria-label': 'Fill opacity' })
  const label = h('span', { class: 'tb-dim' }, `${Math.round(style.opacity * 100)}%`)
  const panel = h('div', { id: 'rectpanel', hidden: true, role: 'group', 'aria-label': 'Rectangle style' },
    h('span', {}, 'Fill'), color, range, label, h('button', { title: 'Close', onclick: () => hide() }, '✕'))
  anchor.parentElement?.append(panel)

  const apply = () => {
    style = { color: color.value, opacity: Number(range.value) / 100 }
    label.textContent = `${range.value}%`
    selected?.chart.overrideOverlay({ id: selected.id, extendData: { ...style } })
  }
  color.addEventListener('input', apply)
  range.addEventListener('input', apply)
  window.addEventListener(RECT_SELECTED, (e) => {
    selected = (e as CustomEvent<RectSelected>).detail
    style = { ...selected.style }
    color.value = style.color; range.value = String(Math.round(style.opacity * 100)); label.textContent = `${range.value}%`
    show()
  })
  function show() { panel.hidden = false }
  function hide() { panel.hidden = true; selected = null }
  return { show: () => { selected = null; show() }, hide }
}

export function mountDrawbar(host: HTMLElement, onPick: (name: string) => void, onClear: () => void): void {
  const rectPanel = mountRectPanel(host)
  for (const t of TOOLS) {
    const b = h('button', { title: t.title, 'aria-label': t.title, onclick: () => { t.name === 'rect' ? rectPanel.show() : rectPanel.hide(); onPick(t.name) } })
    b.innerHTML = t.icon
    host.append(b)
  }
  const clear = h('button', { title: 'Remove all drawings', 'aria-label': 'Remove all drawings', onclick: () => { rectPanel.hide(); onClear() } })
  clear.innerHTML = ico('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>')
  host.append(h('div', { class: 'tb-sep', style: 'width:24px;height:1px;margin:6px 0' }), clear)
}
