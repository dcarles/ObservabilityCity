import * as THREE from 'three'

/** What boats must stay clear of: every island's coast (in world x/z) and the bridges between them. */
export interface SeaMap {
  land: THREE.Vector2[][]
  bridges: [THREE.Vector2, THREE.Vector2][]
}

const CELL = 2.5
const LAND_MARGIN = 3.2
const BRIDGE_MARGIN = 4.5

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

/** Finds a sea lane between two points that never touches land or passes under a bridge. Null when there is none. */
export function findLane(map: SeaMap, from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] | null {
  const pts = map.land.flat()
  if (pts.length === 0) return null
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const p of [...pts, new THREE.Vector2(from.x, from.z), new THREE.Vector2(to.x, to.z)]) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.y); maxZ = Math.max(maxZ, p.y)
  }
  minX -= 60; minZ -= 60; maxX += 60; maxZ += 60
  const w = Math.ceil((maxX - minX) / CELL), h = Math.ceil((maxZ - minZ) / CELL)
  const blocked = new Uint8Array(w * h)
  const probe = new THREE.Vector2()
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      probe.set(minX + (i + 0.5) * CELL, minZ + (j + 0.5) * CELL)
      let b = false
      for (const poly of map.land) {
        if (inPolygon(poly, probe.x, probe.y)) { b = true; break }
        for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
          if (distToSegment(probe, poly[m], poly[k]) < LAND_MARGIN) { b = true; break }
        }
        if (b) break
      }
      if (!b) for (const [a, c] of map.bridges) if (distToSegment(probe, a, c) < BRIDGE_MARGIN) { b = true; break }
      blocked[j * w + i] = b ? 1 : 0
    }
  }
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
  const g = new Float32Array(w * h).fill(Infinity)
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
  while (open.length > 0) {
    const cur = pop()
    if (cur === endIdx) break
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
