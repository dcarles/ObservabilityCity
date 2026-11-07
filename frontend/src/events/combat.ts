// Who shoots whom, and when. The schedule is worked out once, before anything is drawn, from where everyone stands: a shot is fired so that
// its bullet lands exactly when the target falls, a gun never fires faster than it can, and a shooter only fires while it is in place.

import * as THREE from 'three'
import { V } from './rig'

export interface Shooter {
  id: string
  /** Where the muzzle is while this shooter is in place. */
  at: THREE.Vector3
  /** The time it is in place from and until. */
  from: number
  until: number
  /** The least time between two shots. */
  gap: number
  /** The farthest it shoots. */
  range: number
}

export interface Shot {
  shooter: number
  /** When the trigger is pulled. */
  t: number
  /** When the bullet lands. */
  hit: number
  /** What it lands on, and where. */
  target: string
  to: THREE.Vector3
}

/** A fall that needs `hits` bullets, the last landing at `at`. */
export interface Kill {
  target: string
  at: number
  hits: number
  /** Where the target is at a time (its chest). */
  where: (t: number) => THREE.Vector3
}

const SPEED = 90

export class Armoury {
  readonly shots: Shot[] = []
  constructor(readonly shooters: Shooter[]) {}

  private free(i: number, t: number): boolean {
    const s = this.shooters[i]
    if (t < s.from || t > s.until) return false
    return this.shots.every((x) => x.shooter !== i || Math.abs(x.t - t) >= s.gap)
  }

  private fire(i: number, hit: number, target: string, where: (t: number) => THREE.Vector3): boolean {
    const s = this.shooters[i]
    let to = where(hit)
    const travel = to.distanceTo(s.at) / SPEED
    const t = hit - travel
    if (!this.free(i, t)) return false
    to = where(hit)
    this.shots.push({ shooter: i, t, hit, target, to })
    return true
  }

  /** Schedules the bullets that bring a target down. Returns how many found a gun to fire them. */
  kill(k: Kill): number {
    let placed = 0
    for (let h = 0; h < k.hits; h++) {
      const want = k.at - (k.hits - 1 - h) * 0.16
      let done = false
      // the nearest gun that is in place and in range, then a little earlier if all of them are busy
      for (let slip = 0; slip < 8 && !done; slip++) {
        const hit = want - slip * 0.09
        const order = this.shooters
          .map((s, i) => ({ i, d: s.at.distanceTo(k.where(hit)) }))
          .filter((o) => o.d <= this.shooters[o.i].range)
          .sort((a, b) => a.d - b.d)
        for (const o of order) {
          if (this.fire(o.i, hit, k.target, k.where)) {
            done = true
            placed++
            break
          }
        }
      }
    }
    return placed
  }

  /** Every gun in place (or only those listed) fires at one target, over and over, from `from` to `until`. `period` is the time between a gun's shots. */
  volley(target: string, where: (t: number) => THREE.Vector3, from: number, until: number, period: number, only?: readonly number[]): void {
    this.shooters.forEach((s, i) => {
      if (only && !only.includes(i)) return
      for (let t = Math.max(from, s.from) + (i % 5) * 0.07; t < Math.min(until, s.until); t += period + (i % 3) * 0.05) {
        if (s.at.distanceTo(where(t)) > s.range) continue
        this.fire(i, t + where(t).distanceTo(s.at) / SPEED, target, where)
      }
    })
  }

  /** The shots of one shooter, in the order they are fired. */
  of(i: number): Shot[] {
    return this.shots.filter((s) => s.shooter === i).sort((a, b) => a.t - b.t)
  }
}

/** A point halfway up a standing person, for a bullet to land on. */
export const chest = (p: THREE.Vector3, h = 1.1): THREE.Vector3 => p.clone().add(V(0, h, 0))
