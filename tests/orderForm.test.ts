import { describe, expect, it } from 'vitest'
import { convertUnit, displayStep, distOf, exitPrice, fmtSize, nextUnit, pnlAt, previewLine, rrTarget, sizeHint, toContracts, toDisplay, type ExitCtx } from '../src/ui/orderForm'

const mnq: ExitCtx = { unitSize: 1, pointValue: 2, contracts: 2, tick: 0.25 }
const eur: ExitCtx = { unitSize: 0.0001, pointValue: 1000, contracts: 35, tick: 0.00001 }   // 0.35 lot

describe('size units', () => {
  it('lots <-> contracts is decimal-safe', () => {
    expect(toContracts(0.35, 100)).toBe(35)
    expect(toContracts(0.07, 100)).toBe(7)
    expect(toDisplay(35, 100)).toBe(0.35)
    expect(toContracts(1.5)).toBe(1.5)
  })
  it('input step', () => {
    expect(displayStep({ lotContracts: 100 })).toBe(0.01)
    expect(displayStep({})).toBe(1)
    expect(displayStep({ qtyStep: 0.01 })).toBe(0.01)
  })
  it('hints', () => {
    expect(sizeHint(1, { symbol: 'MNQ', pointValue: 2, unit: 'pts', unitSize: 1 })).toBe('1 MNQ = $2.00 / pt')
    expect(sizeHint(0.35, { symbol: 'EURUSD', pointValue: 1000, unit: 'pips', unitSize: 0.0001, lotContracts: 100 })).toBe('0.35 lot · $3.50 / pip')
    expect(sizeHint(0, { symbol: 'NQ', pointValue: 20, unit: 'pts', unitSize: 1 })).toBe('')
    expect(fmtSize(35, { lotContracts: 100 })).toBe('0.35 lot')
    expect(fmtSize(2, {})).toBe('2')
  })
})

describe('SL/TP units', () => {
  it('cycles', () => { expect([nextUnit('dist'), nextUnit('price'), nextUnit('usd')]).toEqual(['price', 'usd', 'dist']) })
  it('distance', () => {
    expect(exitPrice('sl', 'buy', 31200, 'dist', 20, mnq)).toBe(31180)
    expect(exitPrice('sl', 'sell', 31200, 'dist', 20, mnq)).toBe(31220)
    expect(exitPrice('tp', 'buy', 31200, 'dist', 40, mnq)).toBe(31240)
    expect(exitPrice('tp', 'sell', 31200, 'dist', 40, mnq)).toBe(31160)
  })
  it('dollars use pointValue x contracts', () => {
    expect(exitPrice('sl', 'buy', 31200, 'usd', 80, mnq)).toBe(31180)   // $80 / ($2 x 2) = 20 pts
    expect(exitPrice('tp', 'buy', 1.1, 'usd', 100, eur)).toBeCloseTo(1.1 + 100 / (1000 * 35), 5)
    expect(exitPrice('sl', 'buy', 31200, 'usd', 80, { ...mnq, contracts: 0 })).toBeUndefined()
  })
  it('price is literal and tick-rounded; invalid is undefined', () => {
    expect(exitPrice('sl', 'buy', 31200, 'price', 31180.1, mnq)).toBe(31180)
    expect(exitPrice('sl', 'buy', 31200, 'dist', 0, mnq)).toBeUndefined()
    expect(exitPrice('sl', 'buy', 31200, 'dist', NaN, mnq)).toBeUndefined()
  })
  it('pips', () => { expect(exitPrice('sl', 'buy', 1.1, 'dist', 10, eur)).toBeCloseTo(1.099, 5) })
  it('convert dist <-> usd, never to price', () => {
    expect(convertUnit('dist', 'usd', 20, 31200, mnq)).toBe(80)
    expect(convertUnit('usd', 'dist', 80, 31200, mnq)).toBe(20)
    expect(convertUnit('price', 'dist', 31180, 31200, mnq)).toBe(20)
    expect(convertUnit('dist', 'price', 20, 31200, mnq)).toBeUndefined()
    expect(distOf('price', 31200, 31200, mnq)).toBeUndefined()
  })
  it('pnl', () => {
    expect(pnlAt('buy', 31200, 31180, 2, 2)).toBe(-80)
    expect(pnlAt('sell', 31200, 31180, 2, 2)).toBe(80)
    expect(pnlAt('buy', 1.1, 1.101, 1000, 35)).toBe(35)
  })
})

describe('preview + R:R', () => {
  it('price unit shows level, P&L and distance', () => {
    expect(previewLine('sl', 'price', 31180, 31200, mnq, 2, 'pts')).toBe('SL 31,180.00 · -$80.00 · 20 pts')
    expect(previewLine('tp', 'price', 31240, 31200, mnq, 2, 'pts')).toBe('TP 31,240.00 · $160.00 · 40 pts')
  })
  it('distance unit shows both sides', () => {
    expect(previewLine('sl', 'dist', 20, 31200, mnq, 2, 'pts')).toBe('SL Buy 31,180.00 / Sell 31,220.00 · -$80.00 · 20 pts')
  })
  it('empty / no ref -> blank', () => {
    expect(previewLine('sl', 'dist', NaN, 31200, mnq, 2, 'pts')).toBe('')
    expect(previewLine('sl', 'dist', 20, undefined, mnq, 2, 'pts')).toBe('')
  })
  it('R:R multiplies the SL distance', () => {
    expect(rrTarget('dist', 20, 'dist', 2, 31200, mnq)).toEqual({ unit: 'dist', value: 40 })
    expect(rrTarget('usd', 80, 'usd', 3, 31200, mnq)).toEqual({ unit: 'usd', value: 240 })
    expect(rrTarget('price', 31180, 'price', 2, 31200, mnq)).toEqual({ unit: 'price', value: 31240 })
    expect(rrTarget('price', 31220, 'price', 1, 31200, mnq)).toEqual({ unit: 'price', value: 31180 })
    expect(rrTarget('dist', 20, 'price', 2, 31200, mnq)).toEqual({ unit: 'dist', value: 40 })   // side unknown -> distance
    expect(rrTarget('dist', 0, 'dist', 2, 31200, mnq)).toBeUndefined()
  })
})
