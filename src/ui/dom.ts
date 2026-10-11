// Tiny DOM helper: h('button', {class:'x', onclick}, 'text', child)
type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (string | Node)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v)
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, v)
  }
  el.append(...kids)
  return el
}
export const money = (n: number): string => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const cls = (n: number): string => (n > 0 ? 'pos' : n < 0 ? 'neg' : '')
