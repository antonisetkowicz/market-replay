import { describe, expect, it } from 'vitest'
import { createAccount, onBar, type AccountState } from '../src/broker/broker'
import { INSTRUMENTS, dataKey, symbolTag } from '../src/instruments'
import { linesView, tradeActions, type LastBar } from '../src/tradeSession'
import { buildLines } from '../src/chart/tradeLines'

const inst = (s: string) => INSTRUMENTS.find((i) => i.symbol === s)!
function harness(symbol = 'MNQ', opts: { fractional?: boolean } = {}, last: LastBar | null = { t: 1000, c: 20000 }) {
  let account: AccountState = createAccount(inst(symbol), 50000, 0, 0, opts)
  const log = { changed: 0, said: [] as string[], size: 1, last }
  const a = tradeActions({ account: () => account, set: (x) => { account = x }, last: () => log.last, changed: () => { log.changed++ }, say: (m) => log.said.push(m), size: () => log.size })
  return { a, log, get account() { return account } }
}
const bar = (t: number, o: number, h: number, l: number, c: number) => ({ t, o, h, l, c, v: 1 })

describe('MNQ / MES instruments', () => {
  it('alias NQ/ES data and tag the symbol', () => {
    expect(dataKey(inst('MNQ'))).toBe('NQ'); expect(dataKey(inst('MES'))).toBe('ES'); expect(dataKey(inst('NQ'))).toBe('NQ')
    expect(symbolTag(inst('MNQ'))).toBe('MNQ (data: NQ)')
    expect(inst('MNQ').pointValue).toBe(2); expect(inst('MES').pointValue).toBe(5)
  })
})

describe('linesView', () => {
  it('futures in contracts, forex in lots with pips', () => {
    const v = linesView(createAccount(inst('MNQ')), 20000)
    expect(v).toMatchObject({ unit: 'contracts', lotFactor: 1, pointValue: 2, tick: 0.25, distUnit: 'pts', distSize: 1 })
    const fx = linesView(createAccount(inst('EURUSD')), 1.1)
    expect(fx).toMatchObject({ unit: 'lots', lotFactor: 0.01, distUnit: 'pips', precision: 5 })
  })
})

describe('trade actions (chart + panel -> broker)', () => {
  it('buy 3 MNQ with SL/TP, drag SL, edit TP, remove SL; every mutation re-renders', () => {
    const h = harness()
    expect(h.a.panel.onOrder({ side: 'buy', type: 'market', qty: 3, sl: 19980, tp: 20040 })).toBeUndefined()
    expect(h.account.position).toMatchObject({ qty: 3, sl: 19980, tp: 20040 })
    let lines = buildLines(linesView(h.account, 20000))
    expect(lines.find((l) => l.id === 'sl')!.text).toBe('SL  -$120.00 · 20 pts')   // 20 pts x $2 x 3
    expect(lines.find((l) => l.id === 'tp')!.text).toBe('TP +$240.00 · 40 pts')
    h.a.chart.onMoveSl(19990.1)   // broker tick-rounds
    expect(h.account.position!.sl).toBe(20000 - 10)
    expect(h.a.panel.onModifyPosition({ tp: 20100 })).toBeUndefined()
    expect(h.account.position!.tp).toBe(20100)
    h.a.chart.onRemoveSl()
    expect(h.account.position!.sl).toBeUndefined()
    lines = buildLines(linesView(h.account, 20000))
    expect(lines.map((l) => l.id)).toEqual(['pos', 'tp'])
    expect(h.log.changed).toBe(4)
  })

  it('rejects an SL on the wrong side, reports it, keeps the state', () => {
    const h = harness()
    h.a.panel.onOrder({ side: 'buy', type: 'market', qty: 1, sl: 19900 })
    h.a.chart.onMoveSl(20010)
    expect(h.log.said).toEqual(['SL must be below entry for a buy'])
    expect(h.account.position!.sl).toBe(19900)
    expect(h.log.changed).toBe(2)   // still re-rendered so the dragged line snaps back
  })

  it('chart menu Buy Limit uses the panel size, fills during replay, carries nothing extra', () => {
    const h = harness('MNQ'); h.log.size = 2
    h.a.chart.onChartOrder({ side: 'buy', type: 'limit', price: 19950 })
    expect(h.account.orders).toHaveLength(1)
    expect(h.account.orders[0]).toMatchObject({ qty: 2, price: 19950, type: 'limit' })
    h.a.chart.onMoveOrder(h.account.orders[0]!.id, 19960)
    expect(h.account.orders[0]!.price).toBe(19960)
    const r = onBar(h.account, bar(2000, 19990, 19995, 19955, 19970))
    expect(r.state.position).toMatchObject({ qty: 2, avgPrice: 19960 })
  })

  it('partial close half, then SL hit closes the rest with the right P&L', () => {
    const h = harness()
    h.a.panel.onOrder({ side: 'buy', type: 'market', qty: 4, sl: 19990 })
    expect(h.a.panel.onClosePartial(2)).toBeUndefined()
    expect(h.account.position).toMatchObject({ qty: 2, sl: 19990 })
    h.log.last = { t: 1500, c: 20005 }
    const r = onBar(h.account, bar(2000, 20000, 20001, 19985, 19988))
    expect(r.state.position).toBeNull()
    expect(r.state.trades.at(-1)).toMatchObject({ qty: 2, exit: 19990, reason: 'sl', pnl: -40 })   // -10 pts x $2 x 2
    expect(buildLines(linesView(r.state, 19988))).toEqual([])
  })

  it('fractional: only when the account switch is on', () => {
    const off = harness('MNQ')
    expect(off.a.panel.onOrder({ side: 'buy', type: 'market', qty: 0.5 })).toMatch(/integer/)
    const on = harness('NQ', { fractional: true })
    expect(on.a.panel.onOrder({ side: 'buy', type: 'market', qty: 0.5 })).toBeUndefined()
    expect(on.account.position!.qty).toBe(0.5)
    expect(on.a.panel.onClosePartial(0.25)).toBeUndefined()
    expect(on.account.position!.qty).toBe(0.25)
    const fx = harness('EURUSD')   // 0.35 lot = 35 contracts
    expect(fx.a.panel.onOrder({ side: 'buy', type: 'market', qty: 35 })).toBeUndefined()
    expect(buildLines(linesView(fx.account, 1.1)).find((l) => l.id === 'pos')!.text).toMatch(/^Long 0\.35 lots/)
  })

  it('without a replay price every action says so', () => {
    const h = harness('MNQ', {}, null)
    expect(h.a.panel.onOrder({ side: 'buy', type: 'market', qty: 1 })).toBe('Start replay first.')
    h.a.chart.onClosePosition()
    expect(h.log.said).toEqual(['Start replay first.'])
  })
})
