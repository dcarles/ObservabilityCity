// Wall mode, put together: the director decides, the strip shows, and this moves the camera.

import type * as THREE from 'three'
import type { ConnectionState } from '../connection'
import type { Snapshot } from '../types'
import type { Focus } from './attention'
import { WallDirector, type Stop } from './director'
import { stripModel } from './stripModel'
import { WallStrip } from './strip'

export interface WallCamera {
  /** Where the camera should stand to look at this, or null when it is not on screen. */
  focusOf(focus: Focus): { target: THREE.Vector3; distance: number } | null
  /** Moves the camera. `cut` jumps there at once; otherwise it glides. */
  go(target: THREE.Vector3, distance: number, cut: boolean): void
  home(cut: boolean): void
  /** Keeps a building's name board up while the camera is on it (null for none). */
  select(id: string | null): void
}

const clock = (fraction: number): string => {
  const minutes = Math.floor(fraction * 24 * 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export class WallMode {
  readonly director: WallDirector
  readonly strip = new WallStrip()
  private snap: Snapshot | null = null
  private connection: ConnectionState = 'connecting'

  constructor(hold: number, private readonly camera: WallCamera) {
    this.director = new WallDirector(hold)
  }

  onSnapshot(s: Snapshot, now: number): void {
    this.snap = s
    const stop = this.director.update(s, now)
    if (stop) this.show(stop)
    this.draw(now)
  }

  tick(now: number): void {
    const stop = this.director.tick(now)
    if (stop) this.show(stop)
    this.draw(now)
  }

  setConnection(state: ConnectionState): void {
    this.connection = state
    this.strip.setConnection(state)
  }

  private show(stop: Stop): void {
    this.camera.select(stop.focus.kind === 'building' ? stop.focus.id : null)
    if (stop.focus.kind === 'home') { this.camera.home(stop.cut); return }
    const f = this.camera.focusOf(stop.focus)
    // a place that is not on screen (an island the view left out) is skipped by going home, never left half-way
    if (f) this.camera.go(f.target, f.distance, stop.cut)
    else this.camera.home(stop.cut)
  }

  private draw(now: number): void {
    const s = this.snap
    if (!s) return
    this.strip.render({
      model: stripModel(s),
      townName: s.townName,
      environmentName: s.environmentName,
      caption: this.director.current?.caption ?? '',
      note: this.director.note?.text ?? null,
      clock: clock(s.dayFraction),
    })
    this.strip.setPulse(this.director.pulsing(now))
    this.strip.setConnection(this.connection)
  }

  /** What the wall is doing, for tests. */
  status() {
    return {
      mode: this.director.mode,
      stop: this.director.current ? { key: this.director.current.key, kind: this.director.current.kind, caption: this.director.current.caption, cut: this.director.current.cut } : null,
      note: this.director.note?.text ?? null,
      cuts: this.director.cuts,
      strip: this.strip.read(),
    }
  }
}
