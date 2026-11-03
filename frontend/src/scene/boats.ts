import * as THREE from 'three'
import { vehicles } from '../themes/active'
import { clamp } from '../visuals'

/** A sea lane for one island's messages: where boats appear, how often, and how fast they sail. */
export interface BoatRoute {
  /** From the hub's port out to the island's harbour. Boats sail it there (loaded) and back (empty). */
  path: THREE.Vector3[]
  /** The island whose topic the boats carry out of (null for the hub's own), and the island they sail to. */
  from: string | null
  to: string
  /** True for the boats of a scheduler's mapped jobs: a loop out of the island's own harbour. */
  scheduler?: boolean
  /** True when the path is a closed circuit round the island: sailed once, one way, instead of there and back. */
  circuit?: boolean
  /** Boats leaving per second. Zero while the broker is down or has no data. */
  rate: () => number
  /** Sailing speed multiplier from the broker's latency against its SLA. */
  speed: () => number
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
  /** Sideways offset from the lane now (to the boat's right), the one it is easing to, and how much it slows down for another boat: all set by the checks between boats. */
  lateral: number
  want: number
  slow: number
  /** The way it is heading, a unit vector on the water, from where it was last placed. */
  hx: number
  hz: number
}

const BASE_SPEED = 4.4
const SEA = 0.12
const BOAT_SCALE = 0.95
/** The checks between boats that sail between islands: how close another boat must be to count, how near it may come at the most, and how slow a boat gives way. */
export const AVOID_RADIUS = 3.4
export const AVOID_GAP = 1.4
const AVOID_SLOWEST = 0.2
/** How far a boat steps to its right to pass another head on, at the most; the lanes keep clear of land by more than this and the lane's own side step together. */
export const AVOID_STEP = 1.2
const AVOID_EASE = 3
/** How far a boat keeps to the right of the middle of its lane, so a boat going out and one coming back pass side by side. */
export const LANE_SIDE = 1.3

/** The same path moved sideways by `side` (positive: to the right of the way it runs), corners included. */
export function sidestep(path: THREE.Vector3[], side: number): THREE.Vector3[] {
  return path.map((p, i) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)]
    const dx = b.x - a.x, dz = b.z - a.z
    const len = Math.hypot(dx, dz) || 1
    return new THREE.Vector3(p.x - (dz / len) * side, p.y, p.z + (dx / len) * side)
  })
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
  /** Idle boats: the ones for lanes between islands, and the differently painted ones for loops out of an island's own harbour. */
  private readonly free: { object: THREE.Group; cargo: THREE.Group }[] = []
  private readonly freeInternal: { object: THREE.Group; cargo: THREE.Group }[] = []
  private time = 0
  private enabled = true

  /** Turns the boats on or off with the Messaging layer. Turning them off takes them away. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    this.object.visible = on
    if (!on) for (const b of this.boats.splice(0)) this.release(b)
  }

  constructor(max = 48) {
    for (let i = 0; i < max; i++) {
      for (const internal of [false, true]) {
        const b = vehicles().boat(i, internal)
        b.object.visible = false
        this.object.add(b.object)
        ;(internal ? this.freeInternal : this.free).push(b)
      }
    }
  }

  /** Whether a lane is a loop out of an island's own harbour and back: its boats are the other colour. */
  private static isInternal(r: BoatRoute): boolean {
    return r.scheduler === true || (r.from !== null && r.from === r.to)
  }

  private release(b: Boat): void {
    b.object.visible = false
    ;(BoatSystem.isInternal(b.route) ? this.freeInternal : this.free).push({ object: b.object, cargo: b.cargo as THREE.Group })
  }

  /** The share of the usual number of boats that are sent out: 1 for all of them, less on a weak PC (see the quality presets). */
  density = 1

  setRoutes(routes: BoatRoute[]): void {
    this.routes.length = 0
    this.routes.push(...routes)
    this.acc.clear()
    for (const b of this.boats.splice(0)) this.release(b)
  }

  update(dt: number): void {
    if (!this.enabled) return
    this.time += dt
    this.avoid(dt)
    for (const r of this.routes) {
      const rate = r.rate()
      if (rate <= 0) continue
      const a = (this.acc.get(r) ?? Math.random()) + rate * this.density * dt
      let whole = Math.floor(a)
      this.acc.set(r, a - whole)
      while (whole-- > 0 && (BoatSystem.isInternal(r) ? this.freeInternal : this.free).length > 0) this.spawn(r)
    }
    for (let i = this.boats.length - 1; i >= 0; i--) {
      const b = this.boats[i]
      b.dist += BASE_SPEED * b.route.speed() * b.slow * dt
      if (b.dist >= b.total) {
        this.release(b)
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
    // there and back: the way back is the same lane in reverse, but each way keeps to its own side of it, like the cars, so boats going out and coming back pass side by side
    const points = r.circuit ? [...out] : [...sidestep(out, LANE_SIDE), ...sidestep([...out].reverse(), LANE_SIDE).slice(1)]
    const lengths: number[] = []
    let total = 0
    for (let i = 1; i < points.length; i++) { const l = points[i].distanceTo(points[i - 1]); lengths.push(l); total += l }
    const slot = (BoatSystem.isInternal(r) ? this.freeInternal : this.free).pop()!
    slot.object.visible = true
    slot.cargo.children.forEach((c) => { c.visible = true }) // always the full load of crates
    const boat: Boat = { object: slot.object, cargo: slot.cargo, points, lengths, total, dist: 0, route: r, phase: Math.random() * 6, lateral: 0, want: 0, slow: 1, hx: 0, hz: 1 }
    this.boats.push(boat)
    this.place(boat) // on the water from the start, so the checks between boats see it where it is
  }

  /**
   * The checks between the boats that sail between islands (a loop round an island has its own lane and is left alone). For every pair that is close:
   * following the same way, the one behind slows; crossing, the one with the other on its right gives way and slows; head on, both step to their right.
   * Only a boat's own speed and its sideways step change, so a boat never leaves its lane by more than AVOID_STEP.
   */
  private avoid(dt: number): void {
    const sail = this.boats.filter((b) => !BoatSystem.isInternal(b.route))
    for (const b of sail) { b.slow = 1; b.want = 0 }
    const slowFor = (b: Boat, d: number) => { b.slow = Math.min(b.slow, clamp((d - AVOID_GAP) / (AVOID_RADIUS - AVOID_GAP), AVOID_SLOWEST, 1)) }
    for (let i = 0; i < sail.length; i++) {
      const a = sail[i]
      for (let j = i + 1; j < sail.length; j++) {
        const c = sail[j]
        const dx = c.object.position.x - a.object.position.x, dz = c.object.position.z - a.object.position.z
        const d = Math.hypot(dx, dz)
        if (d > AVOID_RADIUS || d < 1e-6) continue
        const along = a.hx * c.hx + a.hz * c.hz
        const aheadOfA = (a.hx * dx + a.hz * dz) / d // how far in front of a the other boat is, -1 to 1
        const aheadOfC = -(c.hx * dx + c.hz * dz) / d
        if (along > 0.5) {
          if (aheadOfA > 0.3) slowFor(a, d)
          else if (aheadOfC > 0.3) slowFor(c, d)
        } else if (along < -0.5) {
          if (aheadOfA > 0.3 && aheadOfC > 0.3) { a.want = AVOID_STEP; c.want = AVOID_STEP }
        } else if ((-a.hz * dx + a.hx * dz) / d > 0) slowFor(a, d) // the other boat is on a's right: a gives way
        else slowFor(c, d)
      }
    }
    const ease = Math.min(1, AVOID_EASE * dt)
    for (const b of sail) b.lateral += (b.want - b.lateral) * ease
  }

  private place(b: Boat): void {
    let i = 0
    let left = b.dist
    while (i < b.lengths.length - 1 && left > b.lengths[i]) { left -= b.lengths[i]; i++ }
    const t = b.lengths[i] > 0 ? clamp(left / b.lengths[i], 0, 1) : 0
    const o = b.object
    o.position.lerpVectors(b.points[i], b.points[i + 1], t)
    const dx = b.points[i + 1].x - b.points[i].x, dz = b.points[i + 1].z - b.points[i].z
    const len = Math.hypot(dx, dz)
    if (len > 1e-6) { b.hx = dx / len; b.hz = dz / len }
    o.position.x += -b.hz * b.lateral // to the boat's right
    o.position.z += b.hx * b.lateral
    const target = Math.atan2(dx, dz)
    let d = target - o.rotation.y
    d = Math.atan2(Math.sin(d), Math.cos(d))
    o.rotation.y += d * 0.12
    const bob = Math.sin(this.time * 1.8 + b.phase)
    const kit = vehicles()
    o.position.y = SEA + kit.boatLift + bob * kit.boatBob
    o.rotation.z = bob * kit.boatBob * 0.5
    // a boat on a circuit round its island is loaded all the way and unloads at the quay; there and back, it is loaded only on the way out
    b.cargo.visible = b.route.circuit === true || b.dist < b.total / 2
    // ease in and out at the quays
    const fade = clamp(Math.min(b.dist, b.total - b.dist) / 4, 0, 1)
    o.scale.setScalar(BOAT_SCALE * (0.4 + 0.6 * fade))
  }
}
