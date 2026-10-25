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
const BX = -8 // building centre, left of the spine
const ROAD_Z = 1 // the road in front of the building, island-local

/**
 * A third party on a small island of its own: one building, a short road from the gate and a service lane in front, laid out like the
 * rows on a pillar's island so cars queue the same way. Island-local +z points at the island whose bridge reaches it (the gate side).
 */
export class VendorIsland {
  readonly root = new THREE.Group()
  readonly outline: Outline
  readonly building: Building
  /** Half the island's depth: how far the gate is from the centre, and the figure the layout works with. */
  readonly rz: number
  readonly rx: number
  readonly gateZ: number
  /** Where the building stands for the service lane: its x, the road in front, and the side of the spine. */
  readonly target: BayTarget = { x: BX, roadZ: ROAD_Z, col: 0 }

  constructor(readonly id: string, name: string, node: NodeSnapshot) {
    // the smallest island that holds the plot, the road and the gate
    const southZ = ROAD_Z + CURB
    const northZ = ROAD_Z - CURB - PAD_D
    const edge = Math.abs(BX) + PAD_WIDTH / 2 + 0.4
    const check: [number, number][] = [[-edge, southZ], [3, southZ], [-edge, northZ], [3, northZ], [0, northZ - 3]]
    let k = 1
    let rx = 17, rz = 15
    let outline = makeOutline(hashString(id), rx, rz, 0.06)
    for (let i = 0; i < 100; i++) {
      rx = 17 * k
      rz = 15 * k
      outline = makeOutline(hashString(id), rx, rz, 0.06)
      if (check.every(([x, z]) => outline.contains(x, z, 2)) && coastScan(outline, 'z') - 0.6 - southZ >= 7) break
      k *= 1.02
    }
    this.outline = outline
    this.rx = rx
    this.rz = rz
    this.gateZ = coastScan(outline, 'z') - 0.6
    this.root.add(buildIslandBody(outline))

    const decor = new THREE.Group()
    this.root.add(decor)
    const half = ROAD_W / 2
    const avoid: Rect[] = []
    decor.add(street(0, ROAD_Z + half, this.gateZ + 0.2), junction(0, ROAD_Z, true), streetX(ROAD_Z, -edge, -half, [-1]))
    avoid.push({ x: 0, z: (this.gateZ + ROAD_Z) / 2, w: 7, d: this.gateZ - ROAD_Z + 4 }, { x: -edge / 2, z: ROAD_Z, w: edge + 2, d: 2 * CURB + 1 })

    // the plot, the service lane in front of it and a little garden
    const zf = ROAD_Z - CURB
    decor.add(blockPad(BX, zf - PAD_D, zf, PAD_WIDTH))
    decor.add(serviceLane((-3 + (BX - PAD_WIDTH / 2 - 0.4)) / 2, ROAD_Z - LANE_Z, Math.abs(BX - PAD_WIDTH / 2 - 0.4 + 3), CURB - 2.1 - 0.7))
    avoid.push({ x: BX, z: zf - PAD_D / 2, w: PAD_WIDTH + 1, d: PAD_D + 1 })
    decor.add(prop('bush', BX - 2.2, zf - 0.9, 0, 2.2), prop('bush', BX + 2.8, zf - 0.9, 0, 1.8), lamp(BX + PAD_WIDTH / 2 - 3.4, zf + 0.45, 0, -Math.PI / 2))

    this.building = new Building(node.id, node.kind, VENDOR_COLOR)
    this.building.root.position.set(BX, GROUND + 0.08, zf - FRONT)
    this.root.add(this.building.root)

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

  /** A route into this vendor's service lane from a head that ends on its spine. Cars come out of the caller's door, cross the bridge and queue here. */
  into(head: THREE.Vector3[]): Pick<Route, 'path' | 'bay'> {
    // the head ends at the gate; the car then drives down the spine to the road in front of the building and turns into its lane
    return bayTo(this.target, (x, z) => this.world(x, z), [...head, this.world(0, this.target.roadZ)], null)!
  }
}
