import { registerOverlay } from 'klinecharts'
import type { Chart } from 'klinecharts'
import { toRgba } from './color'

export interface RectStyle { color: string; opacity: number }
export const DEFAULT_RECT: RectStyle = { color: '#2962ff', opacity: 0.2 }
export interface RectSelected { id: string; chart: Chart; style: RectStyle }
export const RECT_SELECTED = 'rect-selected'

let registered = false

/** Two-point rectangle with a filled body: border is the solid colour, fill uses the chosen opacity. */
export function registerRectOverlay(getDefault: () => RectStyle = () => DEFAULT_RECT): void {
  if (registered) return
  registered = true
  const announce = (id: string, chart: Chart, style: RectStyle) =>
    window.dispatchEvent(new CustomEvent<RectSelected>(RECT_SELECTED, { detail: { id, chart, style } }))
  registerOverlay<RectStyle>({
    name: 'rect',
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    // freeze the current default into the shape the moment it is created, so later changes don't restyle old ones
    onDrawStart: ({ overlay, chart }) => { chart.overrideOverlay({ id: overlay.id, extendData: { ...getDefault() } }) },
    onDrawEnd: ({ overlay, chart }) => announce(overlay.id, chart, overlay.extendData ?? getDefault()),
    onClick: ({ overlay, chart }) => announce(overlay.id, chart, overlay.extendData ?? getDefault()),
    createPointFigures: ({ overlay, coordinates }) => {
      const [a, b] = coordinates
      if (!a || !b) return []
      const s = overlay.extendData ?? getDefault()
      return {
        type: 'rect',
        attrs: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) },
        styles: { style: 'stroke_fill', color: toRgba(s.color, s.opacity), borderColor: toRgba(s.color, 1), borderSize: 1 },
      }
    },
  })
}
