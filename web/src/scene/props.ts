import * as THREE from 'three'
import { flat } from '../buildings/mk'
import { palette } from '../themes/harbour-town/palette'
import { GROUND } from './island'

const slabMat = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true })

function slabMesh(w: number, d: number, h: number, color: string, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), slabMat(color))
  m.position.set(x, y + h / 2, z)
  m.receiveShadow = true
  return m
}

/** A straight street along z with pavements and a dashed centre line. */
export function avenue(x: number, z0: number, z1: number, width: number): THREE.Group {
  const g = new THREE.Group()
  const len = Math.abs(z1 - z0)
  const zc = (z0 + z1) / 2
  g.add(slabMesh(width + 1.4, len, 0.1, palette.island.pavement, x, GROUND - 0.02, zc))
  g.add(slabMesh(width, len, 0.06, palette.island.road, x, GROUND + 0.08, zc))
  const dash = new THREE.MeshStandardMaterial({ color: palette.island.roadLine, roughness: 0.9 })
  for (let z = Math.min(z0, z1) + 1; z < Math.max(z0, z1) - 0.8; z += 2.4) {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 1.2), dash)
    d.position.set(x, GROUND + 0.15, z)
    g.add(d)
  }
  return g
}

/** The paved pad a building stands on. */
export function plotPad(x: number, z: number, w: number, d: number): THREE.Mesh {
  return slabMesh(w, d, 0.1, palette.island.plot, x, GROUND - 0.02, z)
}

/** A short path from a building's door to the street. */
export function path(x0: number, z0: number, x1: number, z1: number, width = 1.2): THREE.Mesh {
  const m = slabMesh(Math.abs(x1 - x0) || width, Math.abs(z1 - z0) || width, 0.08, palette.island.pavement, (x0 + x1) / 2, GROUND + 0.02, (z0 + z1) / 2)
  return m
}

export function lamp(x: number, z: number): THREE.Group {
  const g = new THREE.Group()
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.9, 6), flat('#4a525e'))
  pole.position.y = 0.95
  pole.castShadow = true
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffe9a8', toneMapped: false }))
  head.position.y = 2.0
  g.add(pole, head)
  g.position.set(x, GROUND, z)
  return g
}

export function bench(x: number, z: number, ry: number): THREE.Group {
  const g = new THREE.Group()
  const wood = flat(palette.wood)
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.1, 0.4), wood)
  seat.position.y = 0.45
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.35, 0.08), wood)
  back.position.set(0, 0.72, -0.18)
  for (const sx of [-0.55, 0.55]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.45, 0.35), flat('#4a525e'))
    leg.position.set(sx, 0.22, 0)
    g.add(leg)
  }
  g.add(seat, back)
  g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true })
  g.position.set(x, GROUND + 0.05, z)
  g.rotation.y = ry
  return g
}

/** A small fountain for the hub plaza. */
export function fountain(): THREE.Group {
  const g = new THREE.Group()
  const stone = flat('#d4cdbd')
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.9, 0.5, 16), stone)
  basin.position.y = 0.25
  const water = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.05, 16), new THREE.MeshStandardMaterial({ color: '#69c8e8', roughness: 0.2 }))
  water.position.y = 0.5
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 1.1, 8), stone)
  pillar.position.y = 0.8
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.35, 0.25, 12), stone)
  cup.position.y = 1.4
  for (const m of [basin, pillar, cup]) { m.castShadow = true; m.receiveShadow = true }
  g.add(basin, water, pillar, cup)
  g.position.y = GROUND
  return g
}

export interface BridgeOpts {
  from: THREE.Vector3
  to: THREE.Vector3
  width?: number
}

/** A wooden bridge between two points at deck height, with rails, lamps and piers into the water. */
export function bridge({ from, to, width = 3.4 }: BridgeOpts): THREE.Group {
  const g = new THREE.Group()
  const dir = to.clone().sub(from)
  const len = dir.length()
  const mid = from.clone().add(to).multiplyScalar(0.5)
  const yaw = Math.atan2(dir.x, dir.z)
  const deck = new THREE.Group()
  deck.position.copy(mid)
  deck.rotation.y = yaw

  const plankA = flat(palette.wood), plankB = flat(palette.woodDark)
  const n = Math.max(2, Math.round(len / 0.9))
  for (let i = 0; i < n; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(width, 0.16, len / n - 0.04), i % 2 ? plankA : plankB)
    p.position.set(0, GROUND + 0.02, -len / 2 + (i + 0.5) * (len / n))
    p.castShadow = true; p.receiveShadow = true
    deck.add(p)
  }
  const rail = flat('#8d6a40')
  for (const side of [-1, 1]) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, len), rail)
    r.position.set(side * (width / 2 - 0.06), GROUND + 0.9, 0)
    const r2 = r.clone(); r2.position.y = GROUND + 0.5
    r.castShadow = true
    deck.add(r, r2)
    for (let i = 0; i <= Math.floor(len / 2.4); i++) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.0, 0.16), rail)
      post.position.set(side * (width / 2 - 0.06), GROUND + 0.5, -len / 2 + 0.2 + i * ((len - 0.4) / Math.max(1, Math.floor(len / 2.4))))
      post.castShadow = true
      deck.add(post)
    }
  }
  // piers
  const pier = flat('#6b7280')
  for (let i = 0; i < Math.floor(len / 5); i++) {
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 2.4, 8), pier)
      p.position.set(side * (width / 2 - 0.1), GROUND - 1.2, -len / 2 + (i + 1) * (len / (Math.floor(len / 5) + 1)))
      p.castShadow = true
      deck.add(p)
    }
  }
  g.add(deck)
  return g
}
