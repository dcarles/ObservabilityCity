import * as THREE from 'three'

/** What boats must stay clear of: every island's coast, in world x/z. Bridges are not on the list: every bridge is an arch, and boats sail under it. */
export interface SeaMap {
  land: THREE.Vector2[][]
}

const CELL = 2.5

/** How far out into the open water a boat sails on a loop from its own harbour, longest first: the longest that is clear of land is used. A long loop keeps each boat in view longer, so busy traffic inside an island shows as several boats at once. */
export const LOOP_LENGTHS = [44, 34, 26, 16, 11, 7]

/** How far along the coast a loop starts from the harbour's own water, so its boats keep out of the way of the boats that sail to and from other islands. */
export const LOOP_OFFSET = 4.5
const LAND_MARGIN = 3.2

/** Whether a spot is open water: not land, and not within the margin boats keep from a coast. */
export function isOpenWater(map: SeaMap, x: number, z: number): boolean {
  const pts = map.land.flat()
  if (pts.length === 0) return true
  const { minX, minZ, w, h, blocked } = gridOf(map, pts)
  const i = Math.floor((x - minX) / CELL), j = Math.floor((z - minZ) / CELL)
  return i >= 0 && j >= 0 && i < w && j < h && !blocked[j * w + i]
}

function distToSegment(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const abx = b.x - a.x, aby = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby || 1)))
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t))
}

function inPolygon(poly: THREE.Vector2[], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

interface Grid {
  minX: number
  minZ: number
  w: number
  h: number
  blocked: Uint8Array
}

const grids = new WeakMap<SeaMap, Grid>()

/** Which sea cells are land or shore. Worked out once per map, since every island's lane uses the same one. */
function gridOf(map: SeaMap, pts: THREE.Vector2[]): Grid {
  const cached = grids.get(map)
  if (cached) return cached
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.y); maxZ = Math.max(maxZ, p.y)
  }
  minX -= 60; minZ -= 60; maxX += 60; maxZ += 60
  const w = Math.ceil((maxX - minX) / CELL), h = Math.ceil((maxZ - minZ) / CELL)
  const blocked = new Uint8Array(w * h)
  const cell = (v: number, min: number) => Math.floor((v - min) / CELL)
  const mark = (i: number, j: number) => { if (i >= 0 && j >= 0 && i < w && j < h) blocked[j * w + i] = 1 }
  // Each coast marks the cells inside it and within a margin of its edge, looking only at the cells near that coast.
  for (const poly of map.land) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (const p of poly) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.y); z1 = Math.max(z1, p.y) }
    for (let j = cell(z0, minZ); j <= cell(z1, minZ); j++)
      for (let i = cell(x0, minX); i <= cell(x1, minX); i++)
        if (inPolygon(poly, minX + (i + 0.5) * CELL, minZ + (j + 0.5) * CELL)) mark(i, j)
    const probe = new THREE.Vector2()
    for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
      const a = poly[m], c = poly[k]
      const reach = Math.ceil(LAND_MARGIN / CELL) + 1
      for (let j = cell(Math.min(a.y, c.y), minZ) - reach; j <= cell(Math.max(a.y, c.y), minZ) + reach; j++)
        for (let i = cell(Math.min(a.x, c.x), minX) - reach; i <= cell(Math.max(a.x, c.x), minX) + reach; i++) {
          probe.set(minX + (i + 0.5) * CELL, minZ + (j + 0.5) * CELL)
          if (distToSegment(probe, a, c) < LAND_MARGIN) mark(i, j)
        }
    }
  }
  const grid = { minX, minZ, w, h, blocked }
  grids.set(map, grid)
  return grid
}

/** Finds a sea lane between two points that never touches land. It passes under any bridge in its way, as every bridge is an arch. Null when there is none. */
export function findLane(map: SeaMap, from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] | null {
  const pts = map.land.flat()
  if (pts.length === 0) return null
  const { minX, minZ, w, h, blocked } = gridOf(map, pts)
  const cellOf = (x: number, z: number) => [Math.floor((x - minX) / CELL), Math.floor((z - minZ) / CELL)] as const
  const free = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h && !blocked[j * w + i]
  const nearestFree = (x: number, z: number): [number, number] | null => {
    const [ci, cj] = cellOf(x, z)
    for (let r = 0; r < 14; r++) {
      let best: [number, number] | null = null
      let bestD = Infinity
      for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r || !free(i, j)) continue
        const d = Math.hypot(i - ci, j - cj)
        if (d < bestD) { bestD = d; best = [i, j] }
      }
      if (best) return best
    }
    return null
  }
  const s = nearestFree(from.x, from.z), e = nearestFree(to.x, to.z)
  if (!s || !e) return null

  // A* over the free sea cells, eight ways
  const g = new Float64Array(w * h).fill(Infinity)
  const prev = new Int32Array(w * h).fill(-1)
  const open: [number, number][] = [] // [f, index], a plain binary heap
  const push = (f: number, idx: number) => {
    open.push([f, idx])
    let c = open.length - 1
    while (c > 0) {
      const p = (c - 1) >> 1
      if (open[p][0] <= open[c][0]) break
      ;[open[p], open[c]] = [open[c], open[p]]
      c = p
    }
  }
  const pop = (): number => {
    const top = open[0]
    const last = open.pop()!
    if (open.length > 0) {
      open[0] = last
      let c = 0
      for (;;) {
        const l = c * 2 + 1, r = l + 1
        let m = c
        if (l < open.length && open[l][0] < open[m][0]) m = l
        if (r < open.length && open[r][0] < open[m][0]) m = r
        if (m === c) break
        ;[open[m], open[c]] = [open[c], open[m]]
        c = m
      }
    }
    return top[1]
  }
  const startIdx = s[1] * w + s[0], endIdx = e[1] * w + e[0]
  g[startIdx] = 0
  push(Math.hypot(s[0] - e[0], s[1] - e[1]), startIdx)
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  const closed = new Uint8Array(w * h)
  while (open.length > 0) {
    const cur = pop()
    if (cur === endIdx) break
    if (closed[cur]) continue // an older, worse entry for a cell already settled
    closed[cur] = 1
    const ci = cur % w, cj = (cur - ci) / w
    for (const [di, dj] of dirs) {
      const ni = ci + di, nj = cj + dj
      if (!free(ni, nj)) continue
      if (di !== 0 && dj !== 0 && (!free(ci + di, cj) || !free(ci, cj + dj))) continue
      const idx = nj * w + ni
      const cost = g[cur] + (di !== 0 && dj !== 0 ? 1.414 : 1)
      if (cost < g[idx]) {
        g[idx] = cost
        prev[idx] = cur
        push(cost + Math.hypot(ni - e[0], nj - e[1]), idx)
      }
    }
  }
  if (!isFinite(g[endIdx])) return null

  const cells: THREE.Vector3[] = []
  for (let idx = endIdx; idx !== -1; idx = prev[idx]) {
    const i = idx % w, j = (idx - i) / w
    cells.push(new THREE.Vector3(minX + (i + 0.5) * CELL, 0, minZ + (j + 0.5) * CELL))
  }
  cells.reverse()

  // pull the string tight: skip ahead to the furthest point still in clear sight
  const clear = (a: THREE.Vector3, b: THREE.Vector3) => {
    const n = Math.ceil(a.distanceTo(b) / (CELL * 0.5))
    for (let k = 0; k <= n; k++) {
      const [i, j] = cellOf(a.x + ((b.x - a.x) * k) / n, a.z + ((b.z - a.z) * k) / n)
      if (!free(i, j)) return false
    }
    return true
  }
  const tight: THREE.Vector3[] = [from.clone().setY(0)]
  let at = 0
  while (at < cells.length - 1) {
    let next = at + 1
    for (let k = cells.length - 1; k > at + 1; k--) if (clear(cells[at], cells[k])) { next = k; break }
    tight.push(cells[next])
    at = next
  }
  tight.push(to.clone().setY(0))

  // round the corners so boats turn instead of pivoting, and keep the result only if it is still clear
  const smooth: THREE.Vector3[] = [tight[0]]
  for (let i = 1; i < tight.length - 1; i++) {
    const a = tight[i - 1], b = tight[i], c = tight[i + 1]
    const r = Math.min(7, a.distanceTo(b) / 2, b.distanceTo(c) / 2)
    const p0 = b.clone().sub(a).setLength(r).negate().add(b)
    const p2 = c.clone().sub(b).setLength(r).add(b)
    for (let k = 0; k <= 6; k++) smooth.push(new THREE.QuadraticBezierCurve3(p0, b, p2).getPoint(k / 6))
  }
  smooth.push(tight[tight.length - 1])
  const ok = smooth.every((p) => {
    const [i, j] = cellOf(p.x, p.z)
    return i < 0 || j < 0 || i >= w || j >= h || !blocked[j * w + i] || p === smooth[0] || p === smooth[smooth.length - 1]
  })
  return ok ? smooth : tight
}

/**
 * A short out-and-back lane for messages that stay on one island: from the water by its harbour a little way out to sea, away from the island's
 * centre, in the first direction that is clear. A two-point lane, sailed there and back.
 */
export function harbourLoop(map: SeaMap, water: THREE.Vector3, centre: THREE.Vector3): THREE.Vector3[] | null {
  const pts = map.land.flat()
  if (pts.length === 0) return null
  const { minX, minZ, w, h, blocked } = gridOf(map, pts)
  const free = (x: number, z: number) => {
    const i = Math.floor((x - minX) / CELL), j = Math.floor((z - minZ) / CELL)
    return i >= 0 && j >= 0 && i < w && j < h && !blocked[j * w + i]
  }
  const out = Math.atan2(water.z - centre.z, water.x - centre.x)
  // a lane of its own: start a little along the coast from the water the other boats use, on whichever side is clear
  let start = water
  for (const side of [1, -1]) {
    const s = new THREE.Vector3(water.x - Math.sin(out) * LOOP_OFFSET * side, 0, water.z + Math.cos(out) * LOOP_OFFSET * side)
    if (free(s.x, s.z)) { start = s; break }
  }
  for (const length of LOOP_LENGTHS) {
    for (const turn of [0, 0.5, -0.5, 1, -1]) {
      const a = out + turn
      const end = new THREE.Vector3(start.x + Math.cos(a) * length, 0, start.z + Math.sin(a) * length)
      let clear = true
      for (let k = 1; k <= 8 && clear; k++) clear = free(start.x + ((end.x - start.x) * k) / 8, start.z + ((end.z - start.z) * k) / 8)
      if (clear) return [start.clone().setY(0), end]
    }
  }
  return null
}

/**
 * How far off the coast, nearest first, the circuit round an island runs: the nearest of these that is clear of every other island is used.
 * It is the inside lane: closer to the coast than the water by the harbour where the boats from other islands arrive, so those never cross it.
 */
export const CIRCUIT_OFFSETS = [5, 4.2, 6]

/** How far from the pier's middle line the circuit's two ends are: the boats start and finish on either side of the pier, never across it. */
export const PIER_GAP = 3.4

function distToLine(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  return distToSegment(new THREE.Vector2(p.x, p.z), new THREE.Vector2(a.x, a.z), new THREE.Vector2(b.x, b.z))
}

/**
 * A circuit round the island: it starts at the water beside the pier on one side, goes once round the coast in the water just off it, one way only, and finishes at
 * the water beside the pier on the other side, where the boats unload. It never crosses the pier (`pier` is the pier's middle line, from its root to its tip). Boats on it all
 * go the same way, so they follow each other and never meet. Null where no ring of open water goes all the way round (a crowded sea); the straight loop is used then.
 */
export function harbourCircuit(map: SeaMap, pier: { from: THREE.Vector3; to: THREE.Vector3 }, centre: THREE.Vector3): THREE.Vector3[] | null {
  const pts = map.land.flat()
  if (pts.length === 0) return null
  const { minX, minZ, w, h, blocked } = gridOf(map, pts)
  const free = (x: number, z: number) => {
    const i = Math.floor((x - minX) / CELL), j = Math.floor((z - minZ) / CELL)
    return i >= 0 && j >= 0 && i < w && j < h && !blocked[j * w + i]
  }
  // this island's coast: the one whose middle is nearest its centre
  let coast: THREE.Vector2[] | null = null
  let best = Infinity
  let mid = new THREE.Vector2()
  for (const poly of map.land) {
    const c = poly.reduce((a, q) => a.add(q), new THREE.Vector2()).divideScalar(poly.length)
    const d = Math.hypot(c.x - centre.x, c.y - centre.z)
    if (d < best) { best = d; coast = poly; mid = c }
  }
  if (!coast || coast.length < 6) return null
  // one direction for every island: the way round that has the sea on its right-hand side, whatever way the outline was drawn
  let area = 0
  for (let i = 0, j = coast.length - 1; i < coast.length; j = i++) area += coast[j].x * coast[i].y - coast[i].x * coast[j].y
  const ring = area >= 0 ? coast : [...coast].reverse()
  for (const offset of CIRCUIT_OFFSETS) {
    const loop = ring.map((q) => {
      const away = new THREE.Vector2(q.x - mid.x, q.y - mid.y).normalize()
      return new THREE.Vector3(q.x + away.x * offset, 0, q.y + away.y * offset)
    })
    let clear = true
    for (let i = 0; i < loop.length && clear; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      for (let k = 0; k <= 4 && clear; k++) clear = free(a.x + ((b.x - a.x) * k) / 4, a.z + ((b.z - a.z) * k) / 4)
    }
    if (!clear) continue
    // a point every couple of units, so the ends can sit right beside the pier
    const dense: THREE.Vector3[] = []
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length]
      const steps = Math.max(1, Math.ceil(a.distanceTo(b) / 2))
      for (let k = 0; k < steps; k++) dense.push(a.clone().lerp(b, k / steps))
    })
    // the ring point nearest the pier, then the run of points within the gap round it is left out
    let nearest = 0
    let nearestD = Infinity
    dense.forEach((q, i) => { const d = distToLine(q, pier.from, pier.to); if (d < nearestD) { nearestD = d; nearest = i } })
    if (nearestD > PIER_GAP) continue // the pier is not near this ring
    const n = dense.length
    let after = nearest
    while (distToLine(dense[after % n], pier.from, pier.to) < PIER_GAP && after < nearest + n) after++
    let before = nearest
    while (distToLine(dense[((before % n) + n) % n], pier.from, pier.to) < PIER_GAP && before > nearest - n) before--
    if (after - before >= n) continue
    const round: THREE.Vector3[] = []
    for (let k = after; k <= before + n; k++) round.push(dense[k % n].clone().setY(0))
    return round
  }
  return null
}
