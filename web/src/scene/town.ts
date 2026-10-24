import * as THREE from 'three'
import { Building } from '../buildings/building'
import { box, canvasTexture, cyl, flat, group, roundRect } from '../buildings/mk'
import { kit } from '../assets/kit'
import type { GroupSnapshot, NodeSnapshot, Snapshot } from '../types'
import { palette } from '../themes/harbour-town/palette'
import { blockPad, bench, bridge, crates, fountain, junction, lamp, pier, prop, ring, roadBetween, ROAD_W, street, streetX } from './props'
import { buildIslandBody, GROUND, makeOutline, scatterNature, type Outline, type Rect } from './island'
import { hashString } from './random'
import { CarSystem, type Route } from './cars'

const HUB_RX = 22
const HUB_RZ = 21
const RING_R = 5.7
const SLOT = 6.8 // width of the plot of one building along a pad
const PAD_W = 3 * SLOT + 0.8 // a service pad holds up to three buildings side by side
const PAD_D = 8.8
const CURB = 3.0 // road centre line to the edge of the pavement
const ROW = PAD_D + 2 * CURB + 1.2 // distance between two rows of pads
const COL_X = CURB + 0.4 + PAD_W / 2 // pad centre from the spine's centre line
const FRONT = 4.0 // building centre from the front edge of its pad

/** One service pad on the island's grid, with its buildings in a row and their fronts toward the road. */
/** Where an island's road leaves the hub: the direction it lies in and the point on the hub's coast. */
interface Port {
  angle: number
  coast: THREE.Vector3
}

interface Pad {
  nodes: NodeSnapshot[]
  col: 0 | 1
  row: number
}

interface Placed {
  node: NodeSnapshot
  pad: Pad
  /** Island-local position of the building's centre and of the road in front of it. */
  x: number
  z: number
  roadZ: number
}

interface Plan {
  pads: Pad[]
  placed: Placed[]
  rows: number
  rowRoadZ: number[]
  rx: number
  rz: number
}

interface Island {
  group: GroupSnapshot
  root: THREE.Group
  outline: Outline
  buildings: Map<string, Building>
}

/**
 * Builds the town from the first snapshot (the hub in the middle, one island per group on a ring) and then
 * only updates it. Layout is deterministic: the same registry gives the same town every time.
 */
export class Town {
  readonly root = new THREE.Group()
  readonly cars = new CarSystem()
  readonly buildings = new Map<string, Building>()
  readonly islands: Island[] = []
  hubOutline!: Outline
  /** Extent used to frame the camera. */
  readonly bounds = new THREE.Box3()
  private snapshotId = ''

  constructor() {
    this.root.add(this.cars.object)
  }

  /** True once the layout matches this snapshot's groups and nodes. */
  matches(s: Snapshot): boolean {
    return this.snapshotId === layoutKey(s)
  }

  build(s: Snapshot): void {
    this.snapshotId = layoutKey(s)
    const hub = s.groups.find((g) => g.isHub)
    const pillars = s.groups.filter((g) => !g.isHub)
    const routes: Route[] = []

    // Islands sit on a ring around the hub, clockwise from the north-east so their roads never run into the
    // hub's own buildings on the four main axes.
    const angles = pillars.map((_, i) => Math.PI / 4 + (i / pillars.length) * Math.PI * 2)
    const dirOf = (a: number) => new THREE.Vector3(Math.sin(a), 0, -Math.cos(a))

    // ── Hub ────────────────────────────────────────────────────────────────
    const hubRoot = new THREE.Group()
    this.hubOutline = makeOutline(hashString('hub'), HUB_RX, HUB_RZ, 0.05)
    hubRoot.add(buildIslandBody(this.hubOutline))
    const hubCoasts = angles.map((a) => coastPoint(this.hubOutline, dirOf(a), 0.9))
    const hubBuildings = this.buildHub(hubRoot, hub, angles.map((a, i) => ({ angle: a, coast: hubCoasts[i] })))
    this.root.add(hubRoot)
    this.expandBounds(this.hubOutline, new THREE.Vector3(), 0)

    // ── Islands on the ring ──────────────────────────────────────────────────
    const plans = pillars.map((g) => planIsland(g))
    const reach = Math.max(0, ...plans.map((p) => p.rz))
    const ringR = Math.max(HUB_RZ + 14 + reach, plans.reduce((acc, p) => acc + 2 * p.rx + 16, 0) / (2 * Math.PI))
    pillars.forEach((g, index) => {
      const plan = plans[index]
      const dir = dirOf(angles[index])
      const center = dir.clone().multiplyScalar(ringR)
      const island = this.buildIsland(g, plan, center)
      this.islands.push(island)
      this.root.add(island.root)
      this.expandBounds(island.outline, center, island.root.rotation.y, 12)

      const gate = island.root.localToWorld(new THREE.Vector3(0, GROUND, coastScan(island.outline, 'z') - 0.7))
      this.root.add(bridge({ from: hubCoasts[index].clone().setY(0), to: gate.clone().setY(0) }))
      routes.push(...this.islandRoutes(island, plan, angles[index], hubCoasts[index], gate))
    })

    routes.push(...this.hubRoutes(hubBuildings, angles.map((a, i) => ({ angle: a, coast: hubCoasts[i] }))))
    this.cars.setRoutes(routes)
  }

  /** Feed a snapshot into the existing buildings. */
  apply(s: Snapshot): void {
    for (const g of s.groups) for (const n of g.nodes) this.buildings.get(n.id)?.setNode(n)
  }

  update(dt: number, time: number, camera: THREE.Camera): void {
    for (const b of this.buildings.values()) b.update(dt, time, camera)
    this.cars.update(dt)
  }

  /** Grow the camera framing box by an island's coast, pushed out a little to leave room for piers. */
  private expandBounds(outline: Outline, center: THREE.Vector3, yaw: number, extra = 0): void {
    const c = Math.cos(yaw), sn = Math.sin(yaw)
    for (let i = 0; i < outline.points.length; i += 3) {
      const p = outline.points[i]
      const len = Math.hypot(p.x, p.y) || 1
      const x = p.x + (p.x / len) * extra, z = p.y + (p.y / len) * extra
      this.bounds.expandByPoint(new THREE.Vector3(center.x + x * c + z * sn, 0, center.z - x * sn + z * c))
    }
  }

  // ── hub ─────────────────────────────────────────────────────────────────

  private buildHub(hubRoot: THREE.Group, hub: GroupSnapshot | undefined, ports: Port[]): Building[] {
    const out: Building[] = []
    const avoid: Rect[] = [{ x: 0, z: 2, w: 20, d: 20 }, { x: 0, z: -15, w: 6, d: 14 }]
    const plan: Record<string, { x: number; z: number; yaw: number }> = {
      Gateway: { x: 0, z: -11.5, yaw: 0 },
      Broker: { x: 14.5, z: 2, yaw: Math.PI / 2 },
      Egress: { x: -14.5, z: 2, yaw: Math.PI / 2 },
      Database: { x: 0, z: 16, yaw: Math.PI },
    }
    for (const n of hub?.nodes ?? []) {
      const spot = plan[n.kind]
      if (!spot) continue
      const b = new Building(n.id, n.kind, hub?.color ?? palette.flagFallback)
      b.root.position.set(spot.x, GROUND, spot.z)
      b.root.rotation.y = spot.yaw
      hubRoot.add(b.root)
      this.buildings.set(n.id, b)
      out.push(b)
      avoid.push({ x: spot.x, z: spot.z, w: 12, d: 12 })
    }
    // plaza: paved centre with a fountain inside a ring road, and the roads out to each building
    const paving = new THREE.Mesh(new THREE.CylinderGeometry(3.7, 3.8, 0.14, 40), new THREE.MeshStandardMaterial({ color: palette.island.pavement, roughness: 0.95, flatShading: true }))
    paving.position.set(0, GROUND + 0.02, 2)
    paving.receiveShadow = true
    const fount = fountain()
    fount.position.x = 0
    fount.position.z = 2
    hubRoot.add(paving, fount, ring(0, 2, 3.7 + 0.4, RING_R + 2.1))
    hubRoot.add(street(0, -8.4, -5.8), street(0, 9.8, 11.4), streetX(2, 7.8, 11), streetX(2, -11.2, -7.8))
    // one spoke from the plaza to the coast for each island, where its bridge starts
    for (const port of ports) {
      const edge = new THREE.Vector3(Math.sin(port.angle) * (RING_R + 1.9), GROUND, 2 - Math.cos(port.angle) * (RING_R + 1.9))
      hubRoot.add(roadBetween(edge, port.coast))
      for (let r = 9; r < 30; r += 4) avoid.push({ x: Math.sin(port.angle) * r, z: 2 - Math.cos(port.angle) * r, w: 7, d: 7 })
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.4
      if (ports.some((p) => Math.abs(Math.atan2(Math.sin(a - p.angle), Math.cos(a - p.angle))) < 0.3)) continue
      hubRoot.add(lamp(Math.sin(a) * 8.6, 2 - Math.cos(a) * 8.6, Math.sin(a)))
    }
    hubRoot.add(bench(-6.0, -6.2, 0.6), bench(6.0, 9.6, 3.6), bench(-9.4, 8.2, 1.3))
    hubRoot.add(scatterNature(this.hubOutline, avoid, hashString('hub-trees'), { trees: 26, rocks: 12 }))
    return out
  }

  private hubRoutes(hubBuildings: Building[], ports: Port[]): Route[] {
    const routes: Route[] = []
    const ringPoint = (a: number) => new THREE.Vector3(Math.sin(a) * RING_R, GROUND, 2 - Math.cos(a) * RING_R)
    const arc = (from: number, to: number) => {
      const steps = Math.max(2, Math.ceil(Math.abs(to - from) / 0.25))
      return Array.from({ length: steps + 1 }, (_, i) => ringPoint(from + ((to - from) * i) / steps))
    }
    const exits: Partial<Record<Building['kind'], number>> = { Gateway: 0, Broker: Math.PI / 2, Egress: -Math.PI / 2, Database: Math.PI }
    for (const b of hubBuildings) {
      const exit = exits[b.kind]
      if (exit === undefined) continue
      const door = b.doorWorld().setY(GROUND)
      // Callers come in from every island over its own bridge and spoke, round the plaza to the building's street.
      for (const port of ports) {
        const from = Math.atan2(Math.sin(port.angle), Math.cos(port.angle))
        let to = exit
        while (to - from > Math.PI) to -= 2 * Math.PI
        while (to - from < -Math.PI) to += 2 * Math.PI
        routes.push({
          dest: b, origin: b.kind === 'Egress' ? 'external' : 'internal', share: 1 / ports.length,
          path: [port.coast.clone().setY(GROUND), ...arc(from, to), door],
        })
      }
    }
    return routes
  }

  // ── pillar islands ──────────────────────────────────────────────────────

  private buildIsland(g: GroupSnapshot, plan: Plan, center: THREE.Vector3): Island {
    const root = new THREE.Group()
    root.position.copy(center)
    // local +z points at the hub, where the gate is
    root.rotation.y = Math.atan2(-center.x, -center.z)

    const outline = makeOutline(hashString(g.id), plan.rx, plan.rz, 0.06)
    root.add(buildIslandBody(outline))

    const { rows, rowRoadZ } = plan
    const edge = COL_X + PAD_W / 2 + 0.4
    const gateZ = coastScan(outline, 'z') - 0.6
    const harbourRow = Math.floor((rows - 1) / 2)
    const harbourZ = rowRoadZ[harbourRow]
    const harbourCoast = coastScan(outline, 'x', harbourZ)
    const avoid: Rect[] = []

    // Roads: one spine from the gate, and a road in front of every row of pads, with a junction where they meet.
    const half = ROAD_W / 2
    root.add(street(0, rowRoadZ[0] + half, gateZ + 0.2))
    for (let r = 0; r < rows; r++) {
      const z = rowRoadZ[r]
      root.add(junction(0, z, r === rows - 1))
      if (r < rows - 1) root.add(street(0, rowRoadZ[r + 1] + half, z - half))
      root.add(streetX(z, -edge, -half))
      root.add(streetX(z, half, r === harbourRow ? harbourCoast - 8.3 : edge))
      avoid.push({ x: 0, z, w: 2 * edge + 2, d: 2 * CURB + 1 })
    }
    avoid.push({ x: 0, z: (gateZ + rowRoadZ[rows - 1]) / 2, w: 7, d: gateZ - rowRoadZ[rows - 1] + 4 })

    const buildings = new Map<string, Building>()
    for (const pad of plan.pads) {
      const roadZ = rowRoadZ[pad.row]
      const zf = roadZ - CURB
      const cx = (pad.col === 0 ? -1 : 1) * COL_X
      root.add(blockPad(cx, zf - PAD_D, zf, PAD_W))
      avoid.push({ x: cx, z: zf - PAD_D / 2, w: PAD_W + 1, d: PAD_D + 1 })
      for (const side of [-1, 1]) root.add(lamp(cx + side * (PAD_W / 2 - 3.4), zf + 0.45, 0, -Math.PI / 2))
    }
    for (const p of plan.placed) {
      const b = new Building(p.node.id, p.node.kind, g.color)
      b.root.position.set(p.x, GROUND + 0.08, p.z)
      root.add(b.root)
      this.buildings.set(p.node.id, b)
      buildings.set(p.node.id, b)
      const zf = p.roadZ - CURB
      // a little garden in front of each building and the odd bit of street furniture
      root.add(prop('bush', p.x - 2.2, zf - 0.9, 0, 2.2), prop('bush', p.x + 2.8, zf - 0.9, 0, 1.8))
      if (p.node.kind === 'Worker') root.add(prop('dumpster', p.x + 2.4, p.z - 3.6, 0.2))
      if (p.node.kind === 'Api') root.add(prop('firehydrant', p.x + 2.9, zf + 0.5, 0, 2.4))
    }
    // a spare cell in the grid becomes a small park
    if (plan.pads.length % 2 === 1) {
      const row = rows - 1
      const zf = rowRoadZ[row] - CURB
      root.add(...parkProps(COL_X, zf - PAD_D / 2))
      avoid.push({ x: COL_X, z: zf - PAD_D / 2, w: PAD_W + 1, d: PAD_D + 1 })
    }

    // the island's sign: one post, standing on land beside the gate
    const signZ = gateZ - 2.4
    root.add(this.islandSign(g, -6.4, signZ))
    avoid.push({ x: -6.4, z: signZ, w: 6, d: 4 })
    // the island's own harbour on the east coast, at the end of a road
    root.add(this.harbour(harbourCoast, harbourZ))
    avoid.push({ x: harbourCoast - 3, z: harbourZ, w: 11, d: 11 })

    const trees = Math.min(110, Math.round(40 * (plan.rx * plan.rz) / (24 * 20)))
    root.add(scatterNature(outline, avoid, hashString(g.id + '-nature'), { trees, rocks: Math.round(trees / 3) }))
    root.updateMatrixWorld(true)
    return { group: g, root, outline, buildings }
  }

  /** A quay with a harbour house, a pier and crates. The island's own messaging lands here in a later slice. */
  private harbour(coastX: number, z: number): THREE.Group {
    const g = new THREE.Group()
    const quay = new THREE.Mesh(new THREE.BoxGeometry(8, 0.16, 7), new THREE.MeshStandardMaterial({ color: '#d9d1bd', roughness: 0.95, flatShading: true }))
    quay.position.set(coastX - 4.2, GROUND + 0.01, z)
    quay.receiveShadow = true
    const house = group(
      box(3.4, 2.4, 3.4, flat('#4f7aa6')),
      box(3.8, 0.2, 3.8, flat('#f1ece0'), { y: 2.4 }),
      box(3.5, 0.9, 0.12, flat('#2f3a46'), { y: 0.1, z: 1.75 }),
    )
    const roofG = new THREE.ConeGeometry(2.9, 1.5, 4)
    roofG.rotateY(Math.PI / 4)
    roofG.translate(0, 0.75, 0)
    const roofM = new THREE.Mesh(roofG, flat('#c0483f'))
    roofM.position.y = 2.6
    roofM.castShadow = true
    house.add(roofM)
    house.position.set(coastX - 6.4, GROUND, z)
    house.rotation.y = Math.PI / 2
    const sign = canvasTexture(256, 64, (ctx) => {
      ctx.fillStyle = '#f4efe2'; ctx.fillRect(0, 0, 256, 64)
      ctx.fillStyle = '#26364f'; ctx.font = '700 34px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('HARBOUR', 128, 34)
    })
    const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.65), new THREE.MeshBasicMaterial({ map: sign }))
    signMesh.position.set(0, 2.2, 1.78)
    house.add(signMesh)
    const p = pier(11)
    p.rotation.y = Math.PI / 2
    p.position.set(coastX - 1.5, 0, z)
    const c = crates()
    c.position.set(coastX - 2.2, 0, z + 1.2)
    c.rotation.y = Math.PI / 2
    const c2 = kit('box_A')
    c2.scale.setScalar(2.4)
    c2.position.set(coastX - 3.2, GROUND + 0.05, z - 1.8)
    g.add(quay, house, p, c, c2, lamp(coastX - 2.6, z - 2.6, 1), cyl(0.16, 0.2, 0.8, flat(palette.woodDark), { x: coastX - 1.6, y: GROUND, z: z + 1.9 }, 8))
    return g
  }

  /** One thick post with a board on it, standing on the ground. */
  private islandSign(g: GroupSnapshot, x: number, z: number): THREE.Group {
    const tex = canvasTexture(512, 128, (ctx) => {
      ctx.fillStyle = '#f7f0df'; roundRect(ctx, 4, 4, 504, 120, 22); ctx.fill()
      ctx.fillStyle = g.color; ctx.fillRect(4, 4, 504, 22)
      ctx.fillStyle = '#26364f'; ctx.font = '800 54px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(g.displayName.toUpperCase(), 256, 72, 470)
    })
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.22, 4.4, 7), new THREE.MeshStandardMaterial({ color: palette.woodDark, flatShading: true }))
    post.position.y = 2.2
    post.castShadow = true
    const board = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.4, 0.12), new THREE.MeshStandardMaterial({ color: '#f7f0df', roughness: 0.9 }))
    board.position.set(0, 3.6, 0.17)
    board.castShadow = true
    const face = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 1.35), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }))
    face.position.set(0, 3.6, 0.24)
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 6), new THREE.MeshStandardMaterial({ color: palette.woodDark, flatShading: true }))
    cap.position.y = 4.45
    const sign = new THREE.Group()
    sign.add(post, board, face, cap)
    sign.position.set(x, GROUND, z)
    sign.rotation.y = 0.25
    return sign
  }

  // ── routes ──────────────────────────────────────────────────────────────

  private islandRoutes(island: Island, plan: Plan, angle: number, hubCoast: THREE.Vector3, gate: THREE.Vector3): Route[] {
    const routes: Route[] = []
    const w = (x: number, z: number) => island.root.localToWorld(new THREE.Vector3(x, GROUND, z))
    const ringAt = (a: number) => new THREE.Vector3(Math.sin(a) * RING_R, GROUND, 2 - Math.cos(a) * RING_R)
    const fromRing = [ringAt(angle - 0.4), ringAt(angle - 0.2), ringAt(angle), hubCoast.clone().setY(GROUND), gate]
    // Cars park on the road in front of a building. Between rows they go via the spine.
    const between = (from: Placed, to: Placed): THREE.Vector3[] => {
      const out = [w(from.x, from.roadZ)]
      if (from.roadZ !== to.roadZ) out.push(w(0, from.roadZ), w(0, to.roadZ))
      out.push(w(to.x, to.roadZ))
      return out
    }

    for (const dest of plan.placed) {
      const b = island.buildings.get(dest.node.id)!
      if (dest.node.kind === 'Worker' || dest.node.kind === 'Cron' || dest.node.kind === 'Broker') continue
      const external = dest.node.external
      const inbound = [...fromRing, w(0, dest.roadZ), w(dest.x, dest.roadZ)]
      // Callers from other islands arrive through the gate house, over the bridge and up the spine.
      routes.push({ dest: b, origin: external ? 'external' : 'internal', share: external ? 0.85 : dest.node.kind === 'Api' ? 0.35 : 0.08, path: inbound })
      // Neighbours on the same island call it from their own doors; the same service block most of all.
      const callers = plan.placed.filter((s) => s !== dest && (s.node.kind === 'Api' || s.node.kind === 'Worker'))
      const sameService = callers.filter((s) => s.node.service && s.node.service === dest.node.service)
      const weights = callers.map((c) => (sameService.includes(c) ? 3 : 1))
      const total = weights.reduce((a, b2) => a + b2, 0) || 1
      callers.forEach((from, i) => {
        const share = (external ? 0.15 : dest.node.kind === 'Api' ? 0.65 : 0.92) * (weights[i] / total)
        routes.push({ dest: b, origin: 'internal', share, path: between(from, dest) })
      })
      // and the answers drive back out toward the gate
      routes.push({ dest: b, origin: external ? 'external' : 'internal', share: external ? 0.4 : 0.15, leaving: true, path: inbound })
    }
    return routes
  }

  node(id: string): NodeSnapshot | null {
    return this.buildings.get(id)?.node ?? null
  }
}

/** Services become pads (an API, its worker and its database side by side), lone buildings share pads, and pads fill a two-column grid. */
function planPads(nodes: NodeSnapshot[]): Pad[] {
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
function planIsland(g: GroupSnapshot): Plan {
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

/** A couple of trees, flower beds and benches for a spare pad. */
function parkProps(x: number, z: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = []
  const trunk = new THREE.MeshStandardMaterial({ color: palette.tree.trunk, flatShading: true })
  const leaf = new THREE.MeshStandardMaterial({ color: '#58b85a', flatShading: true })
  for (const [dx, dz, s] of [[-6, -1.5, 1.35], [5.5, 1.2, 1.05], [-1, 2.2, 0.9], [8, -2, 1.2]] as const) {
    const t = new THREE.Group()
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 1.1, 5), trunk); tr.position.y = 0.55; tr.castShadow = true
    const l = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 0), leaf); l.position.y = 1.9; l.castShadow = true
    t.add(tr, l)
    t.scale.setScalar(s)
    t.position.set(x + dx, GROUND, z + dz)
    out.push(t)
  }
  out.push(bench(x - 2.5, z + 2.6, 0), bench(x + 2, z - 2.8, Math.PI))
  const colors = ['#ff7a8a', '#ffd84d', '#ffffff', '#b58cff']
  for (let i = 0; i < 14; i++) {
    const f = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 0), new THREE.MeshStandardMaterial({ color: colors[i % 4], flatShading: true }))
    f.position.set(x - 1.5 + (i % 7) * 0.5, GROUND + 0.18, z - 0.3 + Math.floor(i / 7) * 0.6)
    out.push(f)
  }
  return out
}

function layoutKey(s: Snapshot): string {
  return `${s.townId}|${s.groups.map((g) => `${g.id}:${g.nodes.map((n) => `${n.id}/${n.kind}/${n.service ?? ''}`).join(',')}`).join(';')}`
}

/** Where a straight line from the hub's centre leaves the hub's coast (inset a little). */
function coastPoint(outline: Outline, dir: THREE.Vector3, inset: number): THREE.Vector3 {
  let lo = 0, hi = 60
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (outline.contains(dir.x * mid, dir.z * mid)) lo = mid
    else hi = mid
  }
  return new THREE.Vector3(dir.x * (lo - inset), GROUND, dir.z * (lo - inset))
}

/** Island-local coast: the far +z edge at x=0 (for 'z'), or the +x edge at the given z (for 'x'). */
function coastScan(outline: Outline, axis: 'z' | 'x', at = 0): number {
  let lo = 0, hi = 90
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2
    const inside = axis === 'z' ? outline.contains(0, mid) : outline.contains(mid, at)
    if (inside) lo = mid
    else hi = mid
  }
  return lo
}
