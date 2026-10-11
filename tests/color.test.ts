import { describe, it, expect } from 'vitest'
import { toRgba } from '../src/chart/color'

describe('toRgba', () => {
  it('converts hex + opacity', () => { expect(toRgba('#2962ff', 0.2)).toBe('rgba(41, 98, 255, 0.2)') })
  it('expands short hex and tolerates missing #', () => { expect(toRgba('f00', 1)).toBe('rgba(255, 0, 0, 1)') })
  it('clamps opacity and rejects NaN', () => { expect(toRgba('#000000', 5)).toBe('rgba(0, 0, 0, 1)'); expect(toRgba('#000000', -1)).toBe('rgba(0, 0, 0, 0)'); expect(toRgba('#000000', NaN)).toBe('rgba(0, 0, 0, 1)') })
  it('falls back to the accent colour for garbage', () => { expect(toRgba('banana', 0.5)).toBe('rgba(41, 98, 255, 0.5)') })
})
