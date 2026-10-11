import type { Bar, Instrument } from './types'
import { INSTRUMENTS, dataKey, pricePrecision, symbolTag, unitLabel, unitSize } from './instruments'
import { LiveSeries } from './replay/liveSeries'
import { datasetsFor, instrumentOf, yahooDatasets, type Dataset } from './data/datasets'
import { fetchLocalIndex, type LocalSeries } from './data/localData'
import { loadWindowBars, seriesBounds } from './data/localWindow'
import { defaultWindow, nextAppend, windowAround, windowCovers, type MonthWindow } from './data/window'
import { importCsvFile } from './data/importCsv'
import { clampToRange, dateInputToTs, lastIndexAtOrBefore } from './data/dates'
import { ChartView } from './chart/chartView'
import { registerPineOverlays, syncPineOverlays } from './chart/pineOverlay'
import { registerTradeOverlays, syncTradeOverlays, mountChartContextMenu } from './chart/tradeOverlay'
import { linesView, tradeActions } from './tradeSession'
import { ReplayEngine } from './replay/engine'
import { aggregate, aggregateUpTo, DISPLAY_TZ, SESSION_TZ } from './data/resample'
import { fetchYahooBars, maxRangeFor, type YahooInterval } from './data/yahoo'
import { listSeries, loadBars, saveBars, type SeriesInfo } from './data/store'
import { createAccount, onBar, equity, qtyStep, type AccountState } from './broker/broker'
import { computeStats, DrawdownTracker } from './broker/stats'
import { createPineRunner, MAX_BARS } from './pine/runner'
import { SCRIPTS } from './pine/scripts'
import { mountTopbar } from './ui/topbar'
import { mountDrawbar } from './ui/drawbar'
import { mountReplayBar, SPEEDS } from './ui/replaybar'
import { mountTradePanel } from './ui/tradePanel'

const $ = (id: string): HTMLElement => { const el = document.getElementById(id); if (!el) throw new Error(`#${id} missing`); return el }
const YF: Record<number, YahooInterval> = { 1: '1m', 5: '5m' }
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

export async function startApp(): Promise<void> {
  registerPineOverlays(); registerTradeOverlays()
  const runner = createPineRunner()
  const engine = new ReplayEngine()
  const chart = new ChartView($('chart'))
  const status = $('status')

  let inst: Instrument = INSTRUMENTS[0]!
  let ds: Dataset = yahooDatasets(inst)[0]!
  let tfMin = 5
  let localSeries: LocalSeries[] = []
  let archive: SeriesInfo[] = []
  let baseBars: Bar[] = []
  // Windowed loading (local Dukascopy sets only): baseBars holds just the UTC months `win` of the series spanning `bounds`.
  let win: MonthWindow | null = null, bounds: MonthWindow | null = null, appending = false
  const openHour = (): number | undefined => inst.sessionOpenHour   // daily bar start (NY hour); undefined = CME 18:00
  const live = new LiveSeries()       // what the chart shows (aggregated, forming last bar); mutated in place while stepping
  let account: AccountState = createAccount(inst)
  const keepFrac = (): { fractional: boolean } => ({ fractional: !!account.fractional })
  const spreadPrice = (units: number): number => Number((units * unitSize(inst)).toFixed(10))
  let dd = new DrawdownTracker(account.startingCash)
  let pineOn = false, selecting = false, speedIdx = 2
  const inReplay = () => engine.snapshot.idx >= 0
  const last = (): Bar | null => (inReplay() ? engine.snapshot.bars[engine.snapshot.idx]! : null)

  // ---------- rendering helpers ----------
  const renderPanel = (): void => {
    const lb = last()
    const px = lb?.c ?? null
    const open = account.position && px !== null ? equity({ ...account, position: account.position }, px) - account.cash : 0
    paint({
      symbol: inst.symbol, pointValue: inst.pointValue, last: px, startCash: account.startingCash,
      precision: pricePrecision(inst), tick: inst.tick, unit: unitLabel(inst), unitSize: unitSize(inst),
      contractNote: inst.contractNote, lotContracts: inst.lotContracts, qtyStep: qtyStep(account), fractional: account.fractional, spreadUnits: account.spread / unitSize(inst),
      equity: px === null ? account.cash : equity(account, px), cash: account.cash, openPnl: open,
      position: account.position, orders: account.orders, trades: account.trades,
      stats: computeStats(account.trades, dd), replayActive: inReplay(),
    })
    syncTradeLines()
  }
  const showStatus = (msg = ''): void => {
    const lb = last()
    const clock = (tz: string): string => new Date(lb!.t).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' })
    const when = lb ? `${clock(DISPLAY_TZ)} · ${new Date(lb.t).toLocaleTimeString('en-GB', { timeZone: SESSION_TZ, timeStyle: 'short', timeZoneName: 'short' })}` : ''
    status.innerHTML = `<b>${symbolTag(inst)}</b> · ${ds.short} · ${tfMin >= 60 ? tfMin / 60 + 'h' : tfMin + 'm'}${win ? ` · ${win.from} → ${win.to}` : ''}${when ? ' · ' + when : ''}${msg ? ' · ' + esc(msg) : ''}`
  }
  // Trade lines follow the account on every render; outside replay (no last price, stale account) they are cleared.
  const syncTradeLines = (): void => {
    const view = linesView(account, last()?.c ?? null)
    syncTradeOverlays(chart.chart, inReplay() ? view : { ...view, position: null, orders: [] }, actions.chart)
  }
  const runPine = (): void => {
    if (!pineOn) { syncPineOverlays(chart.chart, { lines: [], labels: [], plots: {} }, 'pine'); return }
    runner.run(SCRIPTS[0]!.code, live.tail(MAX_BARS), tfMin, inst.symbol)
      .then((r) => syncPineOverlays(chart.chart, r, 'pine'))
      .catch((e: Error) => showStatus(`Pine: ${e.message}`))
  }
  const rebuildSeries = (): void => {
    const series = inReplay() ? aggregateUpTo(engine.snapshot.bars, ds.baseMin, tfMin, engine.snapshot.idx, openHour()) : aggregate(baseBars, ds.baseMin, tfMin, openHour())
    live.load(series)
    chart.setPeriod(tfMin); chart.setSeries(series)
    runPine(); showStatus(); renderPanel()
  }

  // ---------- data ----------
  const refreshDatasets = async (): Promise<void> => {
    archive = await listSeries().catch(() => [])
    ui.setDatasets(datasetsFor(inst, localSeries, archive), ds.id)
  }
  const windowNote = (n: number, b: MonthWindow, ms: number): string =>
    `${n.toLocaleString()} bars of ${b.from} → ${b.to} · ${(ms / 1000).toFixed(1)}s`
  let loadSeq = 0   // a slow earlier load (Yahoo) must never overwrite a later one or kill a running replay
  const loadData = async (): Promise<void> => {
    const seq = ++loadSeq, d = ds, yahooSym = inst.yahoo   // snapshot: symbol/dataset may change while we await
    // Leave replay NOW (synchronously): during the awaits below a running replay would keep stepping the OLD instrument's
    // bars into the NEW instrument's account (wrong prices, fills and equity until the load finished).
    engine.load([]); selecting = false; $('chartwrap').style.cursor = ''; ui.setReplay(false); $('replaybar').hidden = true
    status.title = ''
    showStatus('loading data…')
    let bars: Bar[] = []
    let note = ''
    let w: MonthWindow | null = null, b: MonthWindow | null = null
    try {
      if (d.kind === 'local' && d.local) {
        b = seriesBounds(d.local); w = defaultWindow(b)
        const t0 = performance.now()
        bars = await loadWindowBars(d.local, d.storeSymbol, w, (m) => { if (seq === loadSeq) showStatus(m) })
        note = windowNote(bars.length, b, performance.now() - t0)
      } else {
        bars = await loadBars(d.storeSymbol, d.baseMin)
        const yi = d.kind === 'yahoo' ? YF[d.baseMin] : undefined
        if (yi) {
          try { await saveBars(d.storeSymbol, d.baseMin, await fetchYahooBars(yahooSym, yi, maxRangeFor(yi))); bars = await loadBars(d.storeSymbol, d.baseMin) }
          catch (e) { note = `Yahoo unavailable (${(e as Error).message}) — using local archive` }
        }
      }
    } catch (e) { note = `Data error: ${(e as Error).message}` }
    if (seq !== loadSeq) return
    baseBars = bars; win = w; bounds = b; appending = false
    if (tfMin % d.baseMin !== 0) tfMin = d.baseMin
    ui.setTf(tfMin)
    account = createAccount(inst, account.startingCash, account.commission, account.spread, keepFrac()); dd = new DrawdownTracker(account.startingCash)
    chart.setSymbol(inst.symbol, pricePrecision(inst))
    rebuildSeries()
    showStatus(!bars.length ? note || 'no data — source returned nothing and the local archive is empty' : note || `${bars.length.toLocaleString()} bars`)
    void refreshDatasets()
  }

  // ---------- replay ----------
  const hint = $('pickhint')
  const setSelecting = (on: boolean): void => {
    selecting = on
    $('chartwrap').style.cursor = on ? 'crosshair' : ''
    hint.hidden = !on
    ui.setReplay(on || inReplay())
    showStatus()
  }
  const begin = (ts: number): void => {
    const i = lastIndexAtOrBefore(baseBars, ts)
    if (i < 0) return
    engine.load(baseBars); engine.seek(i)
    account = createAccount(inst, account.startingCash, account.commission, account.spread, keepFrac()); dd = new DrawdownTracker(account.startingCash)
    setSelecting(false); ui.setReplay(true); $('replaybar').hidden = false
    rebuildSeries()
    maybeAppend(baseBars[i]!.t)   // started near the window end: prefetch the next month now, not on the first step
  }
  engine.subscribe((s, bar) => {
    rp.setPlaying(s.playing)
    if (!bar) return
    chart.updateLast(live.fold(bar, tfMin, openHour()))
    const r = onBar(account, bar); account = r.state
    dd.push(equity(account, bar.c))
    runPine(); showStatus(); renderPanel()
    maybeAppend(bar.t)
  })

  // Replay reached the last ~2 weeks of the loaded window: append the next month in place. Replay, engine index and
  // account are untouched (engine.append is forward-only), so playback continues seamlessly.
  const maybeAppend = (revealedTs: number): void => {
    const d = ds, w = win, b = bounds
    if (appending || !w || !b || !d.local) return
    const next = nextAppend(w, revealedTs, b)
    if (!next) return
    appending = true
    const seq = loadSeq, t0 = performance.now()
    loadWindowBars(d.local, d.storeSymbol, { from: next, to: next })
      .then((more) => {
        if (seq !== loadSeq || !inReplay()) return   // dataset/window changed or replay exited meanwhile: drop
        const lastT = engine.snapshot.bars[engine.snapshot.bars.length - 1]?.t ?? -Infinity
        engine.append(more.filter((x) => x.t > lastT))
        baseBars = engine.snapshot.bars as Bar[]; win = { from: w.from, to: next }
        showStatus(`loaded ${next} (${((performance.now() - t0) / 1000).toFixed(1)}s)`)
      })
      .catch((e: Error) => showStatus(`could not load ${next}: ${e.message}`))
      .finally(() => { appending = false })
  }

  // ---------- UI ----------
  const ui = mountTopbar($('topbar'), {
    onSymbol: (s) => { inst = instrumentOf(s); ds = yahooDatasets(inst)[0]!; account = createAccount(inst, account.startingCash, account.commission, 0, keepFrac()); ui.setDatasets(datasetsFor(inst, localSeries, archive), ds.id); void loadData() },
    onTf: (m) => { if (m % ds.baseMin !== 0) return; tfMin = m; ui.setTf(m); rebuildSeries() },
    onDataset: (id) => { ds = datasetsFor(inst, localSeries, archive).find((d) => d.id === id) ?? ds; void loadData() },
    onImport: (file, tz) => void doImport(file, tz),
    onGoto: (date) => void goto(date),
    onReplay: () => { if (inReplay()) return; setSelecting(!selecting) },
    onPine: (on) => { pineOn = on; runPine() },
  })
  ui.setTf(tfMin)
  const rp = mountReplayBar($('replaybar'), {
    onPlay: () => (engine.snapshot.playing ? engine.pause() : engine.play()),
    onStep: () => { engine.pause(); engine.step() },
    onSlower: () => { speedIdx = Math.max(0, speedIdx - 1); engine.setSpeed(SPEEDS[speedIdx]!.ms); rp.setSpeed(speedIdx) },
    onFaster: () => { speedIdx = Math.min(SPEEDS.length - 1, speedIdx + 1); engine.setSpeed(SPEEDS[speedIdx]!.ms); rp.setSpeed(speedIdx) },
    onExit: () => { engine.load([]); ui.setReplay(false); $('replaybar').hidden = true; rebuildSeries() },
    onReselect: () => { engine.pause(); setSelecting(true) },
  })
  engine.setSpeed(SPEEDS[speedIdx]!.ms); rp.setSpeed(speedIdx)
  mountDrawbar($('drawbar'), (name) => { chart.chart.createOverlay({ name, groupId: 'drawings' }) }, () => chart.chart.removeOverlay({ groupId: 'drawings' }))

  let chartQty = 1   // contracts, mirrors the panel's size field; used by chart context-menu orders
  const actions = tradeActions({
    account: () => account, set: (a) => { account = a }, last, changed: () => renderPanel(),
    say: (m) => showStatus(m), size: () => chartQty,
  })
  const paint = mountTradePanel($('trade'), {
    ...actions.panel,
    onSize: (c) => { chartQty = c },
    onReset: (cash, commission, spreadUnits, fractional) => { account = createAccount(inst, cash, commission, spreadPrice(spreadUnits), { fractional: !!fractional }); dd = new DrawdownTracker(cash); renderPanel() },
  })
  mountChartContextMenu($('chart'), chart.chart, () => (inReplay() ? linesView(account, last()?.c ?? null) : null), actions.chart)

  $('chart').addEventListener('click', (e) => {
    if (!selecting) return
    const r = $('chart').getBoundingClientRect()
    const [p] = chart.chart.convertFromPixel([{ x: e.clientX - r.left, y: e.clientY - r.top }], { paneId: 'candle_pane' }) as { timestamp?: number }[]
    if (typeof p?.timestamp === 'number') begin(p.timestamp)
    else showStatus('could not read the bar under the cursor — click a candle')
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selecting) { setSelecting(false); return }
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return
    if (!inReplay()) return
    if (e.key === 'ArrowRight' && e.shiftKey) { engine.snapshot.playing ? engine.pause() : engine.play() }
    else if (e.key === 'ArrowRight') { engine.pause(); engine.step() }
  })
  new ResizeObserver(() => chart.chart.resize()).observe($('chart'))

  // ---------- own CSV + go to date ----------
  const doImport = async (file: File, tz: string): Promise<void> => {
    showStatus(`importing ${file.name}…`)
    try {
      const r = await importCsvFile(file, tz, dataKey(inst))
      archive = await listSeries()
      ds = datasetsFor(inst, localSeries, archive).find((d) => d.storeSymbol === r.storeSymbol && d.baseMin === r.intervalMinutes) ?? ds
      await loadData()
      showStatus(`imported ${r.bars.toLocaleString()} bars (${r.intervalMinutes}m) · ${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}`)
      status.title = r.warnings.join('\n')
    } catch (e) { showStatus(`Import failed: ${(e as Error).message}`) }
  }
  const goto = async (date: string): Promise<void> => {
    const want = dateInputToTs(date)
    if (want === null) return showStatus('pick a valid date first')
    const series = ds.local
    if (series && win && bounds && !windowCovers(win, want)) {
      if (inReplay()) return showStatus(`replay active: exit replay to jump outside the loaded window (${win.from} → ${win.to})`)
      // load a window centred on the target (3 months before, 6 after); a newer load/dataset switch supersedes this one
      const seq = ++loadSeq, d = ds
      const w = windowAround(clampToRange(want, series.from, series.to).ts, bounds)
      showStatus(`loading ${w.from} → ${w.to}…`)
      const t0 = performance.now()
      try {
        const bars = await loadWindowBars(series, d.storeSymbol, w, (m) => { if (seq === loadSeq) showStatus(m) })
        if (seq !== loadSeq) return
        baseBars = bars; win = w; rebuildSeries()
        showStatus(windowNote(bars.length, bounds, performance.now() - t0))
      } catch (e) { return showStatus(`Data error: ${(e as Error).message}`) }
    }
    const first = baseBars[0], end = inReplay() ? last() : baseBars[baseBars.length - 1]
    if (!first || !end) return showStatus('no data loaded')
    const { ts, clamped } = clampToRange(want, first.t, end.t)
    chart.chart.scrollToTimestamp(ts)
    showStatus(clamped ? `no data ${clamped} ${new Date(ts).toISOString().slice(0, 10)} — showing nearest` : `jumped to ${date}`)
  }

  if (import.meta.env.DEV) (window as unknown as { __mr: unknown }).__mr = { begin, engine, goto, tradeLines: () => chart.chart.getOverlays({ groupId: 'trade-lines' }).map((o) => o.id), state: () => ({ selecting, account, series: live.length, tfMin, baseBars: baseBars.length, ds: ds.id, win, bounds, appending }) }
  localSeries = await fetchLocalIndex()
  await loadData()
}
