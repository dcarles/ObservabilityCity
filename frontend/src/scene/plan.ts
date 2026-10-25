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

/** One service pad on the island's grid, with its buildings in a row and their fronts toward the road. */
export interface Pad {
  nodes: NodeSnapshot[]
  col: 0 | 1
  row: number
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

/** Services become pads (an API, its worker and its database side by side), lone buildings share pads, and pads fill a two-column grid. */
export function planPads(nodes: NodeSnapshot[]): Pad[] {
  const groups: NodeSnapshot[][] = []
  for (const n of nodes) {
    const last = groups[groups.length - 1]
    if (n.service && last && last[0].service === n.service && last.length < 3) last.push(n)
    else groups.push([n])
  }
  const out: NodeSnapshot[][] = []
  let loose: NodeSnapshot[] = []
  for (const grp of groups) {
    if (grp.length === 1 && !grp[0].service) {
      loose.push(grp[0])
      if (loose.length === 3) { out.push(loose); loose = [] }
    } else out.push(grp)
  }
  if (loose.length) out.push(loose)
  return out.map((ns, i) => ({ nodes: ns, col: (i % 2) as 0 | 1, row: Math.floor(i / 2) }))
}

/** Lays out one island's grid and finds the smallest coast that holds it, with room for the gate and the harbour. */
export function planIsland(g: GroupSnapshot): Plan {
  const pads = planPads(g.nodes)
  const rows = Math.max(1, Math.ceil(pads.length / 2))
  const span = (rows - 1) * ROW + 2 * CURB + PAD_D
  const roadZ0 = span / 2 - CURB
  const rowRoadZ = Array.from({ length: rows }, (_, r) => roadZ0 - r * ROW)
  const placed: Placed[] = []
  for (const pad of pads) {
    const roadZ = rowRoadZ[pad.row]
    const cx = (pad.col === 0 ? -1 : 1) * COL_X
    pad.nodes.forEach((node, i) => placed.push({ node, pad, x: cx + (i - (pad.nodes.length - 1) / 2) * SLOT, z: roadZ - CURB - FRONT, roadZ }))
  }
  const edge = COL_X + PAD_W / 2 + 0.4
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
  let lo = 0, hi = 90
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2
    const inside = axis === 'z' ? outline.contains(0, mid) : axis === '-z' ? outline.contains(0, -mid) : outline.contains(mid, at)
    if (inside) lo = mid
    else hi = mid
  }
  return lo
}
