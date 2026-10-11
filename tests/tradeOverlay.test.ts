import { beforeEach, describe, expect, it, vi } from 'vitest'

// klinecharts touches window/document on import, so replace it with a recorder of the registered template
const registered: Array<Record<string, any>> = []
vi.mock('klinecharts', () => ({
  registerOverlay: (t: Record<string, any>) => { registered.push(t) },
  utils: { calcTextWidth: (t: string, size: number) => t.length * size * 0.5 },
}))

import type { PendingOrder } from '../src/broker/broker'
import type { Position } from '../src/types'
import { buildLines } from '../src/chart/tradeLines'
import { clampDrag, dragBounds, formatMoney, formatTag, pnlAt, snapToTick, tagLayout } from '../src/chart/tradeMath'
import { contextMenuItems, pixelToPrice } from '../src/chart/tradeMenu'
import { registerTradeOverlays, syncTradeOverlays } from '../src/chart/tradeOverlay'
import type { TradeLinesView, TradeOverlayCallbacks } from '../src/chart/tradeTypes'

const longPos: Position = { side: 'buy', qty: 2, avgPrice: 31000, sl: 30980, tp: 31040, openedAt: 1 }
const shortPos: Position = { side: 'sell', qty: 1, avgPrice: 31000, openedAt: 1 }
const view = (over: Partial<TradeLinesView> = {}): TradeLinesView => ({
  pointValue: 2, precision: 2, lastPrice: 31030, position: longPos, orders: [], unit: 'contracts', lotFactor: 1, tick: 0.25, ...over,
})
const order = (over: Partial<PendingOrder> = {}): PendingOrder => ({ id: 7, side: 'buy', type: 'limit', qty: 1, price: 31000, createdAt: 1, ...over })

describe('pnl and labels', () => {
  it('pnlAt includes contract value and direction', () => {
    expect(pnlAt(view(), 31030)).toBe(120) // 30 pts * 2 contracts * $2
    expect(pnlAt(view({ position: shortPos }), 31030)).toBe(-60)
    expect(pnlAt(view({ position: null }), 31030)).toBe(0)
  })
  it('formats money with sign and thousands separators', () => {
    expect(formatMoney(120)).toBe('+$120.00')
    expect(formatMoney(-80)).toBe('-$80.00')
    expect(formatMoney(1234.5)).toBe('+$1,234.50')
    expect(formatMoney(-0.001)).toBe('+$0.00')
  })
  it('formats the four tag kinds like TradingView', () => {
    expect(formatTag(view(), { kind: 'pos' })).toBe('Long 2 · +$120.00')
    expect(formatTag(view({ position: shortPos }), { kind: 'pos' })).toBe('Short 1 · -$60.00')
    expect(formatTag(view(), { kind: 'sl', price: 30980 })).toBe('SL  -$80.00 · 20 pts')
    expect(formatTag(view(), { kind: 'tp', price: 31040 })).toBe('TP +$160.00 · 40 pts')
    expect(formatTag(view(), { kind: 'ord', order: order({ price: 31200 }) })).toBe('Buy Limit 1 @ 31,200.00')
    expect(formatTag(view({ lastPrice: null }), { kind: 'pos' })).toBe('Long 2')
  })
  it('shows lots for forex and custom distance units', () => {
    const fx = view({ unit: 'lots', lotFactor: 0.01, distUnit: 'pips', distSize: 0.0001, precision: 5, pointValue: 1000, position: { ...longPos, qty: 2, avgPrice: 1.1 } })
    expect(formatTag(fx, { kind: 'pos' })).toContain('Long 0.02 lots')
    expect(formatTag(fx, { kind: 'sl', price: 1.098 })).toMatch(/· 20 pips$/)
  })
  it('SL/TP of a pending order are measured from the order price', () => {
    expect(formatTag(view({ position: null }), { kind: 'sl', price: 30990, order: order() })).toBe('SL  -$20.00 · 10 pts')
  })
})

describe('snap and side constraints', () => {
  it('snaps to the tick grid without float noise', () => {
    expect(snapToTick(31000.13, 0.25)).toBe(31000.25)
    expect(snapToTick(1.234567, 0.00001)).toBe(1.23457)
  })
  it('long: SL strictly below, TP strictly above the last price', () => {
    expect(clampDrag(view(), 'sl', 31100)).toBe(31029.75)
    expect(clampDrag(view(), 'sl', 30950.1)).toBe(30950)
    expect(clampDrag(view(), 'tp', 30000)).toBe(31030.25)
    expect(clampDrag(view(), 'tp', 31060.2)).toBe(31060.25)
  })
  it('short: sides flip', () => {
    const v = view({ position: shortPos })
    expect(clampDrag(v, 'sl', 30000)).toBe(31030.25)
    expect(clampDrag(v, 'tp', 31100)).toBe(31029.75)
  })
  it('off-grid last price still gives a strictly valid bound', () => {
    expect(dragBounds(view({ lastPrice: 31030.1 }), 'sl').max).toBe(31030)
    expect(dragBounds(view({ lastPrice: 31030.1 }), 'tp').min).toBe(31030.25)
  })
  it('pending orders stay on their side of the market', () => {
    const v = view()
    expect(clampDrag(v, 'ord', 31100, order({ type: 'limit', side: 'buy' }))).toBe(31029.75)
    expect(clampDrag(v, 'ord', 30000, order({ type: 'limit', side: 'sell' }))).toBe(31030.25)
    expect(clampDrag(v, 'ord', 30000, order({ type: 'stop', side: 'buy' }))).toBe(31030.25)
    expect(clampDrag(v, 'ord', 31100, order({ type: 'stop', side: 'sell' }))).toBe(31029.75)
    expect(clampDrag(view({ lastPrice: null }), 'ord', 123.1, order())).toBe(123)
  })
})

describe('buildLines', () => {
  it('uses stable ids and colours the position tag by P&L', () => {
    const lines = buildLines(view({ orders: [order({ id: 3, sl: 30900 })] }))
    expect(lines.map((l) => l.id)).toEqual(['pos', 'sl', 'tp', 'ord-3', 'ord-3-sl'])
    expect(lines[0]!.tagColor).toBe('#089981')
    expect(buildLines(view({ lastPrice: 30900 }))[0]!.tagColor).toBe('#f23645')
    expect(lines.find((l) => l.id === 'ord-3-sl')!.draggable).toBe(false)
    expect(lines.find((l) => l.id === 'ord-3')!.dashed).toBe(true)
  })
})

function fakeChart() {
  const live = new Map<string, any>()
  const chart = {
    getOverlays: vi.fn(() => [...live.values()]),
    createOverlay: vi.fn((v: any) => { for (const o of [v].flat()) live.set(o.id, o) }),
    overrideOverlay: vi.fn((o: any) => { live.set(o.id, { ...live.get(o.id), ...o }) }),
    removeOverlay: vi.fn((f: any) => { live.delete(f.id) }),
  }
  return { chart: chart as any, live }
}
const callbacks = (): TradeOverlayCallbacks => ({
  onMoveSl: vi.fn(), onMoveTp: vi.fn(), onRemoveSl: vi.fn(), onRemoveTp: vi.fn(),
  onMoveOrder: vi.fn(), onCancelOrder: vi.fn(), onClosePosition: vi.fn(), onChartOrder: vi.fn(),
})

describe('syncTradeOverlays', () => {
  beforeEach(() => { if (!registered.length) registerTradeOverlays() })

  it('registers the overlay once', () => {
    registerTradeOverlays()
    expect(registered).toHaveLength(1)
    expect(registered[0]!.name).toBe('tradeLine')
  })

  it('creates, updates in place, leaves unchanged alone and removes vanished lines', () => {
    const { chart, live } = fakeChart()
    const cb = callbacks()
    syncTradeOverlays(chart, view(), cb)
    expect(chart.createOverlay).toHaveBeenCalledTimes(1)
    expect([...live.keys()]).toEqual(['pos', 'sl', 'tp'])

    syncTradeOverlays(chart, view(), cb) // identical -> nothing
    expect(chart.overrideOverlay).not.toHaveBeenCalled()
    expect(chart.createOverlay).toHaveBeenCalledTimes(1)

    syncTradeOverlays(chart, view({ lastPrice: 31040 }), cb) // live P&L changes only the position tag
    expect(chart.overrideOverlay).toHaveBeenCalledTimes(1)
    expect(chart.overrideOverlay.mock.calls[0][0].id).toBe('pos')
    expect(chart.overrideOverlay.mock.calls[0][0].extendData.text).toBe('Long 2 · +$160.00')

    syncTradeOverlays(chart, view({ position: { ...longPos, sl: undefined }, orders: [order()] }), cb)
    expect(chart.removeOverlay).toHaveBeenCalledWith({ id: 'sl' })
    expect(live.has('ord-7')).toBe(true)
    expect(chart.removeOverlay).toHaveBeenCalledTimes(1)
  })

  it('self-heals when something else cleared the overlays', () => {
    const { chart, live } = fakeChart()
    syncTradeOverlays(chart, view(), callbacks())
    live.clear()
    syncTradeOverlays(chart, view(), callbacks())
    expect(chart.createOverlay).toHaveBeenCalledTimes(2)
  })

  it('draggable lines are unlocked, position and attached exits are locked', () => {
    const { chart, live } = fakeChart()
    syncTradeOverlays(chart, view({ orders: [order({ tp: 31100 })] }), callbacks())
    expect(live.get('sl').lock).toBe(false)
    expect(live.get('pos').lock).toBe(true)
    expect(live.get('ord-7-tp').lock).toBe(true)
  })

  it('live drag: snaps, clamps, updates the tag and survives a concurrent sync', () => {
    const { chart, live } = fakeChart()
    const cb = callbacks()
    syncTradeOverlays(chart, view(), cb)
    const t = registered[0]!
    const overlay = () => ({ ...live.get('sl'), points: live.get('sl').points })
    t.onPressedMoveStart({ chart, overlay: overlay() })

    live.get('sl').points = [{ value: 30950.1 }] // what klinecharts writes before calling onPressedMoving
    t.onPressedMoving({ chart, overlay: overlay() })
    expect(live.get('sl').points).toEqual([{ value: 30950 }])
    expect(live.get('sl').extendData.text).toBe('SL  -$200.00 · 50 pts')

    syncTradeOverlays(chart, view({ lastPrice: 31031 }), cb) // replay step mid-drag must not yank the line back
    expect(live.get('sl').points).toEqual([{ value: 30950 }])

    live.get('sl').points = [{ value: 31500 }] // dragged across the market: clamped to the losing side
    t.onPressedMoving({ chart, overlay: overlay() })
    expect(live.get('sl').points).toEqual([{ value: 31030.75 }])
  })

  it('drag end commits the new price once, via the right callback', () => {
    const { chart, live } = fakeChart()
    const cb = callbacks()
    syncTradeOverlays(chart, view({ orders: [order()] }), cb)
    const t = registered[0]!
    for (const [id, moved] of [['sl', 30900], ['tp', 31100], ['ord-7', 30990]] as const) {
      t.onPressedMoveStart({ chart, overlay: live.get(id) })
      live.get(id).points = [{ value: moved }]
      t.onPressedMoving({ chart, overlay: live.get(id) })
      t.onPressedMoveEnd({ chart, overlay: live.get(id) })
    }
    expect(cb.onMoveSl).toHaveBeenCalledWith(30900)
    expect(cb.onMoveTp).toHaveBeenCalledWith(31100)
    expect(cb.onMoveOrder).toHaveBeenCalledWith(7, 30990)
  })

  it('snaps back when the commit is rejected (no re-sync) and does not commit a plain click', () => {
    const { chart, live } = fakeChart()
    const cb = callbacks()
    syncTradeOverlays(chart, view(), cb)
    const t = registered[0]!
    t.onPressedMoveStart({ chart, overlay: live.get('tp') })
    t.onPressedMoveEnd({ chart, overlay: live.get('tp') }) // no movement
    expect(cb.onMoveTp).not.toHaveBeenCalled()

    t.onPressedMoveStart({ chart, overlay: live.get('tp') })
    live.get('tp').points = [{ value: 31100 }]
    t.onPressedMoving({ chart, overlay: live.get('tp') })
    t.onPressedMoveEnd({ chart, overlay: live.get('tp') })
    expect(cb.onMoveTp).toHaveBeenCalledWith(31100)
    expect(live.get('tp').points).toEqual([{ value: 31040 }]) // restored to the authoritative price
    expect(live.get('tp').extendData.price).toBe(31040)
  })

  it('click on the X box closes/removes/cancels, click on the tag body does nothing', () => {
    const { chart, live } = fakeChart()
    const cb = callbacks()
    syncTradeOverlays(chart, view({ orders: [order()] }), cb)
    const t = registered[0]!
    const xOf = (id: string) => { const l = tagLayout(live.get(id).extendData.text, true, (s, z) => s.length * z * 0.5); return { inX: l.closeX0 + 4, inTag: l.x + 3 } }
    for (const id of ['pos', 'sl', 'tp', 'ord-7']) {
      t.onClick({ chart, overlay: live.get(id), x: xOf(id).inTag })
      t.onClick({ chart, overlay: live.get(id), x: xOf(id).inX })
    }
    expect(cb.onClosePosition).toHaveBeenCalledTimes(1)
    expect(cb.onRemoveSl).toHaveBeenCalledTimes(1)
    expect(cb.onRemoveTp).toHaveBeenCalledTimes(1)
    expect(cb.onCancelOrder).toHaveBeenCalledWith(7)
    expect(cb.onCancelOrder).toHaveBeenCalledTimes(1)
  })

  it('figures: full-width line, tag with text, X box; line/tag/X ignore right-click', () => {
    const { chart, live } = fakeChart()
    syncTradeOverlays(chart, view(), callbacks())
    const figs = registered[0]!.createPointFigures({ overlay: live.get('sl'), coordinates: [{ x: 0, y: 120 }], bounding: { width: 800 } })
    expect(figs.map((f: any) => f.key)).toEqual(['hit', 'line', 'tag', 'x'])
    expect(figs[1].attrs.coordinates).toEqual([{ x: 0, y: 120 }, { x: 800, y: 120 }])
    expect(figs[2].attrs.text).toContain('SL')
    for (const f of [figs[0], figs[2], figs[3]]) expect(f.ignoreEvent).toContain('onRightClick')
  })
})

describe('context menu', () => {
  it('lists market orders plus tick-rounded pending orders, disabling the wrong side', () => {
    const items = contextMenuItems(view(), 31000.1)
    expect(items.map((i) => i.label)).toEqual([
      'Buy Market', 'Sell Market', 'Buy Limit @ 31,000.00', 'Sell Limit @ 31,000.00', 'Buy Stop @ 31,000.00', 'Sell Stop @ 31,000.00',
    ])
    expect(items.map((i) => i.enabled)).toEqual([true, true, true, false, false, true]) // price is below the 31030 market
    expect(items[2]!.req).toEqual({ side: 'buy', type: 'limit', price: 31000 })
    expect(contextMenuItems(view({ lastPrice: null }), 1).every((i) => i.enabled)).toBe(true)
  })

  it('pixelToPrice converts through convertFromPixel (array in, array out) relative to the candle pane', () => {
    const convert = vi.fn(() => [{ value: 31234.5 }])
    const chart = {
      getDom: () => ({ getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 400 }) }),
      convertFromPixel: convert,
    } as any
    expect(pixelToPrice(chart, 150, 250)).toBe(31234.5)
    expect(convert).toHaveBeenCalledWith([{ x: 50, y: 200 }], { paneId: 'candle_pane' })
    expect(pixelToPrice(chart, 50, 250)).toBeNull() // left of the pane
    expect(pixelToPrice(chart, 150, 500)).toBeNull() // below the pane
  })
})
