// Pure order-form maths for the side panel (no DOM): size units, SL/TP unit conversion, previews, R:R.
import type { Side } from '../types'
import { roundQty, roundToTick } from '../broker/broker'
import { money } from './dom'

/** SL/TP field units: distance (pts/pips), absolute price, dollars (risk / reward). */
export type ExitUnit = 'dist' | 'price' | 'usd'
export const nextUnit = (u: ExitUnit): ExitUnit => (u === 'dist' ? 'price' : u === 'price' ? 'usd' : 'dist')
export const unitText = (u: ExitUnit, distUnit: string): string => (u === 'dist' ? distUnit : u === 'price' ? 'price' : '$')

/** What the maths needs about the instrument + the order being built. `contracts` is the size in contracts (lots already converted). */
export interface ExitCtx { unitSize: number; pointValue: number; contracts: number; tick: number }
export interface SizeCtx { symbol: string; pointValue: number; unit: string; unitSize: number; lotContracts?: number; qtyStep?: number }

const round8 = (x: number): number => Math.round(x * 1e8) / 1e8
const dir = (side: Side): 1 | -1 => (side === 'buy' ? 1 : -1)
const sig = (x: number): number => Number(x.toPrecision(8))

/** Quantity entry: forex/gold are typed in lots (contracts = lots * lotContracts), futures in contracts. */
export const toContracts = (display: number, lotContracts?: number): number => roundQty(display * (lotContracts ?? 1))
export const toDisplay = (contracts: number, lotContracts?: number): number => round8(contracts / (lotContracts ?? 1))
/** Smallest increment of the qty input (display units): 0.01 lot for forex/gold, qtyStep contracts for futures. */
export const displayStep = (c: Pick<SizeCtx, 'lotContracts' | 'qtyStep'>): number => round8((c.qtyStep ?? 1) / (c.lotContracts ?? 1))
export const fmtSize = (contracts: number, c: Pick<SizeCtx, 'lotContracts'>): string =>
  c.lotContracts ? `${toDisplay(contracts, c.lotContracts).toFixed(2)} lot` : String(contracts)

/** Live size hint: '1 MNQ = $2.00 / pt' (futures) or '0.35 lot · $3.50 / pip' (forex/gold). */
export function sizeHint(displayQty: number, c: SizeCtx): string {
  if (!(displayQty > 0) || !Number.isFinite(displayQty)) return ''
  const per = `${money(c.pointValue * c.unitSize * toContracts(displayQty, c.lotContracts))} / ${c.unit.replace(/s$/, '')}`
  return c.lotContracts ? `${displayQty.toFixed(2)} lot · ${per}` : `${displayQty} ${c.symbol.split(' ')[0]} = ${per}`
}

/** Dollar P&L of moving from `entry` to `price` for `contracts` (cents-rounded). */
export const pnlAt = (side: Side, entry: number, price: number, pointValue: number, contracts: number): number =>
  Math.round((price - entry) * dir(side) * pointValue * contracts * 100) / 100

/** Price distance (> 0) a field value stands for, or undefined when empty/invalid. Price unit measures from `ref`. */
export function distOf(unit: ExitUnit, value: number, ref: number, c: ExitCtx): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (unit === 'dist') return value * c.unitSize
  if (unit === 'price') return Number.isFinite(ref) && ref > 0 && value !== ref ? Math.abs(ref - value) : undefined
  return c.contracts > 0 ? value / (c.pointValue * c.contracts) : undefined
}

/** Absolute SL/TP price for `side` from a field value: SL on the losing side of `ref`, TP on the winning side. */
export function exitPrice(kind: 'sl' | 'tp', side: Side, ref: number, unit: ExitUnit, value: number, c: ExitCtx): number | undefined {
  if (unit === 'price') return Number.isFinite(value) && value > 0 ? roundToTick(value, c.tick) : undefined
  const d = distOf(unit, value, ref, c)
  return d === undefined ? undefined : roundToTick(ref + (kind === 'sl' ? -1 : 1) * dir(side) * d, c.tick)
}

/** Re-express a field value in another unit (dist <-> $ is exact); undefined when the target is 'price' (needs a side) or the value is invalid. */
export function convertUnit(from: ExitUnit, to: ExitUnit, value: number, ref: number, c: ExitCtx): number | undefined {
  const d = distOf(from, value, ref, c)
  if (d === undefined || to === 'price') return undefined
  return to === 'dist' ? sig(d / c.unitSize) : Math.round(d * c.pointValue * c.contracts * 100) / 100
}

/** One-line preview, e.g. 'SL Buy 31,180.25 / Sell 31,219.75 · -$200.00 · 20 pts'. '' while the field is empty/invalid. */
export function previewLine(kind: 'sl' | 'tp', unit: ExitUnit, value: number, ref: number | undefined, c: ExitCtx, precision: number, distLabel: string): string {
  if (ref === undefined) return ''
  const fmt = (p: number): string => p.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision })
  const d = distOf(unit, value, ref, c)
  if (d === undefined) return ''
  const label = kind.toUpperCase()
  const pnl = (kind === 'sl' ? -1 : 1) * Math.round(d * c.pointValue * c.contracts * 100) / 100
  const tail = `${money(pnl)} · ${sig(Number((d / c.unitSize).toFixed(2)))} ${distLabel}`
  if (unit === 'price') return `${label} ${fmt(roundToTick(value, c.tick))} · ${tail}`
  const buy = exitPrice(kind, 'buy', ref, unit, value, c), sell = exitPrice(kind, 'sell', ref, unit, value, c)
  return buy === undefined || sell === undefined ? '' : `${label} Buy ${fmt(buy)} / Sell ${fmt(sell)} · ${tail}`
}

/**
 * R:R button: TP field value (and unit) giving `mult` x the SL distance. A 'price' TP needs a side, known only when the SL is also a price;
 * otherwise it falls back to a distance TP.
 */
export function rrTarget(slUnit: ExitUnit, slValue: number, tpUnit: ExitUnit, mult: number, ref: number | undefined, c: ExitCtx): { unit: ExitUnit; value: number } | undefined {
  if (ref === undefined) return undefined
  const sl = distOf(slUnit, slValue, ref, c)
  if (sl === undefined) return undefined
  const d = sl * mult
  if (tpUnit === 'price' && slUnit === 'price') return { unit: 'price', value: roundToTick(ref + (slValue < ref ? 1 : -1) * d, c.tick) }
  if (tpUnit === 'usd') return { unit: 'usd', value: Math.round(d * c.pointValue * c.contracts * 100) / 100 }
  return { unit: 'dist', value: sig(d / c.unitSize) }
}
