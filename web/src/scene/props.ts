import * as THREE from 'three'
import { box, cyl, flat, group } from '../buildings/mk'
import { kit } from '../assets/kit'
import { palette } from '../themes/harbour-town/palette'
import { GROUND } from './island'

export const ROAD_W = 4.2
const ROAD_TOP = GROUND + 0.06
const CURB_TOP = GROUND + 0.14

const slabMat = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true })

function slabMesh(w: number, d: number, h: number, color: string, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), slabMat(color))
  m.position.set(x, y + h / 2, z)
  m.receiveShadow = true
  return m
}

/** Kit road tiles laid end to end between two points along z, with pavements on both sides. */
export function street(x: number, z0: number, z1: number): THREE.Group {
  const g = new THREE.Group()
  const len = Math.abs(z1 - z0)
  const zMid = (z0 + z1) / 2
  const n = Math.max(1, Math.round(len / ROAD_W))
  const tileLen = len / n
  for (let i = 0; i < n; i++) {
    const t = kit('road_straight')
    t.scale.set(ROAD_W / 2, 1.2, tileLen / 2)
    t.position.set(x, ROAD_TOP - 0.12, Math.min(z0, z1) + (i + 0.5) * tileLen)
    g.add(t)
  }
  for (const side of [-1, 1]) g.add(slabMesh(0.9, len, CURB_TOP - GROUND, palette.island.pavement, x + side * (ROAD_W / 2 + 0.45), GROUND - 0.02, zMid))
  return g
}

/** The same along x, for side roads. */
export function streetX(z: number, x0: number, x1: number): THREE.Group {
  const g = street(0, 0, Math.abs(x1 - x0))
  g.rotation.y = Math.PI / 2
  g.position.set(Math.min(x0, x1), 0, z)
  return g
}

/** A ring road around a plaza. */
export function ring(cx: number, cz: number, rIn: number, rOut: number): THREE.Group {
  const g = new THREE.Group()
  const asphalt = new THREE.Mesh(new THREE.RingGeometry(rIn, rOut, 56, 1), new THREE.MeshStandardMaterial({ color: '#4f5764', roughness: 0.95 }))
  asphalt.rotation.x = -Math.PI / 2
  asphalt.position.set(cx, ROAD_TOP, cz)
  asphalt.receiveShadow = true
  g.add(asphalt)
  const lineMat = new THREE.MeshStandardMaterial({ color: '#f0d77a', roughness: 0.9 })
  const rMid = (rIn + rOut) / 2
  const dashes = 28
  for (let i = 0; i < dashes; i++) {
    const a = (i / dashes) * Math.PI * 2
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 0.9), lineMat)
    d.position.set(cx + Math.sin(a) * rMid, ROAD_TOP + 0.02, cz + Math.cos(a) * rMid)
    d.rotation.y = a
    g.add(d)
  }
  return g
}

/** One paved pad under a whole block of buildings that belong to the same service. */
export function blockPad(x: number, zMin: number, zMax: number, width: number): THREE.Mesh {
  return slabMesh(width, zMax - zMin, 0.1, '#ddd5c2', x, GROUND - 0.02, (zMin + zMax) / 2)
}

export function lamp(x: number, z: number, faceX: number): THREE.Object3D {
  const l = kit('streetlight')
  l.scale.setScalar(2.2)
  l.position.set(x, GROUND + 0.1, z)
  l.rotation.y = faceX > 0 ? 0 : Math.PI
  return l
}

export function bench(x: number, z: number, ry: number): THREE.Object3D {
  const b = kit('bench')
  b.scale.setScalar(2.6)
  b.position.set(x, GROUND + 0.05, z)
  b.rotation.y = ry
  return b
}

export function prop(name: 'firehydrant' | 'dumpster' | 'trash_A' | 'trash_B' | 'box_A' | 'box_B' | 'bush', x: number, z: number, ry = 0, scale = 2.2): THREE.Object3D {
  const o = kit(name)
  o.scale.setScalar(scale)
  o.position.set(x, GROUND + 0.05, z)
  o.rotation.y = ry
  return o
}

/** A small fountain for the hub plaza. */
export function fountain(): THREE.Group {
  const g = new THREE.Group()
  const stone = flat('#d4cdbd')
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 2.1, 0.5, 20), stone)
  basin.position.y = 0.25
  const water = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 0.05, 20), new THREE.MeshStandardMaterial({ color: '#69c8e8', roughness: 0.2 }))
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
}

/** A road bridge: asphalt on a wooden deck with rails, piers into the water and lamps. */
export function bridge({ from, to }: BridgeOpts): THREE.Group {
  const g = new THREE.Group()
  const dir = to.clone().sub(from)
  const len = dir.length()
  const mid = from.clone().add(to).multiplyScalar(0.5)
  const deck = new THREE.Group()
  deck.position.copy(mid)
  deck.rotation.y = Math.atan2(dir.x, dir.z)
  const width = ROAD_W + 1.0

  const plankA = flat(palette.wood), plankB = flat(palette.woodDark)
  const n = Math.max(2, Math.round(len / 0.9))
  for (let i = 0; i < n; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(width, 0.16, len / n - 0.04), i % 2 ? plankA : plankB)
    p.position.set(0, GROUND - 0.02, -len / 2 + (i + 0.5) * (len / n))
    p.castShadow = true; p.receiveShadow = true
    deck.add(p)
  }
  const tiles = Math.max(1, Math.round(len / ROAD_W))
  for (let i = 0; i < tiles; i++) {
    const t = kit('road_straight')
    t.scale.set(ROAD_W / 2, 1.0, len / tiles / 2)
    t.position.set(0, GROUND - 0.1, -len / 2 + (i + 0.5) * (len / tiles))
    deck.add(t)
  }
  const rail = flat('#8d6a40')
  for (const side of [-1, 1]) {
    const x = side * (width / 2 - 0.08)
    deck.add(box(0.12, 0.12, len, rail, { x, y: GROUND + 0.9 }), box(0.12, 0.12, len, rail, { x, y: GROUND + 0.45 }))
    const posts = Math.max(2, Math.floor(len / 2.4))
    for (let i = 0; i <= posts; i++) deck.add(box(0.16, 1.0, 0.16, rail, { x, y: GROUND - 0.1, z: -len / 2 + 0.2 + i * ((len - 0.4) / posts) }))
  }
  const pier = flat('#6b7280')
  const piers = Math.floor(len / 5)
  for (let i = 0; i < piers; i++) {
    for (const side of [-1, 1]) {
      const p = cyl(0.3, 0.36, 2.6, pier, { x: side * (width / 2 - 0.2), y: GROUND - 2.7, z: -len / 2 + (i + 1) * (len / (piers + 1)) })
      deck.add(p)
    }
  }
  g.add(deck)
  return g
}

/** A short wooden pier reaching out from the coast, with posts and crates. */
export function pier(length: number): THREE.Group {
  const g = new THREE.Group()
  const wood = flat(palette.wood), dark = flat(palette.woodDark)
  for (let i = 0; i < Math.round(length / 0.8); i++) g.add(box(3.4, 0.16, 0.74, i % 2 ? wood : dark, { y: GROUND - 0.1, z: i * 0.8 }))
  for (let i = 0; i <= Math.floor(length / 2.4); i++) {
    for (const side of [-1, 1]) g.add(cyl(0.16, 0.2, 2.2, dark, { x: side * 1.55, y: GROUND - 1.9, z: i * 2.4 }, 8))
  }
  // mooring posts at the end
  for (const side of [-1, 1]) g.add(cyl(0.14, 0.18, 0.7, dark, { x: side * 1.45, y: GROUND, z: length - 0.4 }, 8))
  return g
}

/** Places a few crates on the pier and quay. */
export function crates(): THREE.Group {
  const colors = ['#e0573f', '#3f8fd9', '#f2b632', '#4fb37a']
  const g = new THREE.Group()
  colors.forEach((c, i) => g.add(box(0.9, 0.8, 0.9, flat(c), { x: (i % 2 ? 0.8 : -0.8), y: GROUND + 0.05, z: Math.floor(i / 2) * 1.2 })))
  return g
}

export { group }
