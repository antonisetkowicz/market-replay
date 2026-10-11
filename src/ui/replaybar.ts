import { h } from './dom'

export const SPEEDS = [{ label: '10s', ms: 10000 }, { label: '3s', ms: 3000 }, { label: '1s', ms: 1000 }, { label: '0.5s', ms: 500 }, { label: '0.3s', ms: 300 }, { label: '0.1s', ms: 100 }]

export interface ReplayBarApi { setPlaying(p: boolean): void; setSpeed(i: number): void }

export function mountReplayBar(host: HTMLElement, cb: { onPlay(): void; onStep(): void; onSlower(): void; onFaster(): void; onExit(): void; onReselect(): void }): ReplayBarApi {
  const play = h('button', { title: 'Play / Pause (Shift+Right)', onclick: cb.onPlay }, '▶')
  const speed = h('span', { class: 'speed', title: 'Update interval' }, '1s')
  host.append(
    h('button', { title: 'Select a new start bar', onclick: cb.onReselect }, 'Select bar'),
    h('div', { class: 'tb-sep' }), play,
    h('button', { title: 'Next bar (Right)', onclick: cb.onStep }, '⏭'),
    h('button', { title: 'Slower', onclick: cb.onSlower }, '−'), speed,
    h('button', { title: 'Faster', onclick: cb.onFaster }, '+'),
    h('div', { class: 'tb-sep' }),
    h('button', { title: 'Exit replay', onclick: cb.onExit }, '✕'),
  )
  return {
    setPlaying: (p) => { play.textContent = p ? '❚❚' : '▶' },
    setSpeed: (i) => { speed.textContent = SPEEDS[i]?.label ?? '' },
  }
}
