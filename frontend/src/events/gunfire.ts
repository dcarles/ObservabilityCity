// Draws the shots an Armoury has scheduled: a muzzle flash and a streak of tracer for every shot, and a puff where it lands.

import * as THREE from 'three'
import type { Armoury, Shot } from './combat'
import { MuzzleFlash, Puffs, Tracer } from './models'
import { EVENT_COLOURS as C } from './colours'

interface Rig {
  flash: MuzzleFlash
  tracers: Tracer[]
  impacts: THREE.Mesh[]
}

export class Gunfire {
  private readonly rigs: Rig[]
  private readonly puffs: Puffs
  private readonly lists: Shot[][]

  /**
   * `muzzle(i, to)` says where shooter `i`'s muzzle is right now; `size(i)` how big its flash is; `impact(target)` the colour of the puff where a
   * bullet lands on that target.
   */
  constructor(
    root: THREE.Object3D,
    private readonly armoury: Armoury,
    private readonly muzzle: (i: number, to: THREE.Vector3) => THREE.Vector3,
    private readonly size: (i: number) => number = () => 1,
    private readonly impact: (target: string) => number = () => C.blood,
  ) {
    this.puffs = new Puffs(root)
    this.lists = armoury.shooters.map((_, i) => armoury.of(i))
    this.rigs = armoury.shooters.map(() => ({
      flash: new MuzzleFlash(root),
      tracers: [0, 1, 2].map(() => new Tracer(root)),
      impacts: [0, 1].map(() => this.puffs.make(0xffffff)),
    }))
  }

  /** The point the shooter is looking at (the last thing it fired at, for a moment after), or null when it is not firing. */
  aim(shooters: readonly number[], t: number): THREE.Vector3 | null {
    for (const i of shooters) {
      const sh = this.armoury.shooters[i]
      if (t < sh.from || t > sh.until) continue
      const list = this.lists[i]
      for (let k = list.length - 1; k >= 0; k--) if (list[k].t <= t + 0.3) return t - list[k].t < 1.4 ? list[k].to : null
    }
    return null
  }

  /** How hard the shooter has just been pushed back by its last shot, 0 when it is not firing. */
  recoil(shooters: readonly number[], t: number): number {
    let r = 0
    for (const i of shooters) {
      const list = this.lists[i]
      for (let k = list.length - 1; k >= 0; k--) if (list[k].t <= t) {
        r = Math.max(r, 0.1 * Math.exp(-(t - list[k].t) * 16))
        break
      }
    }
    return r
  }

  update(t: number): void {
    this.armoury.shooters.forEach((sh, i) => {
      const rig = this.rigs[i]
      let flash: { s: Shot; k: number } | null = null
      let n = 0
      let imp = 0
      for (const s of this.lists[i]) {
        if (s.t > t) break
        if (t - s.t < 0.07) flash = { s, k: 1 - (t - s.t) / 0.07 }
        if (t < s.hit && n < rig.tracers.length) rig.tracers[n++].show(this.muzzle(i, s.to), s.to, (t - s.t) / Math.max(0.02, s.hit - s.t))
        if (t >= s.hit && t < s.hit + 0.3 && imp < rig.impacts.length) {
          const u = (t - s.hit) / 0.3
          const m = rig.impacts[imp++]
          ;(m.material as THREE.MeshBasicMaterial).color.setHex(this.impact(s.target))
          this.puffs.set(m, s.to, 0.2 + u * 0.55, 0.85 * (1 - u))
        }
      }
      for (let k = n; k < rig.tracers.length; k++) rig.tracers[k].hide()
      for (let k = imp; k < rig.impacts.length; k++) this.puffs.hide(rig.impacts[k])
      if (flash && t >= sh.from && t <= sh.until + 0.1) rig.flash.show(this.muzzle(i, flash.s.to), flash.s.to, flash.k, this.size(i))
      else rig.flash.hide()
    })
  }
}

