import * as THREE from 'three'
import { box, flat, group } from '../buildings/mk'
import { clamp } from '../visuals'

/** A sea lane for one island's messages: where boats appear, how often, and how fast they sail. */
export interface BoatRoute {
  /** From the hub's port out to the island's harbour. Boats sail it there (loaded) and back (empty). */
  path: THREE.Vector3[]
  /** Boats leaving per second. Zero while the broker is down or has no data. */
  rate: () => number
  /** Sailing speed multiplier from the broker's latency against its SLA. */
  speed: () => number
  /** How full the boats are, 0 to 1: the island's message rate on a log scale. */
  load: () => number
}

interface Boat {
  object: THREE.Group
  cargo: THREE.Object3D
  points: THREE.Vector3[]
  lengths: number[]
  total: number
  dist: number
  route: BoatRoute
  phase: number
}

const BASE_SPEED = 4.4
const SEA = 0.12
const BOAT_SCALE = 0.7
const CRATE_COLORS = ['#e0573f', '#3f8fd9', '#f2b632', '#4fb37a', '#8e6bd9']

/** One cargo boat: a pointed hull, a wheelhouse and a deck load of crates. */
function makeBoat(seed: number): { object: THREE.Group; cargo: THREE.Group } {
  const L = 5.4, W = 1.9
  const prof = new THREE.Shape()
  prof.moveTo(-W / 2, L / 2)
  prof.lineTo(-W / 2, -L / 2 + 0.2)
  prof.lineTo(0, -L / 2 - 1.1)
  prof.lineTo(W / 2, -L / 2 + 0.2)
  prof.lineTo(W / 2, L / 2)
  prof.closePath()
  const hullGeo = new THREE.ExtrudeGeometry(prof, { depth: 0.75, bevelEnabled: false })
  hullGeo.rotateX(-Math.PI / 2)
  hullGeo.translate(0, -0.3, 0)
  const hull = new THREE.Mesh(hullGeo, flat('#2f5d8a'))
  hull.castShadow = true
  hull.receiveShadow = true
  const stripe = box(W + 0.04, 0.12, L + 1.3, flat('#f4efe2'), { y: 0.3 })
  stripe.scale.set(1, 1, 1)
  const deck = box(W - 0.2, 0.06, L - 0.6, flat('#b58a58'), { y: 0.43, z: 0.1 })
  const house = group(
    box(1.2, 0.9, 1.2, flat('#f1ece0'), { y: 0.45, z: -L / 2 + 0.9 }),
    box(1.3, 0.12, 1.3, flat('#c0483f'), { y: 1.35, z: -L / 2 + 0.9 }),
  )
  const cargo = new THREE.Group()
  for (let i = 0; i < 6; i++) {
    cargo.add(box(0.75, 0.7, 0.75, flat(CRATE_COLORS[(seed + i) % CRATE_COLORS.length]), { x: i % 2 ? 0.42 : -0.42, y: 0.46, z: 1.2 - Math.floor(i / 2) * 0.9 }))
  }
  const object = new THREE.Group()
  object.add(hull, stripe, deck, house, cargo)
  object.scale.setScalar(BOAT_SCALE)
  return { object, cargo }
}

/**
 * Messages as boats. Each island has a sea lane from the hub's Service Bus port to its harbour. How many boats
 * sail follows the island's message traffic, how fast they sail follows the broker's latency, and they carry
 * crates out and come back empty. Invented in the browser from the snapshot, like the cars.
 */
export class BoatSystem {
  readonly object = new THREE.Group()
  private readonly routes: BoatRoute[] = []
  private readonly acc = new Map<BoatRoute, number>()
  private readonly boats: Boat[] = []
  private readonly free: { object: THREE.Group; cargo: THREE.Group }[] = []
  private time = 0
  private enabled = true

  /** Turns the boats on or off with the Messaging layer. Turning them off takes them away. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    this.object.visible = on
    if (!on) for (const b of this.boats.splice(0)) { b.object.visible = false; this.free.push({ object: b.object, cargo: b.cargo as THREE.Group }) }
  }

  constructor(max = 48) {
    for (let i = 0; i < max; i++) {
      const b = makeBoat(i)
      b.object.visible = false
      this.object.add(b.object)
      this.free.push(b)
    }
  }

  /** The share of the usual number of boats that are sent out: 1 for all of them, less on a weak PC (see the quality presets). */
  density = 1

  setRoutes(routes: BoatRoute[]): void {
    this.routes.length = 0
    this.routes.push(...routes)
    this.acc.clear()
    for (const b of this.boats.splice(0)) { b.object.visible = false; this.free.push({ object: b.object, cargo: b.cargo as THREE.Group }) }
  }

  update(dt: number): void {
    if (!this.enabled) return
    this.time += dt
    for (const r of this.routes) {
      const rate = r.rate()
      if (rate <= 0) continue
      const a = (this.acc.get(r) ?? Math.random()) + rate * this.density * dt
      let whole = Math.floor(a)
      this.acc.set(r, a - whole)
      while (whole-- > 0 && this.free.length > 0) this.spawn(r)
    }
    for (let i = this.boats.length - 1; i >= 0; i--) {
      const b = this.boats[i]
      b.dist += BASE_SPEED * b.route.speed() * dt
      if (b.dist >= b.total) {
        b.object.visible = false
        this.free.push({ object: b.object, cargo: b.cargo as THREE.Group })
        this.boats.splice(i, 1)
        continue
      }
      this.place(b)
    }
  }

  get count(): number {
    return this.boats.length
  }

  private spawn(r: BoatRoute): void {
    const out = r.path
    if (out.length < 2) return
    // there and back: the way back is the same lane in reverse, so boats pass each other
    const points = [...out, ...[...out].reverse().slice(1)]
    const lengths: number[] = []
    let total = 0
    for (let i = 1; i < points.length; i++) { const l = points[i].distanceTo(points[i - 1]); lengths.push(l); total += l }
    const slot = this.free.pop()!
    slot.object.visible = true
    // a fuller load for busier traffic: 1 to 6 crates on deck
    const crates = 1 + Math.round(clamp(r.load(), 0, 1) * 5)
    slot.cargo.children.forEach((c, i) => { c.visible = i < crates })
    this.boats.push({ object: slot.object, cargo: slot.cargo, points, lengths, total, dist: 0, route: r, phase: Math.random() * 6 })
  }

  private place(b: Boat): void {
    let i = 0
    let left = b.dist
    while (i < b.lengths.length - 1 && left > b.lengths[i]) { left -= b.lengths[i]; i++ }
    const t = b.lengths[i] > 0 ? clamp(left / b.lengths[i], 0, 1) : 0
    const o = b.object
    o.position.lerpVectors(b.points[i], b.points[i + 1], t)
    const dx = b.points[i + 1].x - b.points[i].x, dz = b.points[i + 1].z - b.points[i].z
    const target = Math.atan2(dx, dz)
    let d = target - o.rotation.y
    d = Math.atan2(Math.sin(d), Math.cos(d))
    o.rotation.y += d * 0.12
    const bob = Math.sin(this.time * 1.8 + b.phase)
    o.position.y = SEA + bob * 0.05
    o.rotation.z = bob * 0.025
    b.cargo.visible = b.dist < b.total / 2
    // ease in and out at the quays
    const fade = clamp(Math.min(b.dist, b.total - b.dist) / 4, 0, 1)
    o.scale.setScalar(BOAT_SCALE * (0.4 + 0.6 * fade))
  }
}
