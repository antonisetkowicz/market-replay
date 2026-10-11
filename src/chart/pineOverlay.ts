import { registerOverlay } from 'klinecharts'
import type { Chart, OverlayCreate } from 'klinecharts'
import type { PineLabel, PineLine, PineResult } from '../types'

/**
 * Note: klinecharts maps timestamps beyond the last bar to the last bar, so session lines
 * that Pine extends into the future are drawn up to the last loaded bar only.
 */

const LINE_OVERLAY = 'segment'
const LABEL_OVERLAY = 'pineLabel'
const LABEL_FONT_PX: Record<string, number> = { auto: 11, tiny: 9, small: 10, normal: 12, large: 14, huge: 18 }
const LABEL_GAP_PX = 4
const DEFAULT_LABEL_PX = 11

let registered = false

export function registerPineOverlays(): void {
  if (registered) return
  registered = true
  registerOverlay<{ text: string; color: string; size: number }>({
    name: LABEL_OVERLAY,
    totalStep: 1,
    lock: true,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ overlay, coordinates }) => {
      const c = coordinates[0]
      const d = overlay.extendData
      if (!c || !d) return []
      return {
        type: 'text',
        ignoreEvent: true,
        attrs: { x: c.x + LABEL_GAP_PX, y: c.y, text: d.text, align: 'left', baseline: 'middle' },
        styles: { style: 'fill', color: d.color, size: d.size, backgroundColor: 'transparent', borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 },
      }
    },
  })
}

/** Parse rgb()/rgba()/#hex into a CSS color klinecharts accepts; unknown input passes through. */
export function normalizeColor(input: string): string {
  const s = input.trim()
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s)
  if (fn) {
    const [r, g, b] = [fn[1], fn[2], fn[3]].map((n) => Math.min(255, Math.max(0, Math.round(Number(n)))))
    const a = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? Number.parseFloat(fn[4]) / 100 : Number(fn[4])
    return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, a))})`
  }
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s)
  if (hex) {
    let h = hex[1]!
    if (h.length <= 4) h = [...h].map((ch) => ch + ch).join('')
    const a = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1
    const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16)
    return `rgba(${n(0)}, ${n(2)}, ${n(4)}, ${Number(a.toFixed(3))})`
  }
  return s
}

const lineKey = (l: PineLine) => `pine-line-${l.id}`
const labelKey = (l: PineLabel) => `pine-label-${l.id}`

function lineSpec(l: PineLine, groupId: string): OverlayCreate {
  return {
    id: lineKey(l), groupId, name: LINE_OVERLAY, lock: true,
    visible: true, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
    points: [{ timestamp: l.x1, value: l.y1 }, { timestamp: l.x2, value: l.y2 }],
    styles: { line: { color: normalizeColor(l.color), size: l.width, style: l.style.includes('dash') || l.style.includes('dot') ? 'dashed' : 'solid' } },
  }
}

function labelSpec(l: PineLabel, groupId: string): OverlayCreate {
  return {
    id: labelKey(l), groupId, name: LABEL_OVERLAY, lock: true,
    visible: true, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
    points: [{ timestamp: l.x, value: l.y }],
    extendData: { text: l.text, color: normalizeColor(l.textcolor), size: LABEL_FONT_PX[l.size] ?? DEFAULT_LABEL_PX },
  }
}

/** Last applied spec per id, keyed by chart, so unchanged overlays are left alone. */
const applied = new WeakMap<object, Map<string, string>>()

/**
 * Diff `result` against what this group already shows: create new, override changed
 * (move/restyle in place), remove vanished. Unchanged overlays are untouched.
 */
export function syncPineOverlays(chart: Chart, result: PineResult, ownerGroupId: string): void {
  const prev = applied.get(chart) ?? new Map<string, string>()
  const next = new Map<string, string>()
  const specs = [
    ...result.lines.map((l) => lineSpec(l, ownerGroupId)),
    ...result.labels.map((l) => labelSpec(l, ownerGroupId)),
  ]
  const toCreate: OverlayCreate[] = []
  for (const spec of specs) {
    const id = spec.id as string
    const sig = JSON.stringify([spec.points, spec.styles, spec.extendData])
    next.set(id, sig)
    const old = prev.get(id)
    if (old === undefined) toCreate.push(spec)
    else if (old !== sig) chart.overrideOverlay({ id, points: spec.points, styles: spec.styles, extendData: spec.extendData })
  }
  for (const id of prev.keys()) if (!next.has(id)) chart.removeOverlay({ id })
  if (toCreate.length) chart.createOverlay(toCreate)
  applied.set(chart, next)
}
