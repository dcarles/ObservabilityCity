import type { AssetSnapshot, GroupSnapshot, NodeSnapshot } from '../types'
import { makeOutline, type Outline } from './island'
import { hashString } from './random'

// The grid an island's buildings stand on, and the smallest coast that holds it. Pure geometry: no scene objects.

export const SLOT = 7.6 // width of the plot of one building along a pad
export const PAD_W = 3 * SLOT + 0.8 // a service pad holds up to three buildings side by side
export const PAD_D = 8.8
export const CURB = 5.6 // road centre line to the front of a pad: half the road, the service lane where cars wait, and a verge
export const SPINE_CURB = 6.6 // spine centre line to the nearest pad, which leaves room for cars to turn into the service lanes
export const LANE_Z = 3.5 // road centre line to the middle of the service lane
export const QUEUE_GAP = 2.5 // spacing of the cars waiting in a service lane
export const LANE_SLOTS = 5 // cars a service lane holds when it is long enough
export const GAP = 9 // lawn between one row of pads and the road of the next, so the front row never hides the one behind
export const ROW = PAD_D + 2 * CURB + GAP // distance between two rows of pads
export const COL_X = SPINE_CURB + 0.4 + PAD_W / 2 // pad centre from the spine's centre line
export const FRONT = 4.0 // building centre from the front edge of its pad
export const PAD_PITCH = PAD_W + 2 // pad centre to the centre of the next pad along a row road

/** One service pad on the island's grid, with its buildings in a row and their fronts toward the road. */
export interface Pad {
  nodes: NodeSnapshot[]
  /** Which side of the spine the pad is on: 0 the left, 1 the right. */
  col: 0 | 1
  /** How many pads lie between this one and the spine on its side of the row. */
  ring: number
  row: number
  /**
   * The service these systems belong to (as written in the registry), or null for a system that has none: it stands on a pad of its own.
   * The same on every pad of a service that needs more than one.
   */
  service: string | null
  /** Identifies the pad: the island and service for a service (with a part number past the first pad), the system's id for one without. */
  key: string
  /** What the pad's sign says. */
  name: string
}

export interface Placed {
  node: NodeSnapshot
  pad: Pad
  /** Island-local position of the building's centre and of the road in front of it. */
  x: number
  z: number
  roadZ: number
}

/** A resource that stands as a basic building, and where: behind the pad of its service, or in the back yard of the island when it belongs to no pad. */
export interface PlacedAsset {
  asset: AssetSnapshot
  /** Island-local centre. */
  x: number
  z: number
  /** The pad it stands behind, null in the back yard. */
  pad: Pad | null
}

export interface Plan {
  pads: Pad[]
  placed: Placed[]
  assets: PlacedAsset[]
  rows: number
  rowRoadZ: number[]
  rx: number
  rz: number
}

/** Pads on one row road, one more pair for each step: half on each side of the spine, so always even. */
export const PADS_PER_ROW = [2, 4, 6, 8]

/**
 * A measure of how big a coast the grid needs, to compare ways of setting out the same pads: the squared distance of the grid's corner from the
 * middle of an ellipse of the island's proportions (24 by 20), with the room the gate and the harbour take on the south side.
 */
function coastNeed(pads: number, perRow: number): number {
  const rows = Math.ceil(pads / perRow)
  const halfWidth = COL_X + (perRow / 2 - 1) * PAD_PITCH + PAD_W / 2 + 0.4
  const halfDepth = ((rows - 1) * ROW + 2 * CURB + PAD_D) / 2 + 5
  return (halfWidth / 24) ** 2 + (halfDepth / 20) ** 2
}

/**
 * How many pads stand on a row road, half on each side of the spine, so always even. An island takes whichever of 2, 4, 6 or 8 a row needs the
 * smallest coast for its pads (the fewer on a tie), so a bigger island grows in both directions and stays about as wide as it is deep, instead of a
 * long thin strip on a coast far wider than it.
 */
export function padsPerRow(pads: number): number {
  let best = PADS_PER_ROW[0]
  for (const n of PADS_PER_ROW) if (coastNeed(pads, n) < coastNeed(pads, best) - 1e-9) best = n
  return best
}

/** Island-local x of a pad's centre. */
export function padX(pad: { col: 0 | 1; ring: number }): number {
  return (pad.col === 0 ? -1 : 1) * (COL_X + pad.ring * PAD_PITCH)
}

/** Distance from the spine where a pad's service lane starts: the lane of the first pad begins beside the spine, the others at their own pad. */
export function laneStart(pad: { col: 0 | 1; ring: number }): number {
  return pad.ring === 0 ? 5 : Math.abs(padX(pad)) - PAD_W / 2 - 0.4
}

/** "fraud-cases" becomes "Fraud cases": the way a service is named on its pad's sign. */
export function serviceName(service: string): string {
  const words = service.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Pads for an island's systems. Every service is one pad (an API, its worker and its database side by side), wherever its systems stand in the
 * registry file, in the order the services first appear. A service of more than three systems takes more pads, each named for it. A system
 * with no service stands on a pad of its own. Pads fill a grid of `padsPerRow` pads a row, nearest the spine first and alternating sides.
 */
export function planPads(nodes: NodeSnapshot[], groupId = '', perRowOverride?: number): Pad[] {
  const order: { service: string | null; nodes: NodeSnapshot[] }[] = []
  const byService = new Map<string, { service: string | null; nodes: NodeSnapshot[] }>()
  for (const n of nodes) {
    if (!n.service) {
      order.push({ service: null, nodes: [n] })
      continue
    }
    let entry = byService.get(n.service)
    if (!entry) {
      entry = { service: n.service, nodes: [] }
      byService.set(n.service, entry)
      order.push(entry)
    }
    entry.nodes.push(n)
  }
  const pads: Omit<Pad, 'col' | 'row' | 'ring'>[] = []
  for (const e of order) {
    if (e.service === null) {
      pads.push({ nodes: e.nodes, service: null, key: e.nodes[0].id, name: e.nodes[0].name })
      continue
    }
    const parts = Math.ceil(e.nodes.length / 3)
    for (let part = 0; part < parts; part++)
      pads.push({
        nodes: e.nodes.slice(part * 3, part * 3 + 3), service: e.service,
        key: `${groupId}/${e.service}${part > 0 ? `#${part + 1}` : ''}`,
        name: serviceName(e.service) + (parts > 1 ? ` (${part + 1})` : ''),
      })
  }
  const perRow = perRowOverride ?? padsPerRow(pads.length)
  return pads.map((p, i) => ({ ...p, col: (i % 2) as 0 | 1, ring: Math.floor((i % perRow) / 2), row: Math.floor(i / perRow) }))
}

export const ASSET_PITCH = 3.4 // centre to centre of two resource buildings in a row
export const ASSET_BEHIND = 3.0 // from the back edge of a pad to the centre of a resource building behind it
export const YARD_OFFSET = 5.4 // spine to the first building of the back yard, which keeps clear of a road that may continue along it
const ASSETS_PER_PAD = Math.floor((PAD_W - 1) / ASSET_PITCH)

/**
 * Where the island's resource buildings stand. One that names a service stands in a row behind that service's first pad (as many as fit along it); the rest, and
 * any that do not fit, stand in the back yard beyond the last row, in lines either side of the spine. Pure and ordered by id, so the same snapshot gives the same town.
 */
export function placeAssets(assets: readonly AssetSnapshot[], pads: Pad[], rowRoadZ: number[]): PlacedAsset[] {
  const out: PlacedAsset[] = []
  const yard: AssetSnapshot[] = []
  const behind = new Map<string, number>()
  const sorted = [...assets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const asset of sorted) {
    const pad = asset.service ? pads.find((p) => p.service === asset.service) : undefined
    const used = pad ? behind.get(pad.key) ?? 0 : 0
    if (!pad || used >= ASSETS_PER_PAD) { yard.push(asset); continue }
    behind.set(pad.key, used + 1)
    const x = padX(pad) + (used - (Math.min(ASSETS_PER_PAD, sorted.filter((a) => a.service === asset.service).length) - 1) / 2) * ASSET_PITCH
    out.push({ asset, x, z: rowRoadZ[pad.row] - CURB - PAD_D - ASSET_BEHIND, pad })
  }
  const lastBack = rowRoadZ[rowRoadZ.length - 1] - CURB - PAD_D
  const perLine = 6
  yard.forEach((asset, i) => {
    const line = Math.floor(i / perLine), slot = i % perLine
    const side = slot % 2 === 0 ? -1 : 1
    out.push({ asset, x: side * (YARD_OFFSET + Math.floor(slot / 2) * ASSET_PITCH), z: lastBack - ASSET_BEHIND - 4.4 - line * ASSET_PITCH, pad: null })
  })
  return out
}

export const CLUSTER_PER_ROW = 4 // buildings side by side in one hub cluster
const CLUSTER_SIGN = 4 // room for the cluster's sign in front of its buildings

/** A group of resource buildings on the hub island, with the sign that names it. Coordinates are hub-local. */
export interface HubCluster {
  name: string
  /** The footprint's centre and size. */
  x: number
  z: number
  w: number
  d: number
  /** Where the sign stands, in front of the buildings (toward the hub's centre). */
  signX: number
  signZ: number
  assets: { asset: AssetSnapshot; x: number; z: number }[]
}

/** Footprint of a cluster of `n` buildings. */
export function clusterSize(n: number): { w: number; d: number } {
  const rows = Math.ceil(n / CLUSTER_PER_ROW)
  return { w: Math.min(n, CLUSTER_PER_ROW) * ASSET_PITCH + 1.6, d: rows * ASSET_PITCH + CLUSTER_SIGN }
}

/** Whether two centred rectangles overlap, with `gap` of room between them. */
export function rectsTouch(a: { x: number; z: number; w: number; d: number }, b: { x: number; z: number; w: number; d: number }, gap = 0): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.z - b.z) < (a.d + b.d) / 2 + gap
}

/**
 * Where the hub island's resource buildings stand. Those of one group stand together in a cluster (in rows of `CLUSTER_PER_ROW`, ordered by id) with a sign naming the group.
 * Each cluster is put on the first free place found by sweeping the hub: rings at 55%, 68% and 80% of its half sizes, a step of 15 degrees at a time, starting from a place
 * that differs for each cluster. A place is free when `free` says so (on land, clear of the plaza, roads and main buildings) and no earlier cluster is there.
 * Pure and ordered by group then id, so the same snapshot gives the same hub. A cluster that fits nowhere is left out and named in `left`.
 */
export function placeHubClusters(
  assets: readonly AssetSnapshot[], hubRx: number, hubRz: number, centreZ: number, free: (rect: { x: number; z: number; w: number; d: number }) => boolean,
): { clusters: HubCluster[]; left: string[] } {
  const byGroup = new Map<string, AssetSnapshot[]>()
  for (const a of assets) byGroup.set(a.group ?? '', [...(byGroup.get(a.group ?? '') ?? []), a])
  const names = [...byGroup.keys()].sort()
  const clusters: HubCluster[] = []
  const left: string[] = []
  names.forEach((name, index) => {
    const list = byGroup.get(name)!.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const { w, d } = clusterSize(list.length)
    for (const k of [0.55, 0.68, 0.8]) {
      for (let step = 0; step < 24; step++) {
        const angle = ((index * 7 + step) % 24) * (Math.PI / 12) + Math.PI / 24
        const x = Math.sin(angle) * hubRx * k, z = centreZ - Math.cos(angle) * hubRz * k
        const rect = { x, z, w, d }
        if (!free(rect) || clusters.some((c) => rectsTouch(rect, c, 1))) continue
        const placed = list.map((asset, i) => {
          const row = Math.floor(i / CLUSTER_PER_ROW), inRow = Math.min(CLUSTER_PER_ROW, list.length - row * CLUSTER_PER_ROW)
          return { asset, x: x + ((i % CLUSTER_PER_ROW) - (inRow - 1) / 2) * ASSET_PITCH, z: z - d / 2 + CLUSTER_SIGN + (row + 0.5) * ASSET_PITCH }
        })
        clusters.push({ name, x, z, w, d, signX: x, signZ: z - d / 2 + 1.2, assets: placed })
        return
      }
    }
    left.push(name)
  })
  return { clusters, left }
}

export const HUB_CENTRE_Z = 2 // the plaza's centre sits a little south of the hub's

/** The kinds of system that have a building of their own on the hub, each with a fixed place for its first building. */
export const HUB_KINDS = ['Gateway', 'Broker', 'Egress', 'Database'] as const
export const HUB_PLOT = 12 // the side of a hub building's square plot

/**
 * The fixed places of the first building of each hub kind: on the axes round the plaza, each turned so its door faces the plaza. Hub-local; `f` is the hub's scale.
 * `exit` is the direction (radians clockwise from north, round the plaza) where its street leaves the ring road.
 */
export function hubMainSpots(f: number): Record<string, { x: number; z: number; yaw: number; exit: number }> {
  const CZ = HUB_CENTRE_Z
  return {
    Gateway: { x: 0, z: CZ - 13.5 * f, yaw: 0, exit: 0 },
    Broker: { x: 14.5 * f, z: CZ, yaw: Math.PI / 2, exit: Math.PI / 2 },
    Egress: { x: -14.5 * f, z: CZ, yaw: Math.PI / 2, exit: -Math.PI / 2 },
    Database: { x: 0, z: CZ + 14 * f, yaw: Math.PI, exit: Math.PI },
  }
}

type Rect = { x: number; z: number; w: number; d: number }

/**
 * What stands on the hub island and so keeps a cluster of resource buildings away: the plaza, the road to the gateway, the main buildings that exist (the first of each of
 * Gateway, Broker, Egress and Database, on the axes), a strip along each spoke road, and `also` (the further buildings of a kind and their streets, see `placeHubBuildings`).
 * Hub-local coordinates; `f` is the hub's scale.
 */
export function hubReserved(f: number, kinds: readonly string[], spokeAngles: readonly number[], also: readonly Rect[] = []): Rect[] {
  const CZ = HUB_CENTRE_Z
  const spots = hubMainSpots(f)
  const out: Rect[] = [{ x: 0, z: CZ, w: 20 * f, d: 20 * f }, { x: 0, z: CZ - 15 * f, w: 6, d: 14 }]
  for (const kind of new Set(kinds)) if (spots[kind]) out.push({ x: spots[kind].x, z: spots[kind].z, w: HUB_PLOT, d: HUB_PLOT })
  for (const a of spokeAngles) for (let r = 9 * f; r < 30 * f; r += 3) out.push({ x: Math.sin(a) * r, z: CZ - Math.cos(a) * r, w: 8, d: 8 })
  out.push(...also)
  return out
}

/** Whether a cluster's footprint is a free place on the hub: clear of everything reserved, and with all four corners on land (3 in from the coast). */
export function hubFree(
  geo: { rx: number; rz: number; scale: number }, kinds: readonly string[], spokeAngles: readonly number[], also: readonly Rect[] = [],
): (rect: Rect) => boolean {
  const reserved = hubReserved(geo.scale, kinds, spokeAngles, also)
  const outline = makeOutline(hashString('hub'), geo.rx, geo.rz, 0.05)
  return (rect) => !reserved.some((a) => rectsTouch(rect, a, 0.5)) && [[-1, -1], [1, -1], [-1, 1], [1, 1]].every(([sx, sz]) => outline.contains(rect.x + (sx! * rect.w) / 2, rect.z + (sz! * rect.d) / 2, 3))
}

/** The benches on the plaza, as x, z and how each is turned. Hub-local; `f` is the hub's scale. */
export function hubBenches(f: number): [number, number, number][] {
  const CZ = HUB_CENTRE_Z
  return [[-6.0 * f, CZ - 8.2 * f, 0.6], [6.0 * f, CZ + 7.6 * f, 3.6], [-9.4 * f, CZ + 6.2 * f, 1.3]]
}

/** Where one hub system's building stands. Hub-local coordinates. */
export interface HubSlot {
  id: string
  kind: string
  x: number
  z: number
  /** The first building of its kind, on its fixed place (`hubMainSpots`); a further one of the kind stands wherever the hub has room. */
  main: boolean
  /** How a main building is turned; null for a further one, which is turned so its door faces `front`. */
  yaw: number | null
  /** Direction round the plaza (radians clockwise from north) where the building's street leaves the ring road: for one beside a spoke road, that spoke's. */
  exit: number
  /** For a further building: where its street meets a road (the ring road's edge, or the edge of the spoke road beside it), which its door faces. Null for a main one. */
  front: { x: number; z: number } | null
  /** How big the building is drawn: 1, or `HUB_COMPACT` for a further one beside a spoke road, whose plot is that much smaller (`HUB_PLOT * scale` a side). */
  scale: number
  /** For a further building: the footprint of its plot and of its street, which nothing else may stand on. Empty for a main one. */
  reserved: Rect[]
}

/** A further building that stands beside a spoke road is drawn this much smaller than the first of its kind, on a plot as much smaller: every hub model's footprint fits it turned any way. */
export const HUB_COMPACT = 0.8
const SPOKE_HALF = 3 // half a spoke road's width with its curbs
const ROAD_EDGE = 2.1 // half a spoke road's width without them, where a street off it starts

/**
 * How far a hub building of a kind reaches behind its centre, away from its door, at full size, and how wide that part is: the broker stands at the head of a jetty, in every
 * theme, that is longer than its plot.
 */
const HUB_JETTY: Record<string, { reach: number; width: number }> = { Broker: { reach: 14.8, width: 6.6 } }

/** The ground a further building's jetty takes (none for a kind without one), from the edge of its plot out to its end, away from its door along (`ax`, `az`). */
function jettyOf(kind: string, x: number, z: number, ax: number, az: number, scale: number): Rect[] {
  const j = HUB_JETTY[kind]
  if (!j) return []
  const w = j.width * scale
  const out: Rect[] = []
  for (let r = (HUB_PLOT * scale) / 2; r < j.reach * scale; r += w / 2) {
    const t = Math.min(r + w / 2, j.reach * scale - w / 2)
    out.push({ x: x + ax * t, z: z + az * t, w, d: w })
  }
  return out
}

const segmentDistance = (px: number, pz: number, ax: number, az: number, bx: number, bz: number) => {
  const dx = bx - ax, dz = bz - az
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)))
  return Math.hypot(px - ax - t * dx, pz - az - t * dz)
}

/**
 * Where the hub's own buildings stand. The first of each kind takes its fixed place on the axes, exactly as a hub with one of each always had. Every further one of a kind
 * (a second broker, a second gateway) is its own building, nearest the first of its kind where there is room:
 * - first on a free place from rings at 55%, 68% and 80% of the hub's half sizes a step of 15 degrees apart, where its plot and its straight street from the ring road keep
 *   clear of the plaza, the main buildings, the spoke roads and the buildings already placed;
 * - else, a little smaller (`HUB_COMPACT`), at the side of a spoke road with its door to the road, clear of the ring road, the lamps and benches, the main buildings and their
 *   streets, every spoke road and the buildings already placed. A hub with many spokes has no room left between them for a street of its own from the ring road, but the
 *   pockets beside the spoke roads next to each main building, toward the coast, hold a building each.
 * A system of a kind the hub has no place for is in `skipped`; one that finds no room is in `left`, and the hub grows until `left` is empty (see layoutWithHubRoom).
 * Pure and in the hub's order, so the same snapshot gives the same hub.
 */
export function placeHubBuildings(
  nodes: readonly { id: string; kind: string }[], geo: { rx: number; rz: number; scale: number; ringR: number }, spokeAngles: readonly number[],
): { slots: HubSlot[]; left: string[]; skipped: string[]; reserved: Rect[] } {
  const f = geo.scale
  const CZ = HUB_CENTRE_Z
  const mains = hubMainSpots(f)
  const slots: HubSlot[] = []
  const left: string[] = []
  const skipped: string[] = []
  const extras: { id: string; kind: string }[] = []
  const seen = new Set<string>()
  for (const n of nodes) {
    const spot = mains[n.kind]
    if (!spot) { skipped.push(n.id); continue }
    if (seen.has(n.kind)) { extras.push(n); continue }
    seen.add(n.kind)
    slots.push({ id: n.id, kind: n.kind, x: spot.x, z: spot.z, main: true, yaw: spot.yaw, exit: spot.exit, front: null, scale: 1, reserved: [] })
  }
  if (extras.length === 0) return { slots, left, skipped, reserved: [] }
  const kinds = [...seen]
  const reserved: Rect[] = []
  // the plaza is left out of what a street must clear: every street starts on the ring road inside it
  const mainsAndSpokes = hubReserved(f, kinds, spokeAngles).slice(1)
  const onLand = hubFree(geo, kinds, spokeAngles)
  const candidates: { x: number; z: number; angle: number }[] = []
  for (const k of [0.55, 0.68, 0.8]) for (let step = 0; step < 24; step++) {
    const angle = wrap(step * (Math.PI / 12))
    candidates.push({ x: Math.sin(angle) * geo.rx * k, z: CZ - Math.cos(angle) * geo.rz * k, angle })
  }
  const ringEdge = geo.ringR + 2.1
  const outline = makeOutline(hashString('hub'), geo.rx, geo.rz, 0.05)
  const roadside = new Map<string, ReturnType<typeof roadsidePlaces>>()
  for (const n of extras) {
    const near = mains[n.kind]
    const order = candidates.map((c, i) => ({ c, i, d: Math.hypot(c.x - near.x, c.z - near.z) })).sort((a, b) => a.d - b.d || a.i - b.i)
    let placed: HubSlot | null = null
    for (const { c } of order) {
      const plot = { x: c.x, z: c.z, w: HUB_PLOT, d: HUB_PLOT }
      if (!onLand(plot) || reserved.some((r) => rectsTouch(plot, r, 0.5))) continue
      // the street: from the ring road straight out to the front of the plot
      const dist = Math.hypot(c.x, c.z - CZ)
      const street: Rect[] = []
      for (let r = ringEdge; r < dist - HUB_PLOT / 2; r += 2.5) street.push({ x: Math.sin(c.angle) * r, z: CZ - Math.cos(c.angle) * r, w: 4, d: 4 })
      if (street.some((s) => mainsAndSpokes.some((r) => rectsTouch(s, r, 0.3)) || reserved.some((r) => rectsTouch(s, r, 0.3)))) continue
      // a jetty runs out behind it, away from the plaza
      const jetty = jettyOf(n.kind, c.x, c.z, (c.x) / dist, (c.z - CZ) / dist, 1)
      if (jetty.some((s) => !outline.contains(s.x, s.z, 1 + s.w / 2) || mainsAndSpokes.some((r) => rectsTouch(s, r, 0.3)) || reserved.some((r) => rectsTouch(s, r, 0.3)))) continue
      const front = { x: Math.sin(c.angle) * ringEdge, z: CZ - Math.cos(c.angle) * ringEdge }
      placed = { id: n.id, kind: n.kind, x: c.x, z: c.z, main: false, yaw: null, exit: c.angle, front, scale: 1, reserved: [plot, ...street, ...jetty] }
      break
    }
    if (!placed) {
      if (!roadside.has(n.kind)) roadside.set(n.kind, roadsidePlaces(n.kind, f, geo, kinds, spokeAngles))
      const byNear = roadside.get(n.kind)!.map((c, i) => ({ c, i, d: Math.hypot(c.x - near.x, c.z - near.z) })).sort((a, b) => a.d - b.d || a.i - b.i)
      const hit = byNear.find(({ c }) => !c.reserved.some((a) => reserved.some((r) => rectsTouch(a, r, 0.5))))
      if (hit) placed = { id: n.id, kind: n.kind, x: hit.c.x, z: hit.c.z, main: false, yaw: null, exit: hit.c.exit, front: hit.c.front, scale: HUB_COMPACT, reserved: hit.c.reserved }
    }
    if (!placed) { left.push(n.id); continue }
    slots.push(placed)
    reserved.push(...placed.reserved)
  }
  return { slots, left, skipped, reserved }
}

/**
 * The places beside the spoke roads where a further hub building can stand (see placeHubBuildings), before the other further buildings are taken into account: a compact plot
 * on either side of each spoke road, every 2 along it, its edge half a unit from the curb, on land 3 in from the coast, and clear of the ring road and its lamps, the benches,
 * the main buildings (and the first broker's jetty) and their streets and every other spoke road; a broker's jetty, behind it, as well. Each comes with the spoke it stands on,
 * the point on the road's edge in front of its door, and its footprint, its short drive to the road and its jetty, which nothing else may stand on.
 */
function roadsidePlaces(
  kind: string, f: number, geo: { rx: number; rz: number; ringR: number }, kinds: readonly string[], spokeAngles: readonly number[],
): { x: number; z: number; exit: number; front: { x: number; z: number }; reserved: Rect[] }[] {
  const CZ = HUB_CENTRE_Z
  const plot = HUB_PLOT * HUB_COMPACT
  const half = plot / 2
  const off = SPOKE_HALF + 0.5 + half
  const spots = hubMainSpots(f)
  const mains = [...new Set(kinds)].filter((k) => spots[k]).map((k) => spots[k])
  const rects: Rect[] = [
    ...mains.map((m) => ({ x: m.x, z: m.z, w: HUB_PLOT, d: HUB_PLOT })),
    { x: 0, z: CZ - 15 * f, w: 6, d: 14 },
    ...hubBenches(f).map(([x, z]) => ({ x, z, w: 3, d: 3 })),
    // the first broker's jetty runs out east behind it (its door faces the plaza)
    ...(spots.Broker && kinds.includes('Broker') ? [{ x: spots.Broker.x + (HUB_PLOT / 2 + HUB_JETTY.Broker.reach) / 2, z: spots.Broker.z, w: HUB_JETTY.Broker.reach - HUB_PLOT / 2, d: HUB_JETTY.Broker.width }] : []),
  ]
  // the ring road with its lamps, the streets to the main buildings, and the spoke roads (as far as the coast and beyond)
  const plaza = geo.ringR + 4
  const far = 2 * Math.max(geo.rx, geo.rz)
  const lines = [
    ...mains.map((m) => ({ ax: 0, az: CZ, bx: m.x, bz: m.z, clear: 3 + 0.5 + half })),
    ...spokeAngles.map((a) => ({ ax: Math.sin(a) * geo.ringR, az: CZ - Math.cos(a) * geo.ringR, bx: Math.sin(a) * far, bz: CZ - Math.cos(a) * far, clear: off - 1e-6 })),
  ]
  const outline = makeOutline(hashString('hub'), geo.rx, geo.rz, 0.05)
  const out: { x: number; z: number; exit: number; front: { x: number; z: number }; reserved: Rect[] }[] = []
  for (const a of spokeAngles) {
    const dx = Math.sin(a), dz = -Math.cos(a)
    for (const side of [-1, 1]) {
      // the normal to the road, toward this side
      const nx = -dz * side, nz = dx * side
      for (let t = geo.ringR + 2.1 + half; t < Math.max(geo.rx, geo.rz); t += 2) {
        const x = dx * t + nx * off, z = CZ + dz * t + nz * off
        if (Math.hypot(x, z - CZ) < plaza + half) continue
        if (lines.some((l) => segmentDistance(x, z, l.ax, l.az, l.bx, l.bz) < l.clear)) continue
        const own = { x, z, w: plot, d: plot }
        if (rects.some((r) => rectsTouch(own, r, 0.5))) continue
        if (![[-1, -1], [1, -1], [-1, 1], [1, 1]].every(([sx, sz]) => outline.contains(x + sx! * half, z + sz! * half, 3))) continue
        // a jetty runs out behind it, away from the road
        const jetty = jettyOf(kind, x, z, nx, nz, HUB_COMPACT)
        const jettyClear = (s: Rect) => outline.contains(s.x, s.z, 1 + s.w / 2) && !rects.some((r) => rectsTouch(s, r, 0.5)) && !lines.some((l) => segmentDistance(s.x, s.z, l.ax, l.az, l.bx, l.bz) < l.clear - half + (s.w / 2) * Math.SQRT2)
        if (!jetty.every(jettyClear)) continue
        // its drive: from the curb to the plot
        const drive = { x: dx * t + nx * (SPOKE_HALF + 0.5), z: CZ + dz * t + nz * (SPOKE_HALF + 0.5), w: 4, d: 4 }
        out.push({ x, z, exit: a, front: { x: dx * t + nx * ROAD_EDGE, z: CZ + dz * t + nz * ROAD_EDGE }, reserved: [own, drive, ...jetty] })
      }
    }
  }
  return out
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** Distance from the spine to the outer edge of the outermost pad, which is as far as the row roads reach. */
export function rowEdge(pads: { ring: number }[]): number {
  return COL_X + Math.max(0, ...pads.map((p) => p.ring)) * PAD_PITCH + PAD_W / 2 + 0.4
}

/** Lays out one island's grid and finds the smallest coast that holds it, with room for the gate and the harbour. */
export function planIsland(g: GroupSnapshot, perRow?: number): Plan {
  const pads = planPads(g.nodes, g.id, perRow)
  const rows = Math.max(1, Math.ceil(pads.length / (perRow ?? padsPerRow(pads.length))))
  const span = (rows - 1) * ROW + 2 * CURB + PAD_D
  const roadZ0 = span / 2 - CURB
  const rowRoadZ = Array.from({ length: rows }, (_, r) => roadZ0 - r * ROW)
  const placed: Placed[] = []
  for (const pad of pads) {
    const roadZ = rowRoadZ[pad.row]
    const cx = padX(pad)
    pad.nodes.forEach((node, i) => placed.push({ node, pad, x: cx + (i - (pad.nodes.length - 1) / 2) * SLOT, z: roadZ - CURB - FRONT, roadZ }))
  }
  const assets = placeAssets(g.assets ?? [], pads, rowRoadZ)
  const edge = rowEdge(pads)
  const southZ = roadZ0 + CURB
  const northZ = rowRoadZ[rows - 1] - CURB - PAD_D
  const harbourZ = rowRoadZ[Math.floor((rows - 1) / 2)]
  const check: [number, number][] = [[-edge, southZ], [edge, southZ], [-edge, northZ], [edge, northZ], [-edge - 2, harbourZ], [0, northZ - 4]]
  // every resource building, with room round it, must stand on land
  for (const a of assets) check.push([a.x - 1.6, a.z - 1.6], [a.x + 1.6, a.z - 1.6])
  let k = 1
  let rx = 24, rz = 20
  for (let i = 0; i < 200; i++) {
    rx = 24 * k
    rz = 20 * k
    const o = makeOutline(hashString(g.id), rx, rz, 0.06)
    if (check.every(([x, z]) => o.contains(x, z, 2)) && coastScan(o, 'z') - 0.6 - southZ >= 9 && DOCK_FOOTPRINT_X.every((x) => coastScanZ(o, x) - DOCK_DEPTH - southZ >= 0)) break
    k *= 1.02
  }
  return { pads, placed, assets, rows, rowRoadZ, rx, rz }
}

/**
 * The island's harbour stands on its hub-facing coast beside the gate, so its pier runs straight out parallel to the bridge: the pier is at this island-local x (the
 * bridge is at 0), on the side where the pen of dead letters faces the bridge. The boats that carry the island's messages to and from the hub sail the line the pier points along.
 */
export const DOCK_X = -11.5
/** How far the harbour reaches inland from the coast (the quay, the pier house), and the island-local x range it covers: the coast must leave that much dry land in front of the first road. */
export const DOCK_DEPTH = 9.6
export const DOCK_FOOTPRINT_X = [DOCK_X - 4.8, DOCK_X, DOCK_X + 7.8]

/** Island-local coast: the far +z edge at x=0 (for 'z'), the far -z edge at x=0 as a distance (for '-z'), or the +x edge at the given z (for 'x'). */
export function coastScan(outline: Outline, axis: 'z' | '-z' | 'x', at = 0): number {
  let lo = 0, hi = 600
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    const inside = axis === 'z' ? outline.contains(0, mid) : axis === '-z' ? outline.contains(0, -mid) : outline.contains(mid, at)
    if (inside) lo = mid
    else hi = mid
  }
  return lo
}

/** The +z coast of an island at a given island-local x. */
export function coastScanZ(outline: Outline, x: number): number {
  let lo = 0, hi = 600
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (outline.contains(x, mid)) lo = mid
    else hi = mid
  }
  return lo
}
