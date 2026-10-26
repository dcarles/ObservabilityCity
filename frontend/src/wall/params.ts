// Wall mode: the town on a big screen nobody is standing at. ?wall=1 turns it on; the rest of the address says how.
//   ?wall=1                          the whole town, Dusk, the tour and the status strip
//   ?wall=1&islands=pay,frd          a view for one team: only those islands, and the tour visits only what it shows
//   ?wall=1&hold=30                  seconds the tour stays at each stop (default 20)
//   ?wall=1&quality=low              the lowest quality, for a screen driven by a small box (otherwise Medium, stepping down if frames run long)
//   ?wall=1&light=day                Day instead of Dusk

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

export function parseWall(search: string): WallParams {
  const q = new URLSearchParams(search)
  const flag = q.get('wall')
  const on = flag !== null && flag !== '0' && flag.toLowerCase() !== 'false' && flag.toLowerCase() !== 'off'
  return {
    on,
    hold: seconds(q.get('hold'), DEFAULT_HOLD_SECONDS, MIN_HOLD_SECONDS),
    retry: seconds(q.get('retry'), DEFAULT_RETRY_SECONDS, 0.2),
  }
}
