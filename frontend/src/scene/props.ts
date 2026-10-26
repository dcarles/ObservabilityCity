import * as THREE from 'three'
import { box, flat, group } from '../buildings/mk'
import { kit } from '../assets/kit'
import { activeKit, bridgeStyle, palette } from '../themes/active'
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
export function street(x: number, z0: number, z1: number, sides: (-1 | 1)[] = [-1, 1]): THREE.Group {
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
  for (const side of sides) g.add(slabMesh(0.9, len, CURB_TOP - GROUND, palette.island.pavement, x + side * (ROAD_W / 2 + 0.45), GROUND - 0.02, zMid))
  return g
}

/** The same along x, for side roads. */
export function streetX(z: number, x0: number, x1: number, sides: (-1 | 1)[] = [-1, 1]): THREE.Group {
  const g = street(0, 0, Math.abs(x1 - x0), sides)
  g.rotation.y = Math.PI / 2
  g.position.set(Math.min(x0, x1), 0, z)
  return g
}

/** A road along any direction between two points. */
export function roadBetween(from: THREE.Vector3, to: THREE.Vector3): THREE.Group {
  const d = to.clone().sub(from)
  const g = street(0, 0, d.length())
  const wrap = new THREE.Group()
  wrap.add(g)
  wrap.position.set(from.x, 0, from.z)
  wrap.rotation.y = Math.atan2(d.x, d.z)
  return wrap
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

/** A street lamp. Its arm points along +x unless a yaw is given. */
export function lamp(x: number, z: number, faceX: number, yaw?: number): THREE.Object3D {
  const l = kit('streetlight')
  l.scale.setScalar(2.2)
  l.position.set(x, GROUND + 0.1, z)
  l.rotation.y = yaw ?? (faceX > 0 ? 0 : Math.PI)
  return l
}

/** A crossing of the spine and a side road. The last row has no road beyond it, so it is a T. */
export function junction(x: number, z: number, tee: boolean): THREE.Group {
  const g = new THREE.Group()
  const t = kit(tee ? 'road_tsplit' : 'road_junction')
  t.scale.set(ROAD_W / 2, 1.2, ROAD_W / 2)
  t.position.set(x, ROAD_TOP - 0.12, z)
  if (tee) t.rotation.y = TEE_YAW
  g.add(t)
  const o = ROAD_W / 2 + 0.45
  const c = CURB_TOP - GROUND
  const corners: [number, number][] = tee ? [[-1, 1], [1, 1]] : [[-1, 1], [1, 1], [-1, -1], [1, -1]]
  for (const [sx, sz] of corners) g.add(slabMesh(0.9, 0.9, c, palette.island.pavement, x + sx * o, GROUND - 0.02, z + sz * o))
  if (tee) g.add(slabMesh(ROAD_W + 1.8, 0.9, c, palette.island.pavement, x, GROUND - 0.02, z - o))
  return g
}
const TEE_YAW = 0

export function bench(x: number, z: number, ry: number): THREE.Object3D {
  const b = kit('bench')
  b.scale.setScalar(2.6)
  b.position.set(x, GROUND + 0.05, z)
  b.rotation.y = ry
  return b
}

export function prop(name: 'firehydrant' | 'dumpster' | 'trash_A' | 'trash_B' | 'box_A' | 'box_B' | 'bush', x: number, z: number, ry = 0, scale = 2.2): THREE.Object3D {
  const o = activeKit().prop(name) ?? kit(name)
  if (o.userData.themed !== true) o.scale.setScalar(scale)
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
  /** Gate posts and a little overrun at both ends. Off for a piece of a longer causeway, which has no ends of its own. */
  ends?: boolean
}

/** A road bridge: the road on a deck, dressed in the theme's own way (stone parapets and piers, a light bridge, a steel gantry). */
export function bridge(opts: BridgeOpts): THREE.Group {
  const g = new THREE.Group()
  // run the deck a little onto both shores so it meets the roads without a seam
  const unit = opts.to.clone().sub(opts.from).normalize()
  const overrun = opts.ends === false ? 0.15 : 1.4
  const from = opts.from.clone().addScaledVector(unit, -overrun)
  const to = opts.to.clone().addScaledVector(unit, overrun)
  const dir = to.clone().sub(from)
  const len = dir.length()
  const mid = from.clone().add(to).multiplyScalar(0.5)
  const deck = new THREE.Group()
  deck.position.copy(mid)
  deck.rotation.y = Math.atan2(dir.x, dir.z)
  const width = ROAD_W + 2.0
  bridgeStyle().dress(deck, len, width, opts.ends !== false)
  const tiles = Math.max(1, Math.round(len / ROAD_W))
  for (let i = 0; i < tiles; i++) {
    const t = kit('road_straight')
    t.scale.set(ROAD_W / 2, 1.2, len / tiles / 2)
    t.position.set(0, ROAD_TOP - 0.12, -len / 2 + (i + 0.5) * (len / tiles))
    deck.add(t)
  }
  g.add(deck)
  return g
}

/** The strip of asphalt in front of a pad where cars pull in and wait. */
export function serviceLane(x: number, z: number, length: number, width: number): THREE.Mesh {
  const m = slabMesh(length, width, 0.1, palette.island.road, x, ROAD_TOP - 0.095, z)
  m.receiveShadow = true
  return m
}

/** The jetty at the end of a sea lane, in the theme's own look. */
export function pier(length: number): THREE.Group {
  return activeKit().pier(length)
}

/** Places a few crates on the pier and quay. */
export function crates(): THREE.Group {
  const colors = ['#e0573f', '#3f8fd9', '#f2b632', '#4fb37a']
  const g = new THREE.Group()
  colors.forEach((c, i) => g.add(box(0.9, 0.8, 0.9, flat(c), { x: (i % 2 ? 0.8 : -0.8), y: GROUND + 0.05, z: Math.floor(i / 2) * 1.2 })))
  return g
}

export { group }
