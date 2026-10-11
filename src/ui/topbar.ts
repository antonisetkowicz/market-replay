import { INSTRUMENTS } from '../instruments'
import { h } from './dom'

export const TFS = [{ m: 1, l: '1m' }, { m: 5, l: '5m' }, { m: 15, l: '15m' }, { m: 60, l: '1h' }, { m: 240, l: '4h' }, { m: 1440, l: '1D' }]
export const IMPORT_TZS = ['UTC', 'America/New_York', 'Europe/Warsaw', 'Europe/London']

export interface TopbarApi {
  setTf(m: number): void; setReplay(on: boolean): void; setPine(on: boolean): void
  setDatasets(list: { id: string; label: string }[], selectedId: string): void
}
export interface TopbarCallbacks {
  onSymbol(s: string): void; onTf(m: number): void; onDataset(id: string): void; onReplay(): void; onPine(on: boolean): void
  onImport(file: File, timezone: string): void; onGoto(date: string): void
}

export function mountTopbar(host: HTMLElement, cb: TopbarCallbacks): TopbarApi {
  const sym = h('select', { class: 'tb-sym', 'aria-label': 'Symbol', onchange: (e) => cb.onSymbol((e.target as HTMLSelectElement).value) },
    ...INSTRUMENTS.map((i) => h('option', { value: i.symbol }, `${i.symbol}  ${i.name}`)))
  const tfBtns = TFS.map((t) => h('button', { 'data-m': String(t.m), onclick: () => cb.onTf(t.m) }, t.l))
  const data = h('select', { 'aria-label': 'Data set', title: 'Data set. Futures (Yahoo) and index CFD (Dukascopy) are separate series: prices differ by the futures basis, so they are never spliced.', class: 'tb-data', onchange: (e) => cb.onDataset((e.target as HTMLSelectElement).value) })
  const replay = h('button', { title: 'Bar replay', onclick: cb.onReplay }, '⏮ Replay')
  const pine = h('input', { type: 'checkbox', id: 'pine-tjr', onchange: (e) => cb.onPine((e.target as HTMLInputElement).checked) })

  const file = h('input', { type: 'file', accept: '.csv,.txt,text/csv', hidden: true, onchange: (e) => {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (f) cb.onImport(f, tz.value)
    ;(e.target as HTMLInputElement).value = ''
  } })
  const tz = h('select', { 'aria-label': 'Timezone of naive timestamps in the CSV', title: 'Timezone of CSV timestamps without an offset (epoch/ISO-with-Z are always exact)' },
    ...IMPORT_TZS.map((z) => h('option', { value: z }, z === 'UTC' ? 'CSV: UTC' : `CSV: ${z.split('/')[1]}`)))
  const imp = h('button', { title: 'Import your own OHLC CSV (broker / TradingView export) into the local archive', onclick: () => file.click() }, 'Import CSV')
  const date = h('input', { type: 'date', 'aria-label': 'Go to date', title: 'Scroll the chart to a date (09:30 New York)' })
  const go = h('button', { title: 'Go to date', onclick: () => cb.onGoto(date.value) }, 'Go')
  date.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') cb.onGoto(date.value) })

  host.append(sym, h('div', { class: 'tb-sep' }), ...tfBtns, h('div', { class: 'tb-sep' }), data, h('div', { class: 'tb-sep' }),
    date, go, h('div', { class: 'tb-sep' }), imp, tz, file, h('div', { class: 'tb-sep' }),
    h('label', { class: 'tb-dim', for: 'pine-tjr', style: 'display:flex;gap:6px;align-items:center;cursor:pointer' }, pine, 'TJR Sessions'),
    h('div', { style: 'flex:1' }), replay)
  return {
    setTf: (m) => tfBtns.forEach((b) => b.classList.toggle('on', b.dataset.m === String(m))),
    setReplay: (on) => replay.classList.toggle('on', on),
    setPine: (on) => { pine.checked = on },
    setDatasets: (list, selectedId) => {
      data.replaceChildren(...list.map((d) => h('option', { value: d.id }, d.label)))
      data.value = selectedId
    },
  }
}
