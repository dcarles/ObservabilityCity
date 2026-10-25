/**
 * Where everything stands, worked out from sizes alone so it can be tested without a renderer.
 *
 * The hub is in the middle. Islands stand round it on a ring in registry order. A ring holds RING_CAPACITY islands;
 * any more stand in a second, staggered ring: each one sits in the gap between two islands of the first ring, further
 * out, with its bridge passing between them. The hub grows with the number of islands so every island's spoke road
 * has room where it leaves the hub's coast.
 */

/** Half extents of an island's coast. x runs along the coast (tangential), z points at the hub (radial). */
export interface IslandSize {
  rx: number
  rz: number
}

export interface HubGeometry {
  /** Multiplier on the original hub (1 = the hub of a small town). */
  scale: number
  rx: number
  rz: number
  /** The ring road round the fountain. */
  ringR: number
  /** How far from the plaza's centre the hub's four main buildings stand. */
  buildingR: number
}

export interface IslandPlacement {
  /** Direction from the hub's centre to the island, radians clockwise from north (-z). */
  angle: number
  /** Distance of the island's centre from the hub's centre. */
  radius: number
  /** Direction the island's spoke road leaves the hub's plaza. Equals angle unless the spoke had to dodge a hub building. */
  portAngle: number
  ring: 1 | 2
}

export interface TownLayout {
  hub: HubGeometry
  islands: IslandPlacement[]
}

export const RING_CAPACITY = 12

const BASE_HUB_RX = 22
const BASE_HUB_RZ = 21
const BASE_RING_R = 5.7
const BASE_BUILDING_R = 14.5
const BUILDING_HALF = 6 // half the width of a hub building's plot
const ROAD_CLEARANCE = 3.4 // room kept between a spoke road and a hub building
const MIN_COAST_SPACING = 9.6 // spoke roads must be at least this far apart where they meet the hub's coast
const ISLAND_GAP = 12 // open sea kept between two neighbouring islands
const BRIDGE_CLEARANCE = 10 // open sea kept between a passing bridge and an island's coast
const SEA_LANE = 22 // between the hub's coast and the nearest island, for the quays and the sea lane

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
const HUB_AXES = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]

/** The angle either side of a hub building's axis that a spoke road must stay out of. */
function keepClear(buildingR: number): number {
  return Math.asin(Math.min(0.95, (BUILDING_HALF + ROAD_CLEARANCE) / buildingR))
}

/** The smallest hub that gives `n` spoke roads room: they share the arc the four hub buildings leave free. */
export function hubGeometry(n: number): HubGeometry {
  let scale = 1.25 // always room for the extra shared resources a town can have
  for (; scale < 3.5; scale += 0.05) {
    const free = 2 * Math.PI - 8 * keepClear(BASE_BUILDING_R * scale)
    if ((free * BASE_HUB_RX * scale * 0.9) / Math.max(1, n) >= MIN_COAST_SPACING) break
  }
  return {
    scale,
    rx: BASE_HUB_RX * scale,
    rz: BASE_HUB_RZ * scale,
    ringR: BASE_RING_R * scale,
    buildingR: BASE_BUILDING_R * scale,
  }
}

/**
 * Spoke roads cannot start where a hub building stands, so they share the arcs between the four buildings' axes. Each road gets
 * an even share of that free arc and keeps the order of its island, turned to the offset that slants the bridges least.
 */
function spokeAngles(islandAngles: number[], clear: number): number[] {
  const n = islandAngles.length
  const arc = Math.PI / 2 - 2 * clear // one free arc between two axes
  const total = 4 * arc
  // u runs along the free arcs end to end, starting where the first arc begins
  const toAngle = (u: number) => {
    const k = Math.min(3, Math.floor(u / arc))
    return norm(HUB_AXES[k] + clear + (u - k * arc))
  }
  const order = islandAngles.map((angle, index) => ({ angle, index })).sort((x, y) => norm(x.angle) - norm(y.angle))
  let best: number[] = islandAngles.slice()
  let bestCost = Infinity
  for (let shift = 0; shift < n; shift++) {
    for (let d = 0; d < 1; d += 0.05) {
      const ports = new Array<number>(n)
      let cost = 0
      for (let k = 0; k < n; k++) {
        const island = order[(k + shift) % n]
        ports[island.index] = toAngle(((k + d) * total) / n)
        cost += Math.abs(wrapAngle(ports[island.index] - island.angle))
      }
      if (cost < bestCost - 1e-9) { bestCost = cost; best = ports }
    }
  }
  return best
}

/** Even angles for the first ring and the midpoints for the second. */
function angles(n: number): { angle: number; ring: 1 | 2 }[] {
  const first = Math.min(n, RING_CAPACITY)
  const second = n - first
  const step = (Math.PI * 2) / first
  // start at the angle that suits the hub's four axes: islands then sit between them
  const start = first > 1 ? step / 2 : Math.PI / 4
  const out: { angle: number; ring: 1 | 2 }[] = Array.from({ length: first }, (_, i) => ({ angle: start + i * step, ring: 1 }))
  for (let k = 0; k < second; k++) {
    const gap = Math.floor(((k + 0.5) * first) / second) // spread over the gaps of the first ring
    out.push({ angle: out[gap].angle + step / 2, ring: 2 })
  }
  return out
}

export function layoutTown(sizes: IslandSize[]): TownLayout {
  const n = sizes.length
  const hub = hubGeometry(n)
  if (n === 0) return { hub, islands: [] }

  const placed = angles(n)
  const ports = spokeAngles(placed.map((p) => p.angle), keepClear(hub.buildingR))
  const spots = placed.map((p, i) => ({ ...p, port: ports[i] }))
  const first = Math.min(n, RING_CAPACITY)
  const second = n - first
  const rho = (s: IslandSize) => Math.max(s.rx, s.rz) * 0.95 + 3 // a round stand-in for an island, for spacing
  const centre = (angle: number, r: number) => ({ x: Math.sin(angle) * r, z: -Math.cos(angle) * r })

  // first ring: far enough out that the nearest coast clears the sea lane, and neighbours do not touch
  let r1 = hub.rz + SEA_LANE + Math.max(...sizes.slice(0, first).map((s) => s.rz))
  const step = (Math.PI * 2) / first
  const twoRings = second > 0
  const hasBridgeBetween = new Set<number>() // gaps of the first ring that a second-ring bridge passes through
  for (let k = 0; k < second; k++) hasBridgeBetween.add(Math.floor(((k + 0.5) * first) / second))
  if (first > 1) {
    for (let i = 0; i < first; i++) {
      const j = (i + 1) % first
      r1 = Math.max(r1, (sizes[i].rx + sizes[j].rx + ISLAND_GAP) / (2 * Math.sin(step / 2)))
      if (twoRings && hasBridgeBetween.has(i))
        r1 = Math.max(r1, (Math.max(sizes[i].rx, sizes[j].rx) + BRIDGE_CLEARANCE) / Math.sin(step / 2))
    }
  }

  const radii: number[] = Array.from({ length: n }, (_, i) => (i < first ? r1 : 0))
  // second ring: out until it clears the first ring and its own neighbours
  const outer = spots.slice(first).map((s, k) => ({ ...s, size: sizes[first + k], index: first + k }))
  let r2 = r1 + 10
  for (let guard = 0; twoRings && guard < 600; guard++, r2 += 2) {
    const clear = outer.every((o) => {
      const c = centre(o.angle, r2)
      const awayFromFirst = spots.slice(0, first).every((s, j) => {
        const p = centre(s.angle, r1)
        return Math.hypot(c.x - p.x, c.z - p.z) >= rho(o.size) + rho(sizes[j]) + ISLAND_GAP
      })
      const awayFromEachOther = outer.every((q) => {
        if (q === o) return true
        const p = centre(q.angle, r2)
        return Math.hypot(c.x - p.x, c.z - p.z) >= rho(o.size) + rho(q.size) + ISLAND_GAP
      })
      return awayFromFirst && awayFromEachOther
    })
    if (clear) break
  }
  for (const o of outer) radii[o.index] = r2

  return {
    hub,
    islands: spots.map((s, i) => ({ angle: s.angle, radius: radii[i], portAngle: s.port, ring: s.ring })),
  }
}
