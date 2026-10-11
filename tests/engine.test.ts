import { describe, it, expect, vi } from 'vitest'
import { ReplayEngine } from '../src/replay/engine'
import type { Bar } from '../src/types'
import { createAccount, onBar, placeOrder } from '../src/broker/broker'
import { INSTRUMENTS } from '../src/instruments'

const mk = (n: number): Bar[] => Array.from({ length: n }, (_, i) => ({ t: i * 60000, o: i, h: i + 1, l: i - 1, c: i, v: 1 }))

describe('ReplayEngine', () => {
  it('never exposes future bars', () => {
    const e = new ReplayEngine(); e.load(mk(10)); e.seek(3)
    expect(e.visible).toHaveLength(4)
    e.step()
    expect(e.visible.at(-1)?.t).toBe(4 * 60000)
  })
  it('stops at the end and reports false', () => {
    const e = new ReplayEngine(); e.load(mk(3)); e.seek(1)
    expect(e.step()).toBe(true); expect(e.step()).toBe(false); expect(e.snapshot.idx).toBe(2)
  })
  it('plays on a timer and pauses', () => {
    vi.useFakeTimers()
    const e = new ReplayEngine(); e.load(mk(10)); e.setSpeed(100); e.seek(0); e.play()
    vi.advanceTimersByTime(350); e.pause()
    expect(e.snapshot.idx).toBe(3)
    vi.advanceTimersByTime(1000); expect(e.snapshot.idx).toBe(3)
    vi.useRealTimers()
  })
  it('rejects absurd speeds and ignores play before a start point', () => {
    const e = new ReplayEngine(); e.load(mk(5))
    expect(() => e.setSpeed(1)).toThrow()
    e.play(); expect(e.snapshot.playing).toBe(false)
  })
})

describe('ReplayEngine.append (next data window during replay)', () => {
  const after = (from: number, n: number): Bar[] => Array.from({ length: n }, (_, i) => ({ t: (from + i) * 60000, o: 1, h: 2, l: 0, c: 1, v: 1 }))
  it('extends the loaded bars without touching idx, playing or listeners', () => {
    const e = new ReplayEngine(); e.load(mk(5)); e.seek(3)
    const seen: (Bar | null)[] = []; e.subscribe((_, b) => seen.push(b))
    e.append(after(5, 3))
    expect(e.snapshot.bars).toHaveLength(8); expect(e.snapshot.idx).toBe(3); expect(seen).toEqual([])
  })
  it('never exposes appended bars early (no lookahead) and reveals them in order', () => {
    const e = new ReplayEngine(); e.load(mk(3)); e.seek(2)
    e.append(after(3, 2))
    expect(e.visible).toHaveLength(3); expect(e.visible.at(-1)?.t).toBe(2 * 60000)
    expect(e.step()).toBe(true); expect(e.snapshot.idx).toBe(3); expect(e.visible.at(-1)?.t).toBe(3 * 60000)
    expect(e.step()).toBe(true); expect(e.step()).toBe(false)
  })
  it('keeps a running replay going across the append (timer not reset)', () => {
    vi.useFakeTimers()
    const e = new ReplayEngine(); e.load(mk(4)); e.setSpeed(100); e.seek(0); e.play()
    vi.advanceTimersByTime(250); expect(e.snapshot.idx).toBe(2)
    e.append(after(4, 10))
    expect(e.snapshot.playing).toBe(true)
    vi.advanceTimersByTime(300); expect(e.snapshot.idx).toBe(5)       // crossed the old end (idx 3) without pausing
    e.pause(); vi.useRealTimers()
  })
  it('resumes playback that ran dry at the old end once the next window arrives (slow load)', () => {
    vi.useFakeTimers()
    const e = new ReplayEngine(); e.load(mk(3)); e.setSpeed(100); e.seek(1); e.play()
    vi.advanceTimersByTime(500)
    expect(e.snapshot.playing).toBe(false); expect(e.snapshot.idx).toBe(2)      // ran out of bars
    e.append(after(3, 10))
    expect(e.snapshot.playing).toBe(true)
    vi.advanceTimersByTime(250); expect(e.snapshot.idx).toBe(4)
    e.pause(); vi.useRealTimers()
  })
  it('does NOT auto-resume when the user paused / stepped at the end', () => {
    const e = new ReplayEngine(); e.load(mk(3)); e.seek(2)
    e.step()                                  // user step at the end: not "playing"
    e.append(after(3, 5)); expect(e.snapshot.playing).toBe(false)
    e.seek(7); e.append(after(8, 2)); expect(e.snapshot.playing).toBe(false)
  })
  it('is forward-only: rejects overlap, duplicates and disorder atomically', () => {
    const e = new ReplayEngine(); e.load(mk(5)); e.seek(1)
    const before = e.snapshot.bars
    expect(() => e.append(after(4, 2))).toThrow(/forward-only/)        // starts at last loaded bar (t = 4)
    expect(() => e.append([...after(5, 1), ...after(5, 1)])).toThrow()  // duplicate inside the batch
    expect(() => e.append([...after(7, 1), ...after(6, 1)])).toThrow()  // disorder
    expect(e.snapshot.bars).toBe(before)
    e.append([]); expect(e.snapshot.bars).toBe(before)
  })
  it('appends to an empty engine', () => {
    const e = new ReplayEngine(); e.append(after(0, 2)); expect(e.snapshot.bars).toHaveLength(2)
  })
  it('account state carries across the append: an order resting at the old window end fills on an appended bar', () => {
    const e = new ReplayEngine(); e.load(mk(4)); e.seek(3)
    let acc = placeOrder(createAccount(INSTRUMENTS[0]!), { side: 'buy', type: 'limit', qty: 1, price: 100 }, e.snapshot.bars[3]!.t, 5).state
    e.subscribe((_, bar) => { if (bar) acc = onBar(acc, bar).state })
    e.append([{ t: 4 * 60000, o: 50, h: 60, l: 40, c: 55, v: 1 }])
    expect(acc.orders).toHaveLength(1)                     // append revealed nothing
    e.step()
    expect(acc.orders).toHaveLength(0); expect(acc.position).toMatchObject({ side: 'buy', avgPrice: 50 })   // gap-through fill at the appended bar's open
  })
})
