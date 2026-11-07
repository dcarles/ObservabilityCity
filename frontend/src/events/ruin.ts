// What an event does to the real buildings, for show only: a dark scorch laid over a building and fire on its roof from the moment it is hit.
// Nothing of the building itself is touched (the effects are separate objects in the event's own group), so when the event ends and its group
// is removed the town is exactly as it was.

import * as THREE from 'three'
import type { Block } from './arena'
import { Fire } from './models'
import { clamp } from './rig'

export class Ruin {
  private readonly parts: { scorch: THREE.Mesh; fires: { f: Fire; size: number }[]; top: number }[]

  /** `scale` sizes the flames (1 for a building well alight). */
  constructor(parent: THREE.Object3D, blocks: readonly Block[], scale = 1) {
    this.parts = blocks.map((b, i) => {
      const w = b.x1 - b.x0
      const d = b.z1 - b.z0
      const scorch = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x120c08, transparent: true, opacity: 0, depthWrite: false }))
      scorch.scale.set(w + 0.2, b.h + 0.2, d + 0.2)
      scorch.position.set((b.x0 + b.x1) / 2, b.h / 2, (b.z0 + b.z1) / 2)
      scorch.visible = false
      parent.add(scorch)
      const n = w * d > 40 ? 2 : 1
      const fires = Array.from({ length: n }, (_, k) => {
        const size = (0.8 + Math.min(w, d) * 0.05) * scale
        const f = new Fire(size, i * 3.1 + k * 1.7)
        const at = new THREE.Vector3(b.x0 + (w * (k + 1)) / (n + 1), b.h, (b.z0 + b.z1) / 2)
        f.root.position.copy(at)
        f.root.visible = false
        parent.add(f.root)
        return { f, size }
      })
      return { scorch, fires, top: b.h }
    })
  }

  /** `since(i)` is the time building `i` is first hit (a huge number if it never is). */
  update(t: number, since: (i: number) => number): void {
    this.parts.forEach((p, i) => {
      const dt = t - since(i)
      const on = dt >= 0
      p.scorch.visible = on
      if (on) (p.scorch.material as THREE.MeshBasicMaterial).opacity = 0.34 * clamp(dt / 1.5)
      for (const { f, size } of p.fires) {
        f.root.visible = on
        if (on) {
          f.root.scale.setScalar(Math.max(0.05, clamp(dt / 1.2)) * size)
          f.update(t)
        }
      }
    })
  }
}
