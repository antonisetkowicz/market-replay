import type { PendingOrder } from '../broker/broker'
import type { Position } from '../types'

/** Everything the chart needs to draw the trade lines; rebuilt by the app on every replay step. */
export interface TradeLinesView {
  pointValue: number
  precision: number
  lastPrice: number | null
  position: Position | null
  orders: readonly PendingOrder[]
  unit: string        // 'contracts' | 'lots' | 'oz'
  lotFactor: number   // qty * lotFactor is the displayed size (forex 0.01)
  /** optional: price grid for drag snapping; default 10^-precision (the broker tick-rounds on commit anyway) */
  tick?: number
  /** optional: distance label in SL/TP tags (default 'pts') and the price size of one such unit (default 1) */
  distUnit?: string
  distSize?: number
}

export interface ChartOrderRequest { side: 'buy' | 'sell'; type: 'market' | 'limit' | 'stop'; price?: number }

export interface TradeOverlayCallbacks {
  onMoveSl(price: number): void
  onMoveTp(price: number): void
  onRemoveSl(): void
  onRemoveTp(): void
  onMoveOrder(id: number, price: number): void
  onCancelOrder(id: number): void
  onClosePosition(): void
  onChartOrder(req: ChartOrderRequest): void
}
