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

/**
 * What stands on the hub island and so keeps a cluster of resource buildings away: the plaza, the road to the gateway, the main buildings that exist (one each of
 * Gateway, Broker, Egress and Database, on the axes) and a strip along each spoke road. Hub-local coordinates; `f` is the hub's scale.
 */
export function hubReserved(f: number, kinds: readonly string[], spokeAngles: readonly number[]): { x: number; z: number; w: number; d: number }[] {
  const CZ = HUB_CENTRE_Z
  const spots: Record<string, { x: number; z: number }> = { Gateway: { x: 0, z: CZ - 13.5 * f }, Broker: { x: 14.5 * f, z: CZ }, Egress: { x: -14.5 * f, z: CZ }, Database: { x: 0, z: CZ + 14 * f } }
  const out = [{ x: 0, z: CZ, w: 20 * f, d: 20 * f }, { x: 0, z: CZ - 15 * f, w: 6, d: 14 }]
  for (const kind of new Set(kinds)) if (spots[kind]) out.push({ ...spots[kind], w: 12, d: 12 })
  for (const a of spokeAngles) for (let r = 9 * f; r < 30 * f; r += 3) out.push({ x: Math.sin(a) * r, z: CZ - Math.cos(a) * r, w: 8, d: 8 })
  return out
}

/** Whether a cluster's footprint is a free place on the hub: clear of everything reserved, and with all four corners on land (3 in from the coast). */
export function hubFree(geo: { rx: number; rz: number; scale: number }, kinds: readonly string[], spokeAngles: readonly number[]): (rect: { x: number; z: number; w: number; d: number }) => boolean {
  const reserved = hubReserved(geo.scale, kinds, spokeAngles)
  const outline = makeOutline(hashString('hub'), geo.rx, geo.rz, 0.05)
  return (rect) => !reserved.some((a) => rectsTouch(rect, a, 0.5)) && [[-1, -1], [1, -1], [-1, 1], [1, 1]].every(([sx, sz]) => outline.contains(rect.x + (sx! * rect.w) / 2, rect.z + (sz! * rect.d) / 2, 3))
}

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
  const check: [number, number][] = [[-edge, southZ], [edge, southZ], [-edge, northZ], [edge, northZ], [edge + 11, harbourZ], [-edge - 2, harbourZ], [0, northZ - 4]]
  // every resource building, with room round it, must stand on land
  for (const a of assets) check.push([a.x - 1.6, a.z - 1.6], [a.x + 1.6, a.z - 1.6])
  let k = 1
  let rx = 24, rz = 20
  for (let i = 0; i < 200; i++) {
    rx = 24 * k
    rz = 20 * k
    const o = makeOutline(hashString(g.id), rx, rz, 0.06)
    if (check.every(([x, z]) => o.contains(x, z, 2)) && coastScan(o, 'z') - 0.6 - southZ >= 9) break
    k *= 1.02
  }
  return { pads, placed, assets, rows, rowRoadZ, rx, rz }
}

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
