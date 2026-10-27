import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Building } from '../buildings/building'
import { canvasTexture, roundRect } from '../buildings/mk'
import { vehicles } from '../themes/active'
import { clamp, spawnRate } from '../visuals'
import type { TenantInfo } from '../types'
import { carShown, pickTenant, type TenantView } from '../tenants'

/** Where a request comes from decides the car: internal calls are blue sedans, external calls yellow taxis. */
export type Origin = 'internal' | 'external'

/** Where a car waits and is served: a lane beside the road in front of the building. */
export interface Bay {
  /** Points in drive order, already placed (no lane offset): the last one is the door, where the car is served. */
  drive: THREE.Vector3[]
  /** How many cars the lane holds. Once that many are on their way or waiting, no more cars appear for the building. */
  slots: number
  /** Where the "waiting" marker floats. */
  marker: THREE.Vector3
}

/** A way requests reach a building: the road they take and whether they come from inside or outside. */
export interface Route {
  dest: Building
  /** The building the cars drive out of: they appear at its front and never anywhere else. */
  source: Pick<Building, 'doorWorld'>
  origin: Origin
  /** Road centre line from where cars appear to the point where they turn into the bay (or stop, without a bay). */
  path: THREE.Vector3[]
  /** Share of the destination's traffic that takes this route. */
  share: number
  bay?: Bay
  /** Set for cars that leave the picture: they end at the hub plaza because their destination is on an island the filter hides. */
  edge?: boolean
}

interface Planned {
  route: Route
  /** The way there, lane offset applied, and the way back to where the car came from. */
  there: THREE.Vector3[]
  back: THREE.Vector3[]
  /** How far along `there` a car checks whether the bay has room. */
  decision: number
  slots: number
  marker: THREE.Vector3
}

type Stage = 'there' | 'serving' | 'back'

interface Car {
  id: number
  plan: Planned
  points: THREE.Vector3[]
  lengths: number[]
  total: number
  dist: number
  stage: Stage
  committed: boolean
  timer: number
  model: 0 | 1
  failed: boolean
  yaw: number
  x: number
  z: number
  dx: number
  dz: number
  /** Metres per second it actually covered last frame. */
  speed: number
  stuck: number
  by?: string
  lookX: number[]
  lookZ: number[]
  /** Seconds it has been in a standoff: two cars each waiting for the other. */
  standoff: number
  /** Seconds left of fading out, or -1 while the car is solid. A car stuck in a jam for good dissolves instead of driving through others. */
  fade: number
  pace: number
  /** Seconds spent waiting for a gap to turn round into. */
  wait: number
  /** Seconds since it appeared. A new car grows out of its building's front for a moment, so it never pops into view. */
  age: number
  /** The tenant the request is for, or null in an environment without tenants. */
  tenant: string | null
}

interface Marker {
  sprite: THREE.Sprite
  key: string
  /** When the lane was last full and a car was held back. */
  full: number
}

/** Every car model is scaled to this length in metres, so the models all come out the same size. */
const CAR_LENGTH = 2.2
const SPEED = 4.2
const LANE = 1.05
/** Cars keep at least this far from the one in front, centre to centre, and start braking at BRAKE_FROM. */
const HALT = 2.7
const BRAKE_FROM = 5.2
const SIDE = 1.25
/** The sweep is LOOK points, LOOK_STEP metres apart, ahead of the car. Two points closer than TOUCH metres mean contact. */
const LOOK = 5
const LOOK_STEP = 1.1
const TOUCH = 1.3
const TOUCH_YOUNGER = 1.1
const REACH = 11
const CROWD_R = 9
const CROWD_MAX = 3
/** Seconds a new car takes to grow to full size. */
const GROW = 0.5
/** Seconds a failed request stays at the door, flag up, before it is turned away. */
const FAIL_HOLD = 0.8
const TRAFFIC = 0.4 // every car now drives there and back, so fewer need to leave

/**
 * Requests as cars. The number of cars follows the request rate (a sample, not a count). Each car drives to its
 * destination and waits in the building's service lane; time in the lane is the latency, so a slow system builds a
 * queue. A served car drives into the building. A failed request carries a red flag and is turned away at the door,
 * back the way it came. Cars never touch: in a lane each brakes for the car ahead, and at crossings and merges a car
 * keeps out of the path of any older car (a standoff dissolves the younger one). All invented in the browser from the
 * numbers in the snapshot, drawn as instanced kit models.
 */
export class CarSystem {
  readonly object = new THREE.Group()
  private readonly meshes: THREE.InstancedMesh[] = []
  private readonly flags: THREE.InstancedMesh
  private readonly lights: THREE.InstancedMesh
  private readonly cars: Car[] = []
  private readonly plans: Planned[] = []
  private readonly acc = new Map<Planned, number>()
  private readonly markers = new Map<Building, Marker>()
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly up = new THREE.Vector3(0, 1, 0)
  private readonly pos = new THREE.Vector3()
  private readonly scaleV = new THREE.Vector3()
  private readonly one = new THREE.Vector3(1, 1, 1)
  private readonly unit: number[] = []
  private nextId = 1
  private tenants: readonly TenantInfo[] = []
  private readonly tenantKinds = new Map<string, TenantInfo['kind']>()
  private view: TenantView = { hideTest: false, tenants: [] }
  /** Cars drawn in the last frame, so tests can tell whether the filter hides them. */
  private shown = 0
  private time = 0
  /** False while the Traffic layer is off: no car appears and none is drawn. */
  private enabled = true
  /** Buildings a layer hides: no car drives to or from them. */
  private hidden: ReadonlySet<Building> = new Set()
  /** The share of the usual number of cars that are sent out: 1 for every car, less on a weak PC (see the quality presets). */
  density = 1
  /** Where the dice come from: which cars fail, when they leave, which tenant they carry. Tests swap in a seeded one so a run repeats. */
  random: () => number = Math.random
  /** Cars sent out since the town was built. For tests. */
  sent = 0
  /** Failed requests that stopped at the door and drove back the way they came, since the town was built. For tests. */
  turnedAway = 0
  /** Cars drawn with a red flag right now. For tests. */
  get flagged(): number {
    return this.flags.count
  }

  constructor(private readonly max = 420) {
    for (const { geometry, material } of vehicles().cars()) {
      geometry.computeBoundingBox()
      const size = geometry.boundingBox!.getSize(new THREE.Vector3())
      this.unit.push(CAR_LENGTH / Math.max(size.x, size.z))
      const im = new THREE.InstancedMesh(geometry, material, max)
      im.count = 0
      im.castShadow = true
      im.receiveShadow = true
      im.frustumCulled = false
      this.meshes.push(im)
      this.object.add(im)
    }
    // a small red flag on the roof marks a failed request
    const pole = new THREE.BoxGeometry(0.09, 1.3, 0.09)
    pole.translate(0, 0.65, 0)
    const cloth = new THREE.BoxGeometry(1.0, 0.62, 0.06)
    cloth.translate(0.5, 1.0, 0)
    this.flags = new THREE.InstancedMesh(mergeGeometries([pole, cloth])!, new THREE.MeshBasicMaterial({ color: '#ff3d3d', toneMapped: false }), max)
    this.flags.count = 0
    this.flags.frustumCulled = false
    // amber hazard lights on cars stuck in a slow queue
    this.lights = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.17, 0), new THREE.MeshBasicMaterial({ color: '#ffb830', toneMapped: false }), max * 2)
    this.lights.count = 0
    this.lights.frustumCulled = false
    this.object.add(this.flags, this.lights)
  }

  setRoutes(routes: Route[]): void {
    this.plans.length = 0
    for (const r of routes) {
      const road = driveOnRight(roundCorners(r.path, 1.6), LANE)
      const there = roundCorners([...road, ...(r.bay?.drive ?? [])], 1.2)
      const back = driveOnRight(roundCorners([...r.path].reverse(), 1.6), LANE)
      const bayLen = r.bay ? polyLength(r.bay.drive) + 4 : 8
      const last = r.bay?.drive[r.bay.drive.length - 1] ?? r.path[r.path.length - 1]
      this.plans.push({
        route: r, there, back,
        decision: Math.max(0, polyLength(there) - bayLen - 3),
        slots: r.bay?.slots ?? 3,
        marker: r.bay?.marker ?? last,
      })
    }
    this.cars.length = 0
    this.acc.clear()
    for (const mk of this.markers.values()) this.object.remove(mk.sprite)
    this.markers.clear()
  }

  /** Turns all traffic on or off. Turning it off takes the cars away, so turning it on starts afresh. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    this.object.visible = on
    if (!on) this.clear()
  }

  /** Stops cars to and from these buildings, and takes away the ones already on their way. */
  setHidden(buildings: ReadonlySet<Building>): void {
    this.hidden = buildings
    for (const c of this.cars) {
      const r = c.plan.route
      if (c.fade < 0 && (buildings.has(r.dest) || buildings.has(r.source as Building))) c.fade = 0.3
    }
  }

  private clear(): void {
    this.cars.length = 0
    this.acc.clear()
    this.shown = 0
    for (const mk of this.markers.values()) this.object.remove(mk.sprite)
    this.markers.clear()
    this.meshes.forEach((im) => { im.count = 0 })
    this.flags.count = 0
    this.lights.count = 0
  }

  update(dt: number): void {
    if (!this.enabled) return
    this.time += dt
    for (const plan of this.plans) {
      if (this.hidden.has(plan.route.dest) || this.hidden.has(plan.route.source as Building)) continue
      const n = plan.route.dest.node
      if (!n || (n.state !== 'Healthy' && n.state !== 'Degraded')) continue
      const a = (this.acc.get(plan) ?? this.random()) + spawnRate(n.requestsPerSecond) * TRAFFIC * this.density * plan.route.share * dt
      // a car that cannot leave yet (the road is not clear) waits its turn, up to a few
      let owed = a
      while (owed >= 1 && this.cars.length < this.max && this.spawn(plan)) owed -= 1
      this.acc.set(plan, Math.min(owed, 3))
    }

    // Where each car will be over the next few metres of its road: the sweep other cars have to keep out of.
    for (const c of this.cars) {
      if (c.fade >= 0) continue
      for (let k = 0; k < LOOK; k++) this.pointAt(c, Math.min(c.total, c.dist + LOOK_STEP * (k + 1)), k)
    }

    // Who gives way to whom. In a lane every car brakes for the car ahead, whatever its age. Everywhere else (crossings,
    // merges, corners) a car keeps out of an older car's body and sweep, and out of any younger car's body. Waiting only
    // ever depends on older cars there, so two cars cannot hold each other up for long.
    for (const c of this.cars) {
      let free = 1
      c.by = undefined
      let queued = false // held up by a car that is being served: a normal queue, not a jam
      if (c.stage !== 'serving' && c.fade < 0) {
        for (const o of this.cars) {
          if (o === c || o.fade >= 0) continue
          const vx = o.x - c.x, vz = o.z - c.z
          const d2 = vx * vx + vz * vz
          if (d2 > REACH * REACH) continue
          const fwd = vx * c.dx + vz * c.dz
          const lat = Math.abs(vx * c.dz - vz * c.dx)
          const dot = c.dx * o.dx + c.dz * o.dz
          if ((dot >= 0.7 || (dot <= -0.7 && c.id > o.id)) && lat < SIDE && fwd > 0.05 && d2 <= BRAKE_FROM * BRAKE_FROM) {
            const f = clamp((fwd - HALT) / (BRAKE_FROM - HALT), 0, 1)
            if (f < free) { free = f; queued = o.stage === 'serving'; c.by = `lane:${o.id}` }
            continue
          }
          if (dot > 0.7 && lat < 1.6) continue // same lane: the car-following above covers it
          const older = o.id < c.id && o.stage !== 'serving'
          const reach = o.id > c.id ? TOUCH_YOUNGER : TOUCH // an older car may edge closer to a younger one that is waiting
          for (let k = 0; k < LOOK; k++) {
            const px = c.lookX[k], pz = c.lookZ[k]
            const body = nearBy(px, pz, o.x, o.z, reach) || nearBy(px, pz, o.x + o.dx * 0.9, o.z + o.dz * 0.9, reach) || nearBy(px, pz, o.x - o.dx * 0.9, o.z - o.dz * 0.9, reach)
            let sweep = false
            if (!body && older) for (let j = 0; j < LOOK; j++) if (near(px, pz, o.lookX[j], o.lookZ[j])) { sweep = true; break }
            if (body || sweep) {
              // a body is in the way: slow down for it. An older car's path is crossed: stop well short of it
              const f = sweep ? clamp((k - 3) / 2, 0, 1) : clamp((k - 0.5) / 2.0, 0, 1)
              if (f < free) { free = f; queued = false; c.by = `sweep:${o.id}` }
              break
            }
          }
        }
      }
      c.stuck = free < 0.05 && c.stage !== 'serving' && !queued ? c.stuck + dt : 0
      if (c.stuck > 6 && c.fade < 0) c.fade = 0.5 // never deadlock: a car that cannot move for a long time dissolves, so the jam clears
      if (c.fade >= 0) {
        c.fade -= dt
        if (c.fade < 0) c.id = -1
        continue
      }
      const before = c.dist
      if (c.stage === 'serving') {
        c.timer -= dt
        if (c.timer <= 0) {
          if (c.failed) {
            // turned away: waits at the door for a gap in the traffic home; after a couple of seconds it edges out and the cars behind give way
            c.wait += dt
            this.turnAround(c, c.wait > 2)
          } else c.fade = 0.5 // served: the car drives into the building and is gone
        }
      } else {
        c.dist = Math.min(c.total, c.dist + SPEED * c.pace * free * dt)
      }
      c.speed = dt > 0 ? (c.dist - before) / dt : 0
    }

    // A standoff, two cars each waiting for the other, would last for ever: after a moment the younger one gives up and dissolves.
    const byId = new Map<number, Car>()
    for (const c of this.cars) byId.set(c.id, c)
    for (const c of this.cars) {
      const o = c.fade < 0 && c.by && c.speed <= 0.3 ? byId.get(Number(c.by.split(':')[1])) : undefined
      if (o && o.fade < 0 && o.speed <= 0.3 && o.by && Number(o.by.split(':')[1]) === c.id) {
        c.standoff += dt
        if (c.standoff > 1.5 && c.id > o.id) c.fade = 0.4
      } else c.standoff = 0
    }

    for (const c of this.cars) {
      if (c.stage === 'there') {
        if (!c.committed && c.dist >= c.plan.decision) c.committed = true
        if (c.stage === 'there' && c.dist >= c.total) {
          const n = c.plan.route.dest.node
          const ratio = n && n.slaP99Ms > 0 ? n.p99Ms / n.slaP99Ms : 0
          c.stage = 'serving'
          // time at the door is the latency: brief inside the SLA, longer as p99 passes it. Failed requests are turned away after a short stop.
          c.timer = c.failed ? FAIL_HOLD : Math.min(6, 0.3 + 1.6 * Math.max(0, ratio - 0.5))
        }
      } else if (c.stage === 'back' && c.dist >= c.total - 2.5 && c.fade < 0) {
        c.fade = 0.4 // gone from the sample just before the start of the road, where new cars appear
      }
    }
    for (let i = this.cars.length - 1; i >= 0; i--) if (this.cars[i].id < 0) this.cars.splice(i, 1)

    const counts = [0, 0]
    let flagN = 0, lightN = 0
    const blink = Math.floor(this.time * 2.4) % 2 === 0
    for (const c of this.cars) {
      this.sample(c)
      const target = Math.atan2(c.dx, c.dz)
      let d = target - c.yaw
      d = Math.atan2(Math.sin(d), Math.cos(d))
      c.yaw += d * Math.min(1, dt * 9)
      c.age += dt
      if (!carShown(c.tenant, this.tenantKinds, this.view)) continue
      const s = this.unit[c.model] * (c.fade >= 0 ? Math.max(0.01, c.fade / 0.5) : Math.min(1, 0.05 + c.age / GROW))
      this.q.setFromAxisAngle(this.up, c.yaw)
      this.m.compose(this.pos, this.q, this.scaleV.set(s, s, s))
      this.meshes[c.model].setMatrixAt(counts[c.model]++, this.m)
      if (c.failed) {
        this.m.compose(this.pos.clone().setY(this.pos.y + 0.78), this.q, this.one)
        this.flags.setMatrixAt(flagN++, this.m)
      }
      const n = c.plan.route.dest.node
      const slow = !!n && n.slaP99Ms > 0 && n.p99Ms > n.slaP99Ms
      if (blink && slow && c.committed && c.stage !== 'back' && (c.stage === 'serving' || c.speed < 0.4)) {
        for (const side of [-0.4, 0.4]) {
          const p = new THREE.Vector3(side * c.dz, 0.95, -side * c.dx).add(this.pos)
          this.m.compose(p, this.q, this.one)
          this.lights.setMatrixAt(lightN++, this.m)
        }
      }
    }
    this.shown = counts[0] + counts[1]
    this.meshes.forEach((im, i) => { im.count = counts[i]; im.instanceMatrix.needsUpdate = true })
    this.flags.count = flagN
    this.flags.instanceMatrix.needsUpdate = true
    this.lights.count = lightN
    this.lights.instanceMatrix.needsUpdate = true
    this.updateMarkers()
  }

  /** Every road cars can take, for tests. */
  get routeList(): readonly Route[] {
    return this.plans.map((p) => p.route)
  }

  /** The tenants requests are for. Cars already on the road keep theirs; new cars pick by share. */
  setTenants(list: readonly TenantInfo[]): void {
    this.tenants = list
    this.tenantKinds.clear()
    for (const t of list) this.tenantKinds.set(t.id, t.kind)
  }

  /** Which cars are drawn. The cars of hidden tenants still drive (and take their place in the queues); they are only not drawn. */
  setTenantView(view: TenantView): void {
    this.view = view
  }

  /** How many cars were drawn last frame, and how many of them carry each tenant. For tests. */
  get drawn(): number {
    return this.shown
  }

  tenantCounts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const c of this.cars) {
      if (c.fade >= 0 || !carShown(c.tenant, this.tenantKinds, this.view)) continue
      const k = c.tenant ?? ''
      out[k] = (out[k] ?? 0) + 1
    }
    return out
  }

  get count(): number {
    return this.cars.length
  }

  private spawn(plan: Planned): boolean {
    const points = plan.there
    if (points.length < 2) return false
    // a full lane means no more cars appear for this building (nothing turns round: that would read as a rejection)
    let heading = 0
    for (const o of this.cars) if (o.plan.route.dest === plan.route.dest && o.stage !== 'back' && o.fade < 0) heading++
    if (heading >= plan.slots) {
      this.markerFor(plan).full = this.time
      return false
    }
    // never appear on top of another car
    const start = points[0]
    if (this.cars.some((o) => Math.hypot(o.x - start.x, o.z - start.z) < HALT)) return false
    // and never into a crowd: where roads meet, too many cars at once is how they jam
    let near = 0
    for (const o of this.cars) if (Math.hypot(o.x - start.x, o.z - start.z) < CROWD_R) near++
    if (near >= CROWD_MAX) return false
    const first = points[1].clone().sub(points[0])
    const n = plan.route.dest.node
    const failed = this.random() < (n?.errorRate ?? 0)
    const car: Car = {
      id: this.nextId++, plan, points, lengths: segmentLengths(points), total: polyLength(points), dist: 0,
      stage: 'there', committed: false, timer: 0,
      model: plan.route.origin === 'external' ? 1 : 0, failed,
      yaw: Math.atan2(first.x, first.z), x: start.x, z: start.z, dx: first.x, dz: first.z,
      speed: 0, stuck: 0, standoff: 0, fade: -1, lookX: new Array(LOOK).fill(start.x), lookZ: new Array(LOOK).fill(start.z), pace: 0.95 + this.random() * 0.1, wait: 0, age: 0,
      tenant: pickTenant(this.tenants, this.random()),
    }
    const len = Math.hypot(car.dx, car.dz) || 1
    car.dx /= len; car.dz /= len
    this.cars.push(car)
    this.sent++
    return true
  }

  /** Leave the door (or the road) by a smooth U-turn onto the way home, once the lane there is clear. Returns false if it must wait. */
  private turnAround(c: Car, force = false): boolean {
    const tail = c.plan.back
    let best = -1, bestD = Infinity
    for (let i = 0; i < tail.length - 1; i++) {
      const tx = tail[i + 1].x - tail[i].x, tz = tail[i + 1].z - tail[i].z
      if (tx * c.dx + tz * c.dz > 0) continue // must head the other way
      const d = Math.hypot(tail[i].x - c.x, tail[i].z - c.z)
      if (d < bestD) { bestD = d; best = i }
    }
    if (best < 0) { c.id = -1; return true }
    const T = tail[best]
    const dirT = tail[Math.min(tail.length - 1, best + 1)].clone().sub(T).setY(0).normalize()
    for (const o of this.cars) {
      if (force) break
      if (o === c) continue
      if (o.dx * dirT.x + o.dz * dirT.z < 0.5) continue // only cars already driving that way matter
      const ox = o.x - T.x, oz = o.z - T.z
      if (ox * ox + oz * oz < 3.0 * 3.0) return false
      // a car coming up behind the join point in that lane
      const along = ox * dirT.x + oz * dirT.z, side = Math.abs(ox * dirT.z - oz * dirT.x)
      if (along < 0 && along > -7 && side < 1.3 && o.speed > 0.5) return false
    }
    const a = new THREE.Vector3(c.x, T.y, c.z)
    const k = Math.max(1.6, bestD * 0.55)
    const h = new THREE.Vector3(c.dx, 0, c.dz)
    const curve = new THREE.CubicBezierCurve3(a, a.clone().addScaledVector(h, k), T.clone().addScaledVector(dirT, -k), T)
    c.points = [...curve.getPoints(10), ...tail.slice(best + 1)]
    c.lengths = segmentLengths(c.points)
    c.total = polyLength(c.points)
    c.dist = 0
    c.stage = 'back'
    c.committed = false
    this.turnedAway++
    return true
  }

  /** Where the car will be when it has driven to `dist` along its road, stored as look-ahead point k. */
  private pointAt(c: Car, dist: number, k: number): void {
    let i = 0
    let left = dist
    while (i < c.lengths.length - 1 && left > c.lengths[i]) { left -= c.lengths[i]; i++ }
    const t = c.lengths[i] > 0 ? clamp(left / c.lengths[i], 0, 1) : 0
    c.lookX[k] = c.points[i].x + (c.points[i + 1].x - c.points[i].x) * t
    c.lookZ[k] = c.points[i].z + (c.points[i + 1].z - c.points[i].z) * t
  }

  private sample(c: Car): void {
    let i = 0
    let left = c.dist
    while (i < c.lengths.length - 1 && left > c.lengths[i]) { left -= c.lengths[i]; i++ }
    const t = c.lengths[i] > 0 ? clamp(left / c.lengths[i], 0, 1) : 0
    this.pos.lerpVectors(c.points[i], c.points[i + 1], t)
    const dx = c.points[i + 1].x - c.points[i].x, dz = c.points[i + 1].z - c.points[i].z
    const len = Math.hypot(dx, dz)
    if (len > 1e-5) { c.dx = dx / len; c.dz = dz / len }
    c.x = this.pos.x
    c.z = this.pos.z
  }

  private markerFor(plan: Planned): Marker {
    const b = plan.route.dest
    let mk = this.markers.get(b)
    if (!mk) {
      const tex = canvasTexture(320, 96, () => {})
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }))
      sprite.renderOrder = 11
      sprite.scale.set(3.3, 0.99, 1)
      sprite.visible = false
      sprite.position.copy(plan.marker).setY(plan.marker.y + 2.6)
      this.object.add(sprite)
      mk = { sprite, key: '', full: -100 }
      this.markers.set(b, mk)
    }
    return mk
  }

  /** What the bubble over a building's service lane shows, for tests: whether it is up, the "!" and the "+N waiting" count. */
  bubbleOf(b: Building): { visible: boolean; honk: boolean; waiting: number } | null {
    const mk = this.markers.get(b)
    if (!mk) return null
    const [honk, hidden] = mk.key.split('|')
    return { visible: mk.sprite.visible, honk: honk === 'true', waiting: Number(hidden) || 0 }
  }

  /** The "+N waiting" and "!" bubble over a bay. N is the requests in flight (rate times typical latency) that the lane has no room to draw, and "!" shows when p99 is well past the SLA. */
  private updateMarkers(): void {
    for (const plan of this.plans) {
      const n = plan.route.dest.node
      const honk = !!n && n.slaP99Ms > 0 && n.p99Ms > n.slaP99Ms * 1.5 && this.cars.some((c) => c.plan.route.dest === plan.route.dest && c.committed && c.stage !== 'back')
      // The "!" goes up as soon as a car is stuck behind a slow system, whether or not the lane has filled yet; the bubble is made on demand.
      const mk = honk ? this.markerFor(plan) : this.markers.get(plan.route.dest)
      if (!mk) continue
      let hidden = 0
      if (n && this.time - mk.full < 3) {
        const inFlight = n.requestsPerSecond * (n.p99Ms / 2000)
        hidden = Math.max(1, Math.round(inFlight - plan.slots))
      }
      const key = `${honk}|${hidden}`
      mk.sprite.visible = honk || hidden > 0
      if (key === mk.key) continue
      mk.key = key
      const tex = (mk.sprite.material as THREE.SpriteMaterial).map as THREE.CanvasTexture
      const ctx = (tex.image as HTMLCanvasElement).getContext('2d')!
      ctx.clearRect(0, 0, 320, 96)
      ctx.fillStyle = 'rgba(20,28,40,0.92)'; roundRect(ctx, 4, 8, 312, 80, 28); ctx.fill()
      ctx.strokeStyle = '#ffb830'; ctx.lineWidth = 6; ctx.stroke()
      ctx.textBaseline = 'middle'
      let x = 28
      if (honk) {
        ctx.fillStyle = '#ffb830'; ctx.beginPath(); ctx.arc(52, 48, 26, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = '#20180a'; ctx.font = '800 40px system-ui, sans-serif'; ctx.textAlign = 'center'
        ctx.fillText('!', 52, 50)
        x = 94
      }
      if (hidden > 0) {
        ctx.fillStyle = '#fff'; ctx.font = '700 34px system-ui, sans-serif'; ctx.textAlign = 'left'
        ctx.fillText(`+${hidden} waiting`, x, 50, 300 - x)
      }
      tex.needsUpdate = true
    }
  }
}

function nearBy(ax: number, az: number, bx: number, bz: number, r: number): boolean {
  const dx = ax - bx, dz = az - bz
  return dx * dx + dz * dz < r * r
}

function near(ax: number, az: number, bx: number, bz: number): boolean {
  const dx = ax - bx, dz = az - bz
  return dx * dx + dz * dz < TOUCH * TOUCH
}

function segmentLengths(points: THREE.Vector3[]): number[] {
  const out: number[] = []
  for (let i = 1; i < points.length; i++) out.push(points[i].distanceTo(points[i - 1]))
  return out
}

function polyLength(points: THREE.Vector3[]): number {
  let l = 0
  for (let i = 1; i < points.length; i++) l += points[i].distanceTo(points[i - 1])
  return l
}

/** Replaces sharp corners with short curves so cars steer round them. */
export function roundCorners(points: THREE.Vector3[], radius: number): THREE.Vector3[] {
  if (points.length < 3) return points.map((p) => p.clone())
  const out: THREE.Vector3[] = [points[0].clone()]
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1], p = points[i], next = points[i + 1]
    const a = prev.clone().sub(p), b = next.clone().sub(p)
    const r = Math.min(radius, a.length() / 2, b.length() / 2)
    if (r < 0.05) { out.push(p.clone()); continue }
    const p1 = p.clone().addScaledVector(a.normalize(), r)
    const p2 = p.clone().addScaledVector(b.normalize(), r)
    const curve = new THREE.QuadraticBezierCurve3(p1, p.clone(), p2)
    out.push(...curve.getPoints(5))
  }
  out.push(points[points.length - 1].clone())
  return out
}

/** Shifts a road centre line to the driver's right-hand lane. */
export function driveOnRight(points: THREE.Vector3[], offset: number): THREE.Vector3[] {
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)]
    const d = b.clone().sub(a).setY(0).normalize()
    return p.clone().add(new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(offset))
  })
}
