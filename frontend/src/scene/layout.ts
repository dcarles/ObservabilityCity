/**
 * Where everything stands, worked out from sizes alone so it can be tested without a renderer.
 *
 * The hub is in the middle. Islands stand round it on a ring in registry order. A ring holds `capacity` islands (layout.yaml
 * ringCapacity, 6 to 18); any more stand in a second, staggered ring: each one sits in the gap between two islands of the
 * first ring, further out, with its bridge passing between them. The airport takes the second ring's northernmost place, so a
 * town holds at most 2 x capacity - 1 pillars, and it gets a spoke to the hub like any island. There is no third ring: its
 * bridges would have nowhere to pass. The hub grows with the number of spokes so every road has room where it leaves the hub's coast.
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
  /** The airport's place in the second ring, due north. Null when the town has none. */
  airport: IslandPlacement | null
}

export const DEFAULT_RING_CAPACITY = 12
export const MIN_RING_CAPACITY = 6
export const MAX_RING_CAPACITY = 18
/** Most pillars a town holds on two rings of `capacity`: the airport takes one place in the second. */
export const maxPillars = (capacity: number) => 2 * capacity - 1

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

/**
 * Even angles for the first ring and the gap midpoints for the second. The gap that faces north is kept for the airport, so the
 * second ring's islands spread over the other gaps. The airport, when there is one, is last.
 */
function angles(n: number, capacity: number, airport: boolean): { angle: number; ring: 1 | 2 }[] {
  const first = Math.min(n, capacity)
  const second = n - first
  const step = (Math.PI * 2) / first
  // start at the angle that suits the hub's four axes: islands then sit between them
  const start = first > 1 ? step / 2 : Math.PI / 4
  const out: { angle: number; ring: 1 | 2 }[] = Array.from({ length: first }, (_, i) => ({ angle: start + i * step, ring: 1 }))
  for (let k = 0; k < second; k++) {
    const gap = secondRingGap(k, first, second)
    out.push({ angle: out[gap].angle + step / 2, ring: 2 })
  }
  if (airport) out.push({ angle: 0, ring: 2 })
  return out
}

/** The gap of the first ring (between islands `gap` and `gap + 1`) that the k-th second-ring island stands in. The north gap, the last one, is the airport's. */
function secondRingGap(k: number, first: number, second: number): number {
  return Math.floor(((k + 0.5) * (first - 1)) / second)
}

export function layoutTown(sizes: IslandSize[], capacity = DEFAULT_RING_CAPACITY, airportSize: IslandSize | null = null): TownLayout {
  const pillars = sizes.length
  const hasAirport = airportSize !== null
  if (capacity < MIN_RING_CAPACITY || capacity > MAX_RING_CAPACITY) throw new Error(`ring capacity ${capacity} is outside ${MIN_RING_CAPACITY} to ${MAX_RING_CAPACITY}`)
  if (pillars > maxPillars(capacity)) throw new Error(`${pillars} pillars do not fit on two rings of ${capacity} (at most ${maxPillars(capacity)})`)
  const hub = hubGeometry(pillars + (hasAirport ? 1 : 0))
  if (pillars === 0) return { hub, islands: [], airport: null }

  const all = hasAirport ? [...sizes, airportSize] : sizes
  const n = all.length
  const placed = angles(pillars, capacity, hasAirport)
  const ports = spokeAngles(placed.map((p) => p.angle), keepClear(hub.buildingR))
  const spots = placed.map((p, i) => ({ ...p, port: ports[i] }))
  const first = Math.min(pillars, capacity)
  const second = pillars - first
  const rho = (s: IslandSize) => Math.max(s.rx, s.rz) * 0.95 + 3 // a round stand-in for an island, for spacing
  const centre = (angle: number, r: number) => ({ x: Math.sin(angle) * r, z: -Math.cos(angle) * r })

  // first ring: far enough out that the nearest coast clears the sea lane, and neighbours do not touch
  let r1 = hub.rz + SEA_LANE + Math.max(...all.slice(0, first).map((s) => s.rz))
  const step = (Math.PI * 2) / first
  const outerCount = n - first // second-ring islands and the airport
  const hasBridgeBetween = new Set<number>() // gaps of the first ring that an outer bridge passes through
  for (let k = 0; k < second; k++) hasBridgeBetween.add(secondRingGap(k, first, second))
  if (hasAirport && first > 1) hasBridgeBetween.add(first - 1)
  if (first > 1) {
    for (let i = 0; i < first; i++) {
      const j = (i + 1) % first
      r1 = Math.max(r1, (all[i].rx + all[j].rx + ISLAND_GAP) / (2 * Math.sin(step / 2)))
      if (outerCount > 0 && hasBridgeBetween.has(i))
        r1 = Math.max(r1, (Math.max(all[i].rx, all[j].rx) + BRIDGE_CLEARANCE) / Math.sin(step / 2))
    }
  }

  const radii: number[] = Array.from({ length: n }, (_, i) => (i < first ? r1 : 0))
  // second ring: out until it clears the first ring and its own neighbours
  const outer = spots.slice(first).map((s, k) => ({ ...s, size: all[first + k], index: first + k }))
  let r2 = r1 + 10
  for (let guard = 0; outerCount > 0 && guard < 900; guard++, r2 += 2) {
    const clear = outer.every((o) => {
      const c = centre(o.angle, r2)
      const awayFromFirst = spots.slice(0, first).every((s, j) => {
        const p = centre(s.angle, r1)
        return Math.hypot(c.x - p.x, c.z - p.z) >= rho(o.size) + rho(all[j]) + ISLAND_GAP
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

  const placements = spots.map((s, i) => ({ angle: s.angle, radius: radii[i], portAngle: s.port, ring: s.ring }))
  return { hub, islands: placements.slice(0, pillars), airport: hasAirport ? placements[pillars] : null }
}

// ── the outer ring road and the third parties outside it ──────────────────────────────────────────────

/** A round stand-in for something on the map, for working out where there is room. */
export interface Disc {
  id: string
  x: number
  z: number
  r: number
}

export interface VendorSpec {
  id: string
  /** Directions (radians clockwise from north) of the islands whose systems call this vendor, so it stands on the side most of them are. */
  callerAngles: number[]
  /** Half the depth of the vendor's island, which is how far its gate is from its centre. */
  front: number
}

export interface VendorPlacement {
  id: string
  /** Direction of the vendor from the hub's centre. */
  angle: number
  /** The vendor island's centre. */
  x: number
  z: number
  /** Where its spur leaves the ring road. */
  loopX: number
  loopZ: number
}

/** Sea kept between the outermost coast and the ring road, for the bridges' landings. */
export const LOOP_MARGIN = 40
/** Open water between the ring road and a vendor's gate. */
export const VENDOR_SPUR = 14
const BRIDGE_MARGIN = 7 // a bridge must pass this far (plus the island's radius) from every other island

const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz)
const direction = (a: number) => ({ x: Math.sin(a), z: -Math.cos(a) })

/** Distance from a point to a segment. */
export function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az
  const len2 = dx * dx + dz * dz
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2))
  return dist(px, pz, ax + t * dx, az + t * dz)
}

/** The ring road circles the hub outside every island (and the airport), with room for the bridges' landings. */
export function ringRoadRadius(discs: Disc[]): number {
  return Math.max(0, ...discs.map((d) => Math.hypot(d.x, d.z) + d.r)) + LOOP_MARGIN
}

/**
 * Whether a straight bridge from an island's back gate, directly away from the hub, to the ring road passes clear of every other island.
 * It always does when the rings are staggered evenly; a very wide neighbour in the other ring can block it, and that island then
 * reaches third parties through the dependency overlay alone.
 */
export function backBridgeClear(island: Disc, back: number, others: Disc[], loopR: number): boolean {
  const d = Math.hypot(island.x, island.z) || 1
  const ux = island.x / d, uz = island.z / d
  const ax = island.x + ux * back, az = island.z + uz * back
  const bx = ux * loopR, bz = uz * loopR
  return others.every((o) => o.id === island.id || distanceToSegment(o.x, o.z, ax, az, bx, bz) >= o.r * 0.85 + BRIDGE_MARGIN)
}

/** Direction of the vector sum of some directions: the side they mostly lie on. Null when they cancel out. */
export function meanDirection(angles: number[]): number | null {
  const x = angles.reduce((a, t) => a + Math.sin(t), 0), z = angles.reduce((a, t) => a - Math.cos(t), 0)
  return Math.hypot(x, z) < 1e-6 ? null : Math.atan2(x, -z)
}

/**
 * Third parties stand outside the ring road, each on a short spur. The places are spread evenly round the loop, and each vendor takes the
 * free place nearest the side most of its callers are on, so the busiest links are the shortest drives. Pure geometry, tested without a renderer.
 */
export function placeVendorsOnRing(loopR: number, vendors: VendorSpec[]): VendorPlacement[] {
  const n = vendors.length
  if (n === 0) return []
  const offset = Math.PI / n // keeps the first place off due north, where the airport stands inside the loop
  const slots = Array.from({ length: n }, (_, i) => wrapAngle(offset + (i * 2 * Math.PI) / n))
  const free = new Set(slots.keys())
  const out = new Map<string, VendorPlacement>()
  // vendors with the most decisive preference choose first
  const wanted = vendors.map((v) => ({ v, want: meanDirection(v.callerAngles) })).sort((a, b) => Number(b.want !== null) - Number(a.want !== null))
  for (const { v, want } of wanted) {
    let best = -1
    for (const k of free) if (best < 0 || (want !== null ? Math.abs(wrapAngle(slots[k] - want)) < Math.abs(wrapAngle(slots[best] - want)) : k < best)) best = k
    free.delete(best)
    const angle = slots[best]
    const d = direction(angle)
    const centre = loopR + VENDOR_SPUR + v.front
    out.set(v.id, { id: v.id, angle, x: d.x * centre, z: d.z * centre, loopX: d.x * loopR, loopZ: d.z * loopR })
  }
  return vendors.map((v) => out.get(v.id)!)
}

/** Points round the ring road from one direction to another, the short way. */
export function loopArc(loopR: number, from: number, to: number, y = 0, maxStep = 0.06): { x: number; y: number; z: number }[] {
  const delta = wrapAngle(to - from)
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / maxStep))
  return Array.from({ length: steps + 1 }, (_, i) => {
    const d = direction(from + (delta * i) / steps)
    return { x: d.x * loopR, y, z: d.z * loopR }
  })
}
