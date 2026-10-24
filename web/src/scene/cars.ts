import * as THREE from 'three'
import type { Building } from '../buildings/building'
import { kitParts, type KitName } from '../assets/kit'
import { clamp, spawnRate, speedFactor } from '../visuals'

/** Where a request comes from decides the car: internal calls are blue sedans, external calls yellow taxis. */
export type Origin = 'internal' | 'external'

/** A way requests reach a building: the road they take and whether they come from inside or outside. */
export interface Route {
  dest: Building
  origin: Origin
  /** Road centre line from where cars appear to where they park. */
  path: THREE.Vector3[]
  /** Share of the destination's traffic that takes this route. */
  share: number
  /** True for cars driving away from the building (responses), which reverse the path. */
  leaving?: boolean
}

interface Car {
  points: THREE.Vector3[]
  lengths: number[]
  total: number
  dist: number
  dest: Building
  model: 0 | 1 | 2
  yaw: number
}

const MODELS: KitName[] = ['car_sedan', 'car_taxi', 'car_hatchback'] // internal, external, failed
const CAR_SCALE = 2.3
const BASE_SPEED = 4.2
const LANE = 1.05
const FADE = 1.6

/**
 * Requests as cars. The number of cars follows the request rate, their speed follows latency against the
 * SLA, blue ones are internal calls, yellow ones external, and red ones are failed requests. All of it is
 * invented in the browser from the numbers in the snapshot, drawn as instanced kit models.
 */
export class CarSystem {
  readonly object = new THREE.Group()
  private readonly meshes: THREE.InstancedMesh[] = []
  private readonly cars: Car[] = []
  private readonly routes: Route[] = []
  private readonly acc = new Map<Route, number>()
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly up = new THREE.Vector3(0, 1, 0)
  private readonly pos = new THREE.Vector3()
  private readonly dir = new THREE.Vector3()
  private readonly scaleV = new THREE.Vector3()

  constructor(private readonly max = 260) {
    for (const name of MODELS) {
      const { geometry, material } = kitParts(name)
      const im = new THREE.InstancedMesh(geometry, material, max)
      im.count = 0
      im.castShadow = true
      im.receiveShadow = true
      im.frustumCulled = false
      this.meshes.push(im)
      this.object.add(im)
    }
  }

  setRoutes(routes: Route[]): void {
    this.routes.length = 0
    for (const r of routes) {
      const path = roundCorners(r.leaving ? [...r.path].reverse() : r.path, 1.6)
      this.routes.push({ ...r, path: driveOnRight(path, LANE) })
    }
    this.acc.clear()
  }

  update(dt: number): void {
    for (const r of this.routes) {
      const n = r.dest.node
      if (!n || (n.state !== 'Healthy' && n.state !== 'Degraded')) continue
      const a = (this.acc.get(r) ?? Math.random()) + spawnRate(n.requestsPerSecond) * r.share * dt
      let whole = Math.floor(a)
      this.acc.set(r, a - whole)
      while (whole-- > 0 && this.cars.length < this.max) this.spawn(r)
    }

    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i]
      const n = c.dest.node
      c.dist += BASE_SPEED * (n ? speedFactor(n.p99Ms, n.slaP99Ms) : 1) * dt
      if (c.dist >= c.total) this.cars.splice(i, 1)
    }

    const counts = [0, 0, 0]
    for (const c of this.cars) {
      this.sample(c, c.dist)
      const target = Math.atan2(this.dir.x, this.dir.z)
      // Turn smoothly through corners instead of snapping.
      let d = target - c.yaw
      d = Math.atan2(Math.sin(d), Math.cos(d))
      c.yaw += d * Math.min(1, dt * 9)
      const fade = clamp(Math.min(c.dist, c.total - c.dist) / FADE, 0, 1)
      const s = CAR_SCALE * (0.3 + 0.7 * fade)
      this.q.setFromAxisAngle(this.up, c.yaw)
      this.m.compose(this.pos, this.q, this.scaleV.set(s, s, s))
      this.meshes[c.model].setMatrixAt(counts[c.model]++, this.m)
    }
    this.meshes.forEach((im, i) => {
      im.count = counts[i]
      im.instanceMatrix.needsUpdate = true
    })
  }

  get count(): number {
    return this.cars.length
  }

  private spawn(r: Route): void {
    const points = r.path
    if (points.length < 2) return
    const lengths: number[] = []
    let total = 0
    for (let i = 1; i < points.length; i++) {
      const l = points[i].distanceTo(points[i - 1])
      lengths.push(l)
      total += l
    }
    const failed = Math.random() < (r.dest.node?.errorRate ?? 0)
    const first = points[1].clone().sub(points[0])
    this.cars.push({
      points, lengths, total, dist: 0, dest: r.dest,
      model: failed ? 2 : r.origin === 'external' ? 1 : 0,
      yaw: Math.atan2(first.x, first.z),
    })
  }

  private sample(c: Car, d: number): void {
    let i = 0
    let left = d
    while (i < c.lengths.length - 1 && left > c.lengths[i]) { left -= c.lengths[i]; i++ }
    const t = c.lengths[i] > 0 ? clamp(left / c.lengths[i], 0, 1) : 0
    this.pos.lerpVectors(c.points[i], c.points[i + 1], t)
    this.dir.subVectors(c.points[i + 1], c.points[i]).normalize()
  }
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
