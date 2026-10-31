import * as THREE from 'three'
import { Building } from '../buildings/building'
import type { NodeSnapshot } from '../types'
import { blockPad, junction, lamp, prop, serviceLane, street, streetX, ROAD_W } from './props'
import { buildIslandBody, GROUND, makeOutline, scatterNature, type Outline, type Rect } from './island'
import { CURB, FRONT, LANE_Z, PAD_D, coastScan } from './plan'
import { hashString } from './random'
import { mergeStatic } from './merge'
import { islandSign } from './sign'
import { bayTo, type BayTarget } from './bay'
import type { Route } from './cars'

/** The colour of a third party's sign stripe: neutral, because it belongs to nobody in the town. */
export const VENDOR_COLOR = '#8fa3b8'

const PAD_WIDTH = 12 // one building's plot
const BX = 8 // a building's centre, from the spine
const ROAD_Z = 1 // the road in front of the first row of buildings, island-local
const ROW_PITCH = 2 * CURB + PAD_D // from one row road to the next

const PAD_PITCH = PAD_WIDTH + 2 // one plot's centre to the next along a row road
const PER_ROW = [2, 4, 6, 8] // plots on a row road, half on each side of the spine

/** Where the k-th building of an island stands: rows of `perRow` plots, half each side of the spine, filled from the spine outwards, then the next row up. */
export function vendorSlot(k: number, perRow = 2): BayTarget {
  const col = (k % 2) as 0 | 1
  const ring = Math.floor((k % perRow) / 2)
  const x = (col === 0 ? -1 : 1) * (BX + ring * PAD_PITCH)
  return { x, roadZ: ROAD_Z - Math.floor(k / perRow) * ROW_PITCH, col, laneStart: ring === 0 ? 5 : Math.abs(x) - PAD_WIDTH / 2 - 0.4 }
}

function fitIsland(id: string, count: number, perRow: number) {
  const slots = Array.from({ length: count }, (_, k) => vendorSlot(k, perRow))
  const rows = Math.ceil(count / perRow)
  const wide = count > 1
  // the smallest island that holds the plots, the roads and the gate
  const southZ = ROAD_Z + CURB
  const northZ = ROAD_Z - (rows - 1) * ROW_PITCH - CURB - PAD_D
  const edge = Math.max(BX, ...slots.map((t) => Math.abs(t.x))) + PAD_WIDTH / 2 + 0.4
  const check: [number, number][] = [[-edge, southZ], [3, southZ], [-edge, northZ], [3, northZ], [0, northZ - 3]]
  if (wide) check.push([edge, southZ], [edge, northZ])
  let k = 1
  let rx = 17, rz = 15
  let outline = makeOutline(hashString(id), rx, rz, 0.06)
  for (let i = 0; i < 400; i++) {
    rx = 17 * k
    rz = 15 * k
    outline = makeOutline(hashString(id), rx, rz, 0.06)
    if (check.every(([x, z]) => outline.contains(x, z, 2)) && coastScan(outline, 'z') - 0.6 - southZ >= 7) break
    k *= 1.02
  }
  return { slots, rows, wide, outline, rx, rz, gateZ: coastScan(outline, 'z') - 0.6, edge, perRow }
}

/**
 * The size and shape of a vendor island that holds `count` buildings, worked out from sizes alone so it can be tested without a renderer. Like a
 * pillar's island it takes whichever of 2, 4, 6 or 8 plots to a row gives the smallest island, so many buildings make a grid, not a long strip.
 */
export function planVendorIsland(id: string, count: number) {
  let best = fitIsland(id, count, PER_ROW[0])
  for (const n of PER_ROW.slice(1)) {
    if (n > Math.max(2, count + 1)) break
    const plan = fitIsland(id, count, n)
    if (plan.rx * plan.rz < best.rx * best.rz - 1e-9) best = plan
  }
  return best
}

/**
 * A third party on a small island of its own: a short road from the gate and, along it, a plot with a service lane in front for each of its
 * buildings, laid out like the rows on a pillar's island so cars queue the same way. A vendor with several services stands them on this one
 * island, two to a row. Island-local +z points at the island whose bridge reaches it (the gate side).
 */
export class VendorIsland {
  readonly root = new THREE.Group()
  readonly outline: Outline
  /** The island's buildings by node id, in the order the snapshot lists them. */
  readonly buildings = new Map<string, Building>()
  /** Half the island's depth: how far the gate is from the centre, and the figure the layout works with. */
  readonly rz: number
  readonly rx: number
  readonly gateZ: number
  /** Where each building stands for the service lane: its x, the road in front, and the side of the spine. */
  readonly targets = new Map<string, BayTarget>()

  constructor(readonly id: string, name: string, nodes: NodeSnapshot[]) {
    const { slots, rows, outline, rx, rz, gateZ, edge, perRow } = planVendorIsland(id, nodes.length)
    this.outline = outline
    this.rx = rx
    this.rz = rz
    this.gateZ = gateZ
    this.root.add(buildIslandBody(outline))

    const decor = new THREE.Group()
    this.root.add(decor)
    const half = ROAD_W / 2
    const avoid: Rect[] = []
    const lastRoadZ = ROAD_Z - (rows - 1) * ROW_PITCH
    decor.add(street(0, lastRoadZ + half, this.gateZ + 0.2), junction(0, ROAD_Z, true))
    avoid.push({ x: 0, z: (this.gateZ + lastRoadZ) / 2, w: 7, d: this.gateZ - lastRoadZ + 4 })

    // for each building: the plot, the road and service lane in front of it and a little garden
    nodes.forEach((node, i) => {
      const slot = slots[i]
      const out = slot.col === 0 ? -1 : 1
      const zf = slot.roadZ - CURB
      if (i >= perRow && i % perRow === 0) decor.add(junction(0, slot.roadZ, true))
      if (slot.laneStart === 5) decor.add(streetX(slot.roadZ, out * half, out * edge, [-1]))
      decor.add(blockPad(slot.x, zf - PAD_D, zf, PAD_WIDTH))
      const laneFrom = slot.laneStart === 5 ? 3 : slot.laneStart!
      const laneTo = Math.abs(slot.x) + PAD_WIDTH / 2 + 0.4
      decor.add(serviceLane(out * (laneFrom + laneTo) / 2, slot.roadZ - LANE_Z, laneTo - laneFrom, CURB - 2.1 - 0.7))
      avoid.push({ x: slot.x, z: zf - PAD_D / 2, w: PAD_WIDTH + 1, d: PAD_D + 1 }, { x: out * edge / 2, z: slot.roadZ, w: edge + 2, d: 2 * CURB + 1 })
      decor.add(prop('bush', slot.x - 2.2, zf - 0.9, 0, 2.2), prop('bush', slot.x + 2.8, zf - 0.9, 0, 1.8), lamp(slot.x - out * (PAD_WIDTH / 2 - 3.4), zf + 0.45, 0, -Math.PI / 2))
      const building = new Building(node.id, node.kind, VENDOR_COLOR)
      building.root.position.set(slot.x, GROUND + 0.08, zf - FRONT)
      this.root.add(building.root)
      this.buildings.set(node.id, building)
      this.targets.set(node.id, slot)
    })

    const signZ = this.gateZ - 2.4
    decor.add(islandSign(name, VENDOR_COLOR, 7.5, signZ))
    avoid.push({ x: 7.5, z: signZ, w: 12, d: 5 })
    const trees = Math.round(26 * (rx * rz) / (17 * 15))
    this.root.add(scatterNature(outline, avoid, hashString(id + '-nature'), { trees, rocks: Math.round(trees / 3) }))
    mergeStatic(decor)
  }

  /** Island-local to world, once the island has been placed. */
  world(x: number, z: number): THREE.Vector3 {
    return this.root.localToWorld(new THREE.Vector3(x, GROUND, z))
  }

  /** The gate in world coordinates: where the bridge from the caller ends. */
  gate(): THREE.Vector3 {
    return this.world(0, this.gateZ)
  }

  /** A route into one building's service lane from a head that ends on the island's spine. Cars come out of the caller's door, cross the bridge and queue here. */
  into(head: THREE.Vector3[], nodeId: string): Pick<Route, 'path' | 'bay'> {
    const target = this.targets.get(nodeId)!
    // the head ends at the gate; the car then drives down the spine to the road in front of the building and turns into its lane
    return bayTo(target, (x, z) => this.world(x, z), [...head, this.world(0, target.roadZ)], null)!
  }
}
