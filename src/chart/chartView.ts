import { init, dispose, type Chart, type KLineData, type DeepPartial, type Styles } from 'klinecharts'
import type { Bar } from '../types'
import { TV } from './theme'
import { DISPLAY_TZ } from '../data/resample'

const toK = (b: Bar): KLineData => ({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })

const line = (color: string, style: 'solid' | 'dashed' = 'solid', size = 1) => ({ show: true, style, size, color, dashedValue: [3, 3] })

const styles: DeepPartial<Styles> = {
  grid: { horizontal: line(TV.grid), vertical: line(TV.grid) },
  candle: {
    type: 'candle_solid',
    bar: {
      upColor: TV.up, downColor: TV.down, noChangeColor: TV.textDim,
      upBorderColor: TV.up, downBorderColor: TV.down, noChangeBorderColor: TV.textDim,
      upWickColor: TV.up, downWickColor: TV.down, noChangeWickColor: TV.textDim,
    },
    priceMark: {
      high: { show: false }, low: { show: false },
      last: { show: true, upColor: TV.up, downColor: TV.down, noChangeColor: TV.textDim, line: { show: true, style: 'dashed', dashedValue: [2, 2], size: 1 }, text: { show: true, color: '#fff', size: 12, family: TV.font, borderRadius: 2 } },
    },
    tooltip: { showRule: 'none' },
  },
  indicator: { tooltip: { showRule: 'none' } },
  xAxis: { axisLine: { color: TV.border }, tickLine: { color: TV.border }, tickText: { color: TV.textDim, family: TV.font, size: 11 } },
  yAxis: { axisLine: { color: TV.border }, tickLine: { color: TV.border }, tickText: { color: TV.textDim, family: TV.font, size: 11 } },
  separator: { color: TV.border },
  crosshair: {
    horizontal: { line: line(TV.crosshair, 'dashed'), text: { color: '#fff', backgroundColor: TV.tag, borderColor: TV.tag, family: TV.font, size: 11 } },
    vertical: { line: line(TV.crosshair, 'dashed'), text: { color: '#fff', backgroundColor: TV.tag, borderColor: TV.tag, family: TV.font, size: 11 } },
  },
}

/** Thin wrapper over KLineChart v10 (data-loader based) that shows exactly the series it is given. */
export class ChartView {
  readonly chart: Chart
  private series: KLineData[] = []
  private push: ((b: KLineData) => void) | null = null

  private readonly host: HTMLElement

  constructor(host: HTMLElement, pricePrecision = 2) {
    this.host = host
    const chart = init(host, { styles })
    if (!chart) throw new Error('Could not initialise chart')
    this.chart = chart
    chart.setTimezone(DISPLAY_TZ)
    chart.setDataLoader({
      getBars: ({ type, callback }) => callback(type === 'init' ? this.series.slice() : [], false), // copy: the chart must not alias our working array
      subscribeBar: ({ callback }) => { this.push = callback },
      unsubscribeBar: () => { this.push = null },
    })
    this.setSymbol('NQ', pricePrecision)
  }

  setSymbol(ticker: string, pricePrecision = 2): void {
    this.chart.setSymbol({ ticker, pricePrecision, volumePrecision: 0 })
  }

  setPeriod(tfMinutes: number): void {
    const [type, span] = tfMinutes >= 1440 ? (['day', tfMinutes / 1440] as const) : tfMinutes >= 60 ? (['hour', tfMinutes / 60] as const) : (['minute', tfMinutes] as const)
    this.chart.setPeriod({ type, span })
  }

  /** Replace the whole series (start of replay / timeframe change). */
  setSeries(bars: readonly Bar[]): void {
    this.series = bars.map(toK)
    this.chart.resetData()
  }

  /** Append or update the last (forming) bar without redrawing everything. */
  updateLast(bar: Bar): void {
    const k = toK(bar)
    const last = this.series.at(-1)
    // private working array: mutated in place (O(1)); only copies leave this class
    if (last && last.timestamp === k.timestamp) this.series[this.series.length - 1] = k
    else this.series.push(k)
    this.push?.(k)
  }

  destroy(): void { dispose(this.host) }
}
