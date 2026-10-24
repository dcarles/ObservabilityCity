import * as THREE from 'three'
import type { Building } from '../buildings/building'
import { palette } from '../themes/harbour-town/palette'
import { clamp, spawnRate, speedFactor } from '../visuals'

/** A way people reach a building: where they start, which way they walk, and what colour they wear. */
export interface Route {
  dest: Building
  /** Builds a fresh path for one walker; lane is -1..1 to spread people across the street. */
  makePath(lane: number): THREE.Vector3[]
  color: THREE.Color
  /** Share of the destination's traffic that takes this route. */
  share: number
}

interface Walker {
  points: THREE.Vector3[]
  lengths: number[]
  total: number
  dist: number
  dest: Building
  color: THREE.Color
  failed: boolean
  phase: number
}

const BASE_SPEED = 2.6
const FADE = 0.9

/**
 * People crossing the town. The number of walkers follows the request rate, their speed follows latency
 * against the SLA, and red walkers are failed calls. All of it is invented in the browser from the
 * numbers in the snapshot, drawn as two instanced meshes (bodies and heads).
 */
export class WalkerSystem {
  readonly object = new THREE.Group()
  private readonly bodies: THREE.InstancedMesh
  private readonly heads: THREE.InstancedMesh
  private readonly walkers: Walker[] = []
  private readonly routes: Route[] = []
  private readonly acc = new Map<Route, number>()
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly tmp = new THREE.Vector3()
  private readonly up = new THREE.Vector3(0, 1, 0)

  constructor(private readonly max = 420) {
    const body = new THREE.CapsuleGeometry(0.17, 0.32, 3, 8)
    body.translate(0, 0.38, 0)
    this.bodies = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ roughness: 0.7, flatShading: true }), max)
    const head = new THREE.SphereGeometry(0.15, 10, 8)
    head.translate(0, 0.92, 0)
    this.heads = new THREE.InstancedMesh(head, new THREE.MeshStandardMaterial({ color: palette.walker.skin, roughness: 0.8, flatShading: true }), max)
    for (const im of [this.bodies, this.heads]) {
      im.count = 0
      im.castShadow = true
      im.frustumCulled = false
      this.object.add(im)
    }
  }

  setRoutes(routes: Route[]): void {
    this.routes.length = 0
    this.routes.push(...routes)
    this.acc.clear()
  }

  update(dt: number): void {
    // Spawn: each route accumulates fractional walkers from its destination's request rate.
    for (const r of this.routes) {
      const n = r.dest.node
      if (!n || (n.state !== 'Healthy' && n.state !== 'Degraded')) continue
      const rate = spawnRate(n.requestsPerSecond) * r.share
      const a = (this.acc.get(r) ?? Math.random()) + rate * dt
      let whole = Math.floor(a)
      this.acc.set(r, a - whole)
      while (whole-- > 0 && this.walkers.length < this.max) this.spawn(r)
    }

    for (let i = this.walkers.length - 1; i >= 0; i--) {
      const w = this.walkers[i]
      const n = w.dest.node
      // A building that went down or stale turns people away: they stop coming and fade where they stand.
      const speed = BASE_SPEED * (n ? speedFactor(n.p99Ms, n.slaP99Ms) : 1)
      w.dist += speed * dt
      if (w.dist >= w.total) this.walkers.splice(i, 1)
    }

    this.bodies.count = this.heads.count = this.walkers.length
    const tint = new THREE.Color()
    this.walkers.forEach((w, i) => {
      const { pos, dir } = this.sample(w, w.dist)
      const fade = clamp(Math.min(w.dist, w.total - w.dist) / FADE, 0, 1)
      const bob = Math.abs(Math.sin(w.dist * 3.2 + w.phase)) * 0.06
      const s = 0.4 + 0.6 * fade
      this.q.setFromAxisAngle(this.up, Math.atan2(dir.x, dir.z))
      this.m.compose(this.tmp.set(pos.x, pos.y + bob, pos.z), this.q, new THREE.Vector3(s, s, s))
      this.bodies.setMatrixAt(i, this.m)
      this.heads.setMatrixAt(i, this.m)
      tint.copy(w.failed ? new THREE.Color(palette.walker.failed) : w.color)
      this.bodies.setColorAt(i, tint)
    })
    this.bodies.instanceMatrix.needsUpdate = true
    this.heads.instanceMatrix.needsUpdate = true
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true
  }

  get count(): number {
    return this.walkers.length
  }

  private spawn(r: Route): void {
    const n = r.dest.node
    const points = r.makePath(Math.random() * 2 - 1)
    if (points.length < 2) return
    const lengths: number[] = []
    let total = 0
    for (let i = 1; i < points.length; i++) {
      const l = points[i].distanceTo(points[i - 1])
      lengths.push(l)
      total += l
    }
    this.walkers.push({
      points, lengths, total, dist: 0, dest: r.dest,
      color: r.color.clone().offsetHSL((Math.random() - 0.5) * 0.04, 0, (Math.random() - 0.5) * 0.12),
      failed: n ? Math.random() < n.errorRate : false,
      phase: Math.random() * 6,
    })
  }

  private readonly outPos = new THREE.Vector3()
  private readonly outDir = new THREE.Vector3()

  private sample(w: Walker, d: number): { pos: THREE.Vector3; dir: THREE.Vector3 } {
    let i = 0
    let left = d
    while (i < w.lengths.length - 1 && left > w.lengths[i]) { left -= w.lengths[i]; i++ }
    const t = w.lengths[i] > 0 ? clamp(left / w.lengths[i], 0, 1) : 0
    this.outPos.lerpVectors(w.points[i], w.points[i + 1], t)
    this.outDir.subVectors(w.points[i + 1], w.points[i]).normalize()
    return { pos: this.outPos, dir: this.outDir }
  }
}

/** Offsets the interior points of a path sideways so walkers on the same street don't queue in single file. */
export function spreadLane(points: THREE.Vector3[], lane: number, halfWidth: number): THREE.Vector3[] {
  return points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return p.clone()
    const a = points[i - 1], b = points[i + 1]
    const dir = b.clone().sub(a).setY(0).normalize()
    const side = new THREE.Vector3(-dir.z, 0, dir.x)
    return p.clone().addScaledVector(side, lane * halfWidth)
  })
}
