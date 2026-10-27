import type { GroupSnapshot, NodeSnapshot } from '../types'
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

export interface Plan {
  pads: Pad[]
  placed: Placed[]
  rows: number
  rowRoadZ: number[]
  rx: number
  rz: number
}

/**
 * Pads on one row road, half on each side of the spine, so always even. Small islands keep their two (one each side); a bigger one gets a wider
 * row so that it grows in both directions and stays about as wide as it is deep, instead of a long thin strip on a wide coast.
 */
export function padsPerRow(pads: number): number {
  return pads <= 10 ? 2 : pads <= 24 ? 4 : 6
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
export function planPads(nodes: NodeSnapshot[], groupId = ''): Pad[] {
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
  const perRow = padsPerRow(pads.length)
  return pads.map((p, i) => ({ ...p, col: (i % 2) as 0 | 1, ring: Math.floor((i % perRow) / 2), row: Math.floor(i / perRow) }))
}

/** Distance from the spine to the outer edge of the outermost pad, which is as far as the row roads reach. */
export function rowEdge(pads: { ring: number }[]): number {
  return COL_X + Math.max(0, ...pads.map((p) => p.ring)) * PAD_PITCH + PAD_W / 2 + 0.4
}

/** Lays out one island's grid and finds the smallest coast that holds it, with room for the gate and the harbour. */
export function planIsland(g: GroupSnapshot): Plan {
  const pads = planPads(g.nodes, g.id)
  const rows = Math.max(1, Math.ceil(pads.length / padsPerRow(pads.length)))
  const span = (rows - 1) * ROW + 2 * CURB + PAD_D
  const roadZ0 = span / 2 - CURB
  const rowRoadZ = Array.from({ length: rows }, (_, r) => roadZ0 - r * ROW)
  const placed: Placed[] = []
  for (const pad of pads) {
    const roadZ = rowRoadZ[pad.row]
    const cx = padX(pad)
    pad.nodes.forEach((node, i) => placed.push({ node, pad, x: cx + (i - (pad.nodes.length - 1) / 2) * SLOT, z: roadZ - CURB - FRONT, roadZ }))
  }
  const edge = rowEdge(pads)
  const southZ = roadZ0 + CURB
  const northZ = rowRoadZ[rows - 1] - CURB - PAD_D
  const harbourZ = rowRoadZ[Math.floor((rows - 1) / 2)]
  const check: [number, number][] = [[-edge, southZ], [edge, southZ], [-edge, northZ], [edge, northZ], [edge + 11, harbourZ], [-edge - 2, harbourZ], [0, northZ - 4]]
  let k = 1
  let rx = 24, rz = 20
  for (let i = 0; i < 200; i++) {
    rx = 24 * k
    rz = 20 * k
    const o = makeOutline(hashString(g.id), rx, rz, 0.06)
    if (check.every(([x, z]) => o.contains(x, z, 2)) && coastScan(o, 'z') - 0.6 - southZ >= 9) break
    k *= 1.02
  }
  return { pads, placed, rows, rowRoadZ, rx, rz }
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
