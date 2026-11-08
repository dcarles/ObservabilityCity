// Wall mode: the town on a big screen nobody is standing at. ?wall=1 turns it on; the rest of the address says how.
//   ?wall=1                          the whole town, Dusk, the tour and the status strip
//   ?wall=1&islands=pay,frd          a view for one team: only those islands, and the tour visits only what it shows
//   ?wall=1&hold=30                  seconds the tour stays at each stop (default 20)
//   ?wall=1&quality=low              the lowest quality, for a screen driven by a small box (otherwise Medium, stepping down if frames run long)
//   ?wall=1&light=day                Day instead of Dusk
//   ?wall=0                          wall mode off, and forgets a "wall on" this browser remembered
// The Wall button remembers "on" in this browser (oc.wall), so a reload (or a new tab) opens as a wall without anything in the address.

import type { Store } from '../lighting'

export const WALL_KEY = 'oc.wall'
export const DEFAULT_HOLD_SECONDS = 20
export const DEFAULT_RETRY_SECONDS = 5
const MIN_HOLD_SECONDS = 0.5

export interface WallParams {
  on: boolean
  /** Seconds the tour stays at each stop. */
  hold: number
  /** Seconds between two tries to open the live connection again after it was lost. */
  retry: number
}

const seconds = (raw: string | null, fallback: number, min: number): number => {
  const n = raw === null || raw.trim() === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n >= min ? n : fallback
}

/** True when this browser was told to open as a wall (the Wall button). */
export function wallRemembered(store: Store | null): boolean {
  try { return store?.getItem(WALL_KEY) === '1' } catch { return false }
}

export function rememberWall(store: Store | null, on: boolean): void {
  try { store?.setItem(WALL_KEY, on ? '1' : '0') } catch { /* storage blocked */ }
}

/** The address as the wall button leaves it: no `wall` in it, so the remembered choice decides (and ?wall=1 cannot bring it back by accident). */
export function withoutWall(at: { pathname: string; search: string; hash: string }): string {
  const q = new URLSearchParams(at.search)
  q.delete('wall')
  const text = q.toString().replace(/%2C/g, ',')
  return `${at.pathname}${text ? `?${text}` : ''}${at.hash}`
}

/** Wall mode for this page: the address says (?wall=1 on, ?wall=0 off and forgotten), else what this browser remembered. */
export function parseWall(search: string, store: Store | null = null): WallParams {
  const q = new URLSearchParams(search)
  const flag = q.get('wall')
  const off = flag !== null && (flag === '0' || flag.toLowerCase() === 'false' || flag.toLowerCase() === 'off')
  if (off) rememberWall(store, false)
  const on = flag !== null ? !off : wallRemembered(store)
  return {
    on,
    hold: seconds(q.get('hold'), DEFAULT_HOLD_SECONDS, MIN_HOLD_SECONDS),
    retry: seconds(q.get('retry'), DEFAULT_RETRY_SECONDS, 0.2),
  }
}
