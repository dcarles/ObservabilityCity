// The real island an event plays on, as plain data: its coast, the buildings standing on it, and a map of where a person can walk. Everything an
// event does on the island (where the ship moors, which buildings are raided, the route each person takes) is worked out from this, so a test
// can check it on towns of any shape without drawing anything. Coordinates are island-local: the same as the buildings' own.

import * as THREE from 'three'
import { rng, V, type Disc, type Seg } from './rig'

/** One building as a box on the ground: island-local, `h` high. */
export interface Block {
  id: string
  x0: number
  x1: number
  z0: number
  z1: number
  h: number
}

/** What the town hands over about one island. */
export interface ArenaSource {
  id: string
  name: string
  /** The coast, island-local, counter-clockwise. */
  outline: { x: number; z: number }[]
  blocks: Block[]
  /** The way out to sea, away from the middle of the town, as an island-local angle: atan2(x, z). */
  seaward: number
  /** Island-local spot where the bridge from the town meets the island, if the island has one. */
  gate?: { x: number; z: number }
}

const CELL = 1
/** How far a person keeps from a building, and from the coast. */
export const MARGIN = 1.0
const COAST_INSET = 1.0

const inPoly = (poly: readonly { x: number; z: number }[], x: number, z: number): boolean => {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

/** The distance from a point to a box (0 inside it). */
export const distToBlock = (b: Block, x: number, z: number): number => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.z0 - z, 0, z - b.z1))

class Heap {
  private a: { k: number; f: number }[] = []
  get size(): number {
    return this.a.length
  }
  push(k: number, f: number): void {
    const a = this.a
    a.push({ k, f })
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].f <= a[i].f) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop(): number {
    const a = this.a
    const top = a[0]
    const last = a.pop()!
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l].f < a[m].f) m = l
        if (r < a.length && a[r].f < a[m].f) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top.k
  }
}

export class Arena {
  readonly blocks: Block[]
  readonly outline: { x: number; z: number }[]
  private readonly x0: number
  private readonly z0: number
  private readonly nx: number
  private readonly nz: number
  private readonly walls: Uint8Array
  private readonly extra: Disc[] = []
  /** An obstacle a route may go right up to for now (the door it is walking to). */
  private ignoring: Disc | null = null
  /** The middle of the island (the middle of its coast's bounding box). */
  readonly centre: { x: number; z: number }

  constructor(readonly src: ArenaSource, readonly margin: number = MARGIN, readonly pad: number = 0) {
    this.blocks = src.blocks
    this.outline = src.outline
    const xs = src.outline.map((p) => p.x)
    const zs = src.outline.map((p) => p.z)
    this.x0 = Math.floor(Math.min(...xs)) - 1
    this.z0 = Math.floor(Math.min(...zs)) - 1
    this.nx = Math.ceil(Math.max(...xs) - this.x0) + 2
    this.nz = Math.ceil(Math.max(...zs) - this.z0) + 2
    this.centre = { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 }
    this.walls = new Uint8Array(this.nx * this.nz)
    this.rebuild()
  }

  /** Something that now stands in the way (a barricade, a car): people go round it. */
  addObstacle(...d: Disc[]): void {
    this.extra.push(...d)
    this.rebuild()
  }

  private rebuild(): void {
    for (let j = 0; j < this.nz; j++) for (let i = 0; i < this.nx; i++) this.walls[j * this.nx + i] = this.clear(this.x0 + (i + 0.5) * CELL, this.z0 + (j + 0.5) * CELL, 0.72) ? 0 : 1
  }

  /** True when a person of radius `r` can stand here: on the island, away from the coast, clear of every building and obstacle. */
  clear(x: number, z: number, r = 0, ignoreObstacles = false): boolean {
    if (!inPoly(this.outline, x, z)) return false
    // away from the coast: the nearest coast point must be further than the inset
    if (this.coastDistance(x, z) < COAST_INSET + r) return false
    for (const b of this.blocks) if (distToBlock(b, x, z) < this.margin + r - 0.4) return false
    if (!ignoreObstacles) for (const d of this.extra) if (d !== this.ignoring && Math.hypot(d.x - x, d.z - z) < d.r + r + 0.5 + this.pad) return false
    return true
  }

  /** True when the point is on the island at all (inside the coast). */
  onLand(x: number, z: number): boolean {
    return inPoly(this.outline, x, z)
  }

  /** The distance from a point to the coast. */
  coastDistance(x: number, z: number): number {
    let best = Infinity
    const o = this.outline
    for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
      const ax = o[j].x
      const az = o[j].z
      const dx = o[i].x - ax
      const dz = o[i].z - az
      const k = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)))
      best = Math.min(best, Math.hypot(x - (ax + k * dx), z - (az + k * dz)))
    }
    return best
  }

  private cellOf(x: number, z: number): [number, number] {
    return [Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.x0) / CELL))), Math.max(0, Math.min(this.nz - 1, Math.floor((z - this.z0) / CELL)))]
  }

  private free(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.nx && j < this.nz && this.walls[j * this.nx + i] === 0
  }

  /** The nearest spot to (x, z) where a person can stand, searching outwards in rings; null when the island has none. */
  nearestClear(x: number, z: number, r = 0, ok: (x: number, z: number) => boolean = () => true): THREE.Vector3 | null {
    if (this.clear(x, z, r) && ok(x, z)) return V(x, 0, z)
    for (let ring = 1; ring < 80; ring++) {
      let best: THREE.Vector3 | null = null
      let bd = Infinity
      const steps = Math.max(8, ring * 8)
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2
        const px = x + Math.cos(a) * ring * 0.5
        const pz = z + Math.sin(a) * ring * 0.5
        if (this.clear(px, pz, r) && ok(px, pz)) {
          const d = Math.hypot(px - x, pz - z)
          if (d < bd) {
            bd = d
            best = V(px, 0, pz)
          }
        }
      }
      if (best) return best
    }
    return null
  }

  /** True when the straight line between two spots stays clear. */
  see(a: { x: number; z: number }, b: { x: number; z: number }, r = 0): boolean {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.5))
    for (let k = 0; k <= n; k++) if (!this.clear(a.x + ((b.x - a.x) * k) / n, a.z + ((b.z - a.z) * k) / n, r)) return false
    return true
  }

  /** The way from one spot to another round the buildings, as a list of corner points (first and last are the ends, moved to clear ground); it stops as near as it can get when the goal cannot be reached, and null only when the island has no clear ground at an end. */
  path(from: { x: number; z: number }, to: { x: number; z: number }, goalDisc: Disc | null = null): THREE.Vector3[] | null {
    this.ignoring = goalDisc
    try {
      return this.route(from, to)
    } finally {
      this.ignoring = null
    }
  }

  private route(from: { x: number; z: number }, to: { x: number; z: number }): THREE.Vector3[] | null {
    const a = this.nearestClear(from.x, from.z)
    const b = this.nearestClear(to.x, to.z)
    if (!a || !b) return null
    if (this.see(a, b)) return this.exact([a, b], from, to)
    const [ai, aj] = this.cellOf(a.x, a.z)
    const [bi, bj] = this.cellOf(b.x, b.z)
    const N = this.nx * this.nz
    const g = new Float64Array(N).fill(Infinity)
    const prev = new Int32Array(N).fill(-1)
    const open = new Heap()
    const h = (i: number, j: number): number => {
      const dx = Math.abs(i - bi)
      const dz = Math.abs(j - bj)
      return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz)
    }
    const start = aj * this.nx + ai
    const goal = bj * this.nx + bi
    g[start] = 0
    open.push(start, h(ai, aj))
    // the start and goal cells are walkable by definition (the ends were moved onto clear ground)
    const gd = this.ignoring
    const walk = (i: number, j: number): boolean =>
      this.free(i, j) || j * this.nx + i === goal || j * this.nx + i === start || (!!gd && i >= 0 && j >= 0 && i < this.nx && j < this.nz && Math.hypot(this.x0 + (i + 0.5) * CELL - gd.x, this.z0 + (j + 0.5) * CELL - gd.z) < gd.r + 1.6 && this.clear(this.x0 + (i + 0.5) * CELL, this.z0 + (j + 0.5) * CELL, 0.72))
    // when the goal cannot be reached the walk goes as near to it as it can
    let nearest = start
    let nearestH = h(ai, aj)
    while (open.size) {
      const k = open.pop()
      if (k === goal) break
      const hk = h(k % this.nx, (k - (k % this.nx)) / this.nx)
      if (hk < nearestH) {
        nearestH = hk
        nearest = k
      }
      const i = k % this.nx
      const j = (k - i) / this.nx
      for (let di = -1; di <= 1; di++)
        for (let dj = -1; dj <= 1; dj++) {
          if (!di && !dj) continue
          const ni = i + di
          const nj = j + dj
          if (!walk(ni, nj)) continue
          if (di && dj && !(walk(i + di, j) && walk(i, j + dj))) continue
          const nk = nj * this.nx + ni
          const c = g[k] + (di && dj ? Math.SQRT2 : 1)
          if (c < g[nk]) {
            g[nk] = c
            prev[nk] = k
            open.push(nk, c + h(ni, nj))
          }
        }
    }
    const reached = isFinite(g[goal])
    const cells: THREE.Vector3[] = []
    for (let k = reached ? goal : nearest; k !== -1; k = prev[k]) {
      const i = k % this.nx
      cells.push(V(this.x0 + (i + 0.5) * CELL, 0, this.z0 + ((k - i) / this.nx + 0.5) * CELL))
    }
    cells.reverse()
    cells[0] = a
    if (reached) cells[cells.length - 1] = b
    // string-pulling: skip every corner that can be cut
    const out = [cells[0]]
    let at = 0
    while (at < cells.length - 1) {
      let far = at + 1
      for (let k = cells.length - 1; k > at + 1; k--)
        if (this.see(cells[at], cells[k], 0.72)) {
          far = k
          break
        }
      out.push(cells[far])
      at = far
    }
    return reached ? this.exact(out, from, to) : this.exact(out, from, out[out.length - 1])
  }

  /** Puts the true ends on a route whose ends were moved onto clear ground, when they moved only a little. */
  private exact(route: THREE.Vector3[], from: { x: number; z: number }, to: { x: number; z: number }): THREE.Vector3[] {
    const out = route.map((p) => p.clone())
    // an end goes back to where it really is when the leg from there is clear; a start that cannot is walked to from where it really is
    const f = V(from.x, 0, from.z)
    if (Math.hypot(out[0].x - from.x, out[0].z - from.z) < 2) {
      if (out.length < 2 || this.see(f, out[1])) out[0] = f
      else out.unshift(f)
    }
    const last = out.length - 1
    const t = V(to.x, 0, to.z)
    if (Math.hypot(out[last].x - to.x, out[last].z - to.z) < 2 && (last < 1 || this.see(out[last - 1], t))) out[last] = t
    return out
  }

  /** The spot on the coast in a direction from the middle of the island (an island-local angle, atan2(x, z)). */
  coastAt(angle: number): THREE.Vector3 {
    const dx = Math.sin(angle)
    const dz = Math.cos(angle)
    let last = 0
    for (let r = 0; r < 400; r += 0.25) {
      if (inPoly(this.outline, this.centre.x + dx * r, this.centre.z + dz * r)) last = r
    }
    return V(this.centre.x + dx * last, 0, this.centre.z + dz * last)
  }

  /** Where the coast is on the sea side of the town. */
  get shore(): THREE.Vector3 {
    return this.coastAt(this.src.seaward)
  }

  /** A clear spot on the ground at a distance in from the coast, along the way out to sea. */
  inland(back: number, side = 0, angle = this.src.seaward): THREE.Vector3 | null {
    const s = this.coastAt(angle)
    const dx = Math.sin(angle)
    const dz = Math.cos(angle)
    return this.nearestClear(s.x - dx * back - dz * side, s.z - dz * back + dx * side)
  }

  /** The longest reach of the coast from the middle. */
  get reach(): number {
    return this.outline.reduce((m, p) => Math.max(m, Math.hypot(p.x - this.centre.x, p.z - this.centre.z)), 0)
  }

  /** Clear spots around a building, close to it, in order round it. */
  spotsAround(b: Block, n: number, gap = this.margin + 0.15, apart = 1.8): THREE.Vector3[] {
    const out: THREE.Vector3[] = []
    const cx = (b.x0 + b.x1) / 2
    const cz = (b.z0 + b.z1) / 2
    const hw = (b.x1 - b.x0) / 2 + gap
    const hd = (b.z1 - b.z0) / 2 + gap
    const per = 2 * (hw + hd) * 2
    for (let k = 0; k < n * 6 && out.length < n; k++) {
      const s = ((k + 0.5) / (n * 6)) * per
      let x: number
      let z: number
      if (s < 2 * hw) [x, z] = [cx - hw + s, cz + hd]
      else if (s < 2 * hw + 2 * hd) [x, z] = [cx + hw, cz + hd - (s - 2 * hw)]
      else if (s < 4 * hw + 2 * hd) [x, z] = [cx + hw - (s - 2 * hw - 2 * hd), cz - hd]
      else [x, z] = [cx - hw, cz - hd + (s - 4 * hw - 2 * hd)]
      if (this.clear(x, z, 0.2) && out.every((o) => Math.hypot(o.x - x, o.z - z) > apart)) out.push(V(x, 0, z))
    }
    return out
  }

  /** The clear spot beside a building that is closest to a given point (or the next closest, for `rank` 1, and so on). */
  doorOf(b: Block, near: { x: number; z: number }, rank = 0): THREE.Vector3 | null {
    const spots = this.spotsAround(b, 24).sort((p, q) => Math.hypot(p.x - near.x, p.z - near.z) - Math.hypot(q.x - near.x, q.z - near.z))
    return spots[Math.min(rank, spots.length - 1)] ?? null
  }

  /** The buildings, nearest first to a point. */
  blocksByDistance(x: number, z: number): Block[] {
    return [...this.blocks].sort((a, b) => distToBlock(a, x, z) - distToBlock(b, x, z))
  }

  /** Picks `n` buildings that lie spread out: the first nearest to `x, z`, each next the one furthest from those chosen. */
  spread(n: number, x: number, z: number, seed = 1): Block[] {
    if (this.blocks.length <= n) return [...this.blocks]
    const R = rng(seed)
    const chosen = [this.blocksByDistance(x, z)[0]]
    const mid = (b: Block): { x: number; z: number } => ({ x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 })
    while (chosen.length < n) {
      let best: Block | null = null
      let bs = -1
      for (const b of this.blocks) {
        if (chosen.includes(b)) continue
        const m = mid(b)
        const s = Math.min(...chosen.map((c) => Math.hypot(mid(c).x - m.x, mid(c).z - m.z))) + R() * 0.5
        if (s > bs) {
          bs = s
          best = b
        }
      }
      chosen.push(best!)
    }
    return chosen
  }
}

/** A walk along a list of points at a speed, as timeline segments. */
export function along(points: readonly THREE.Vector3[], speed: number, clip = 'Run', extra: Partial<Seg> = {}): Seg[] {
  const out: Seg[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const d = points[i].distanceTo(points[i + 1])
    if (d < 1e-3) continue
    out.push({ d: d / speed, from: points[i], to: points[i + 1], clip, ...extra })
  }
  return out
}

/** The length of a list of points. */
export const lengthOf = (points: readonly THREE.Vector3[]): number => points.slice(1).reduce((a, p, i) => a + p.distanceTo(points[i]), 0)

export const middleOf = (b: Block): THREE.Vector3 => V((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2)
