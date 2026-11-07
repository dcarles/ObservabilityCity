// The small stage an event is played on: a patch of ground in the sea with a little town on it, drawn in the active theme's own colours.

import * as THREE from 'three'
import { palette } from '../themes/active'
import { lambert } from './models'
import { rng } from './rig'

export interface Building {
  grp: THREE.Group
  x: number
  z: number
  w: number
  d: number
  h: number
}

export interface MiniTown {
  group: THREE.Group
  buildings: Building[]
  /** The middle of each block of buildings. */
  centres: [number, number][]
}

/** The patch of ground itself. Its top is at y = 0 and it reaches down into the sea. */
export function island(parent: THREE.Object3D, w: number, d: number, colour: string = palette.island.grass): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 1, d), lambert(colour))
  m.position.y = -0.5
  m.receiveShadow = true
  parent.add(m)
  return m
}

/** Blocks of houses along streets: a few boxes with flat roofs, in the colours of the theme's own buildings. */
export function miniTown(parent: THREE.Object3D, o: { cols: number; rows: number; seed: number; bodies?: string[]; roofs?: string[]; road?: string }): MiniTown {
  const R = rng(o.seed)
  const b = palette.building
  const bodies = o.bodies ?? [b.apiBody, b.functionStone, b.gatewayStone, b.egressBody, b.brokerWall, b.dbTank]
  const roofs = o.roofs ?? [b.workerRoof, b.functionRoof, b.brokerRoof, b.gatewayAccent]
  const group = new THREE.Group()
  parent.add(group)
  const gap = 11
  const road = new THREE.Mesh(new THREE.BoxGeometry(o.cols * gap + 2, 0.04, o.rows * gap + 2), lambert(o.road ?? palette.island.road))
  road.position.y = 0.02
  road.receiveShadow = true
  group.add(road)
  const buildings: Building[] = []
  const centres: [number, number][] = []
  for (let i = 0; i < o.cols; i++)
    for (let j = 0; j < o.rows; j++) {
      const cx = (i - (o.cols - 1) / 2) * gap
      const cz = (j - (o.rows - 1) / 2) * gap
      centres.push([cx, cz])
      const pad = new THREE.Mesh(new THREE.BoxGeometry(8, 0.12, 8), lambert(palette.island.plot))
      pad.position.set(cx, 0.06, cz)
      pad.receiveShadow = true
      group.add(pad)
      const n = 2 + Math.floor(R() * 2)
      for (let k = 0; k < n; k++) {
        const w = 2.4 + R() * 1.8
        const d = 2.4 + R() * 1.8
        const h = 2.5 + R() * 5.5
        const x = cx + (k % 2 ? 1 : -1) * (1 + R() * 1.4)
        const z = cz + (k > 1 ? 1 : -1) * (1 + R() * 1.4)
        const grp = new THREE.Group()
        grp.position.set(x, 0, z)
        group.add(grp)
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lambert(bodies[Math.floor(R() * bodies.length)]))
        body.position.y = h / 2
        body.castShadow = body.receiveShadow = true
        grp.add(body)
        const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.2, d + 0.2), lambert(roofs[Math.floor(R() * roofs.length)]))
        roof.position.y = h + 0.1
        roof.castShadow = true
        grp.add(roof)
        buildings.push({ grp, x, z, w, d, h })
      }
    }
  return { group, buildings, centres }
}
