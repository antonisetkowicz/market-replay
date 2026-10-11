/** '#rrggbb' or '#rgb' + opacity 0..1 -> 'rgba(r, g, b, a)'. Invalid colour falls back to the TV accent blue. */
export function toRgba(hex: string, opacity: number): string {
  const a = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 1))
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  const raw = m?.[1] ?? '2962ff'
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw
  const n = parseInt(full, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(a * 1000) / 1000})`
}
