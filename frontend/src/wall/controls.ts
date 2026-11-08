// The ways in and out of wall mode on a page that is already a wall: Esc, an "Exit wall" chip that shows when the mouse moves, and a "Click for full screen"
// chip (a browser only goes full screen after a click, and a reload drops it). The Wall button calls enterWall; both views share all of this.

import type { Store } from '../lighting'
import { rememberWall, withoutWall } from './params'

type Where = { pathname: string; search: string; hash: string }

/** The Wall button: remember "wall on" in this browser and open the page again as a wall. */
export function enterWall(store: Store | null, to: (address: string) => void = (a) => { window.location.href = a }): void {
  rememberWall(store, true)
  to(withoutWall(window.location as Where))
}

/** Leaves wall mode: forgets it and opens the page again as it was without the wall. */
export function exitWall(store: Store | null, to: (address: string) => void = (a) => { window.location.href = a }): void {
  rememberWall(store, false)
  to(withoutWall(window.location as Where))
}

export const EXIT_SHOWN_MS = 3000
export const FULLSCREEN_OFFER_MS = 20000

export interface WallControls {
  /** What is on screen, for tests. */
  state(): { exitShown: boolean; fullscreenOffered: boolean; fullscreen: boolean }
}

export function startWallControls(store: Store | null, opts: { offerFullscreen?: boolean; leave?: () => void } = {}): WallControls {
  const leave = opts.leave ?? (() => exitWall(store))
  const exit = document.createElement('button')
  exit.id = 'wall-exit'
  exit.className = 'wall-chip'
  exit.type = 'button'
  exit.textContent = 'Exit wall'
  exit.title = 'Leave wall mode (Esc)'
  exit.hidden = true
  const full = document.createElement('button')
  full.id = 'wall-fullscreen'
  full.className = 'wall-chip'
  full.type = 'button'
  full.textContent = 'Click for full screen'
  full.hidden = true
  document.body.append(exit, full)

  let exitTimer: number | undefined
  const showExit = (): void => {
    exit.hidden = false
    window.clearTimeout(exitTimer)
    exitTimer = window.setTimeout(() => { if (!exit.matches(':focus, :hover')) exit.hidden = true }, EXIT_SHOWN_MS)
  }
  const isFull = (): boolean => !!document.fullscreenElement
  const canFull = (): boolean => typeof document.documentElement.requestFullscreen === 'function'
  let fullTimer: number | undefined
  const offer = (): void => {
    if (opts.offerFullscreen === false || !canFull() || isFull()) { full.hidden = true; return }
    full.hidden = false
    window.clearTimeout(fullTimer)
    fullTimer = window.setTimeout(() => { full.hidden = true }, FULLSCREEN_OFFER_MS)
  }

  window.addEventListener('pointermove', showExit, { passive: true })
  window.addEventListener('pointerdown', showExit, { passive: true })
  exit.addEventListener('click', leave)
  let wasFull = isFull()
  full.addEventListener('click', () => {
    full.hidden = true
    void document.documentElement.requestFullscreen().then(() => { wasFull = isFull() }).catch(() => { /* the browser said no: stay a wall */ })
  })
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') leave() })
  // the browser keeps the first Escape for itself when it is full screen: leaving full screen on purpose leaves the wall too
  document.addEventListener('fullscreenchange', () => {
    const now = isFull()
    if (wasFull && !now) leave()
    wasFull = now
    if (!now) offer()
  })
  offer()

  return { state: () => ({ exitShown: !exit.hidden, fullscreenOffered: !full.hidden, fullscreen: isFull() }) }
}
