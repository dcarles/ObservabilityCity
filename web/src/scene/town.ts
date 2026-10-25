import * as THREE from 'three'
import { Building, type BuildingStatus } from '../buildings/building'
import { box, canvasTexture, cyl, flat, group, roundRect } from '../buildings/mk'
import { kit } from '../assets/kit'
import type { GroupSnapshot, NodeSnapshot, Snapshot } from '../types'
import { palette } from '../themes/harbour-town/palette'
import { blockPad, bench, bridge, crates, fountain, junction, lamp, pier, prop, ring, roadBetween, ROAD_W, serviceLane, street, streetX } from './props'
import { buildIslandBody, GROUND, makeOutline, scatterNature, type Outline, type Rect } from './island'
import { COL_X, CURB, LANE_SLOTS, LANE_Z, PAD_D, PAD_W, QUEUE_GAP, coastScan, planIsland, type Placed, type Plan } from './plan'
import { hashString } from './random'
import { clamp, formatRate, speedFactor } from '../visuals'
import { CarSystem, type Route } from './cars'
import { BoatSystem, type BoatRoute } from './boats'
import { HarbourStatus, messagingOf, type Messaging } from './harbour'
import { findLane, type SeaMap } from './sea'
import { mergeStatic } from './merge'
import { hubGeometry, layoutTown, wrapAngle, type HubGeometry } from './layout'

const QUAY = 9

/** Where an island's road leaves the hub: the direction it lies in and the point on the hub's coast. */
interface Port {
  angle: number
  coast: THREE.Vector3
}

interface Island {
  group: GroupSnapshot
  root: THREE.Group
  outline: Outline
  buildings: Map<string, Building>
  harbour: HarbourStatus
  messaging: Messaging
}

/**
 * Builds the town from the first snapshot (the hub in the middle, one island per group on a ring) and then
 * only updates it. Layout is deterministic: the same registry gives the same town every time.
 */
export class Town {
  readonly root = new THREE.Group()
  readonly cars = new CarSystem()
  readonly boats = new BoatSystem()
  readonly buildings = new Map<string, Building>()
  readonly islands: Island[] = []
  hubOutline!: Outline
  /** Size of the hub for this town. It grows with the number of islands. */
  private hubGeo: HubGeometry = hubGeometry(0)
  private hubDecor = new THREE.Group()
  /** Extent used to frame the camera. */
  readonly bounds = new THREE.Box3()
  /** Points along every coast, for working out how far back the camera must stand to show the whole town. */
  readonly extent: THREE.Vector3[] = []
  private snapshotId = ''
  private hubDeadLetters = 0
  private hubBoard: { sprite: THREE.Sprite; key: string } | null = null

  constructor() {
    this.root.add(this.cars.object, this.boats.object)
  }

  /** True once the layout matches this snapshot's groups and nodes. */
  matches(s: Snapshot): boolean {
    return this.snapshotId === layoutKey(s)
  }

  /** Forget the layout, so the next snapshot builds the town again. Used after a build that failed half way. */
  invalidate(): void {
    this.snapshotId = ''
  }

  build(s: Snapshot): void {
    this.snapshotId = ''
    const hub = s.groups.find((g) => g.isHub)
    const pillars = s.groups.filter((g) => !g.isHub)
    const routes: Route[] = []
    const boatRoutes: BoatRoute[] = []
    const bridges: [THREE.Vector2, THREE.Vector2][] = []

    // Islands stand round the hub in registry order, twelve to a ring and the rest in a staggered outer ring. The hub
    // grows with their number, so every spoke road has room where it leaves the plaza.
    const plans = pillars.map((g) => planIsland(g))
    const layout = layoutTown(plans.map((p) => ({ rx: p.rx, rz: p.rz })))
    this.hubGeo = layout.hub
    const angles = layout.islands.map((i) => i.angle)
    const ports = layout.islands.map((i) => i.portAngle)
    const dirOf = (a: number) => new THREE.Vector3(Math.sin(a), 0, -Math.cos(a))

    // ── Hub ────────────────────────────────────────────────────────────────
    const hubRoot = new THREE.Group()
    this.hubOutline = makeOutline(hashString('hub'), this.hubGeo.rx, this.hubGeo.rz, 0.05)
    hubRoot.add(buildIslandBody(this.hubOutline))
    const hubCoasts = ports.map((a) => coastPoint(this.hubOutline, dirOf(a), 0.9))
    const hubBuildings = this.buildHub(hubRoot, hub, ports.map((a, i) => ({ angle: a, coast: hubCoasts[i] })))
    this.root.add(hubRoot)
    this.expandBounds(this.hubOutline, new THREE.Vector3(), 0)
    const broker = hubBuildings.find((b) => b.kind === 'Broker')
    this.hubBoard = null
    if (broker) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTexture(320, 96, () => {}), transparent: true, depthTest: false, toneMapped: false }))
      sprite.renderOrder = 10
      sprite.scale.set(3.6, 1.08, 1)
      sprite.position.copy(broker.root.position).add(new THREE.Vector3(0, 8.4, 0))
      hubRoot.add(sprite)
      this.hubBoard = { sprite, key: '' }
    }

    // ── Islands ──────────────────────────────────────────────────────────────
    const bridgeDecor = new THREE.Group()
    this.root.add(bridgeDecor)
    pillars.forEach((g, index) => {
      const plan = plans[index]
      const dir = dirOf(angles[index])
      const center = dir.clone().multiplyScalar(layout.islands[index].radius)
      const island = this.buildIsland(g, plan, center)
      this.islands.push(island)
      this.root.add(island.root)
      this.expandBounds(island.outline, center, island.root.rotation.y, 12)

      const gate = island.root.localToWorld(new THREE.Vector3(0, GROUND, coastScan(island.outline, 'z') - 0.7))
      bridgeDecor.add(bridge({ from: hubCoasts[index].clone().setY(0), to: gate.clone().setY(0) }))
      bridges.push([new THREE.Vector2(hubCoasts[index].x, hubCoasts[index].z), new THREE.Vector2(gate.x, gate.z)])
      routes.push(...this.islandRoutes(island, plan, ports[index], hubCoasts[index], gate))
    })

    // ── Sea lanes: boats sail from a hub quay in the gap beside each bridge to the island's harbour ──
    this.root.updateMatrixWorld(true)
    const land = [this.hubOutline.points.map((p) => new THREE.Vector2(p.x, p.y))]
    for (const isl of this.islands) land.push(isl.outline.points.map((p) => {
      const w = isl.root.localToWorld(new THREE.Vector3(p.x, 0, p.y))
      return new THREE.Vector2(w.x, w.z)
    }))
    const sea: SeaMap = { land, bridges }
    const quays = new Map<number, THREE.Vector3>()
    const quayAt = (a: number) => {
      const key = Math.round(wrapAngle(a) * 100)
      let q = quays.get(key)
      if (!q) {
        q = this.hubQuay(a)
        quays.set(key, q)
      }
      return q
    }
    pillars.forEach((_g, index) => {
      const n = pillars.length
      const here = ports[index]
      const sides = n > 1 ? [wrapAngle(ports[(index + 1) % n] - here) / 2, wrapAngle(ports[(index + n - 1) % n] - here) / 2] : [Math.PI / 2]
      let best: THREE.Vector3[] | null = null
      let bestAngle = 0
      for (const half of sides) {
        const a = here + half
        const dir = dirOf(a)
        const tip = coastPoint(this.hubOutline, dir, 1.6 - (QUAY + 3)).setY(0)
        const lane = findLane(sea, tip, this.harbourWater(this.islands[index], plans[index]))
        if (lane && (!best || laneLength(lane) < laneLength(best))) { best = lane; bestAngle = a }
      }
      if (!best) return
      quayAt(bestAngle)
      boatRoutes.push(this.boatRoute(this.islands[index], best, hubBuildings))
    })

    mergeStatic(bridgeDecor)
    mergeStatic(this.hubDecor)
    routes.push(...this.hubRoutes(hubBuildings, ports.map((a, i) => ({ angle: a, coast: hubCoasts[i] }))))
    this.cars.setRoutes(routes)
    this.boats.setRoutes(boatRoutes)
    this.snapshotId = layoutKey(s)
  }

  /** The Service Bus port's board: dead letters across every island. */
  private updateHubBoard(camera: THREE.Camera): void {
    const hb = this.hubBoard
    if (!hb) return
    const total = Math.round(this.hubDeadLetters)
    const key = String(total)
    const d = camera.position.distanceTo(hb.sprite.getWorldPosition(new THREE.Vector3()))
    const opacity = total > 0 ? 1 : 1 - clamp((d - 70) / 40, 0, 1)
    ;(hb.sprite.material as THREE.SpriteMaterial).opacity = opacity
    hb.sprite.visible = opacity > 0.02
    if (key === hb.key) return
    hb.key = key
    const tex = (hb.sprite.material as THREE.SpriteMaterial).map as THREE.CanvasTexture
    const ctx = (tex.image as HTMLCanvasElement).getContext('2d')!
    ctx.clearRect(0, 0, 320, 96)
    ctx.fillStyle = 'rgba(20,28,40,0.92)'; roundRect(ctx, 4, 8, 312, 80, 24); ctx.fill()
    ctx.strokeStyle = total > 0 ? '#ff5a4d' : '#9fb4cc'; ctx.lineWidth = 6; ctx.stroke()
    ctx.fillStyle = total > 0 ? '#ff5a4d' : '#b8c7da'; ctx.font = '800 34px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(`DLQ total ${formatRate(total)}`, 160, 50, 290)
    tex.needsUpdate = true
  }

  /** Feed a snapshot into the existing buildings. */
  apply(s: Snapshot): void {
    // One building that cannot take its numbers must not stop the others from taking theirs.
    for (const g of s.groups) for (const n of g.nodes) this.guard(`apply ${n.id}`, () => this.buildings.get(n.id)?.setNode(n))
    for (const isl of this.islands) {
      const g = s.groups.find((x) => x.id === isl.group.id)
      if (g) this.guard(`messaging ${g.id}`, () => { isl.messaging = messagingOf([...g.nodes]) })
    }
    this.hubDeadLetters = this.islands.reduce((a, i) => a + (i.messaging.deadLetters ?? 0), 0)
  }

  update(dt: number, time: number, camera: THREE.Camera): void {
    for (const [id, b] of this.buildings) this.guard(`update ${id}`, () => b.update(dt, time, camera))
    for (const isl of this.islands) this.guard(`harbour ${isl.group.id}`, () => isl.harbour.update(isl.messaging, time, camera))
    this.guard('hub board', () => this.updateHubBoard(camera))
    this.guard('cars', () => this.cars.update(dt))
    this.guard('boats', () => this.boats.update(dt))
  }

  private readonly reported = new Set<string>()

  /** Runs one piece of per-frame work. If it throws, the error is logged once and the rest of the town carries on. */
  private guard(what: string, work: () => void): void {
    try {
      work()
    } catch (e) {
      if (this.reported.has(what)) return
      this.reported.add(what)
      console.error(`Could not ${what}:`, e)
    }
  }

  /** What one building shows right now, as plain values. For tests. */
  inspect(id: string): (BuildingStatus & { bubble: { visible: boolean; honk: boolean; waiting: number } | null }) | null {
    const b = this.buildings.get(id)
    const st = b?.status()
    return b && st ? { ...st, bubble: this.cars.bubbleOf(b) } : null
  }

  /** What an island's harbour shows, and whether the island is a config error island. For tests. */
  inspectIsland(groupId: string): { id: string; buildings: number; configError: string | null; crates: number; brokenCrates: number; alarm: boolean } | null {
    const isl = this.islands.find((i) => i.group.id === groupId)
    return isl ? { id: groupId, buildings: isl.buildings.size, configError: isl.group.configError ?? null, ...isl.harbour.status() } : null
  }

  /** Grow the camera framing box by an island's coast, pushed out a little to leave room for piers. */
  private expandBounds(outline: Outline, center: THREE.Vector3, yaw: number, extra = 0): void {
    const c = Math.cos(yaw), sn = Math.sin(yaw)
    for (let i = 0; i < outline.points.length; i += 3) {
      const p = outline.points[i]
      const len = Math.hypot(p.x, p.y) || 1
      const x = p.x + (p.x / len) * extra, z = p.y + (p.y / len) * extra
      const pt = new THREE.Vector3(center.x + x * c + z * sn, 0, center.z - x * sn + z * c)
      this.bounds.expandByPoint(pt)
      this.extent.push(pt)
    }
  }

  // ── hub ─────────────────────────────────────────────────────────────────

  private buildHub(hubRoot: THREE.Group, hub: GroupSnapshot | undefined, ports: Port[]): Building[] {
    const out: Building[] = []
    const decor = new THREE.Group()
    hubRoot.add(decor)
    this.hubDecor = decor
    const f = this.hubGeo.scale
    const ringR = this.hubGeo.ringR
    const CZ = 2 // the plaza's centre sits a little south of the hub's
    // The four main buildings stand on the axes, scaled out with the hub. Each is [distance from the centre, yaw].
    const spots: Record<string, { x: number; z: number; yaw: number }> = {
      Gateway: { x: 0, z: CZ - 13.5 * f, yaw: 0 },
      Broker: { x: 14.5 * f, z: CZ, yaw: Math.PI / 2 },
      Egress: { x: -14.5 * f, z: CZ, yaw: Math.PI / 2 },
      Database: { x: 0, z: CZ + 14 * f, yaw: Math.PI },
    }
    const avoid: Rect[] = [{ x: 0, z: CZ, w: 20 * f, d: 20 * f }, { x: 0, z: CZ - 15 * f, w: 6, d: 14 }]
    const seen = new Set<string>()
    for (const n of hub?.nodes ?? []) {
      const spot = spots[n.kind]
      if (!spot || seen.has(n.kind)) {
        // the hub has one slot for each of gateway, broker, egress and database
        console.warn(`Hub resource ${n.id} has no free slot and is not drawn`)
        continue
      }
      seen.add(n.kind)
      const b = new Building(n.id, n.kind, hub?.color ?? palette.flagFallback)
      b.root.position.set(spot.x, GROUND, spot.z)
      b.root.rotation.y = spot.yaw
      hubRoot.add(b.root)
      this.buildings.set(n.id, b)
      out.push(b)
      avoid.push({ x: spot.x, z: spot.z, w: 12, d: 12 })
    }
    // plaza: paved centre with a fountain inside a ring road, and the roads out to each building
    const paving = new THREE.Mesh(new THREE.CylinderGeometry(3.7 * f, 3.8 * f, 0.14, 48), new THREE.MeshStandardMaterial({ color: palette.island.pavement, roughness: 0.95, flatShading: true }))
    paving.position.set(0, GROUND + 0.02, CZ)
    paving.receiveShadow = true
    const fount = fountain()
    fount.position.x = 0
    fount.position.z = CZ
    fount.scale.setScalar(Math.min(1.8, f))
    decor.add(paving, fount, ring(0, CZ, 3.7 * f + 0.4, ringR + 2.1))
    // a short street from the ring road to the front of each building
    const reach = (d: number) => d - 3.1
    decor.add(
      street(0, CZ - reach(13.5 * f), CZ - (ringR + 2.1)), street(0, CZ + (ringR + 2.1), CZ + reach(14 * f) - 1.5),
      streetX(CZ, ringR + 2.1, reach(14.5 * f) - 0.4), streetX(CZ, -reach(14.5 * f) + 0.4, -(ringR + 2.1)),
    )
    // one spoke from the plaza to the coast for each island, where its bridge starts
    for (const port of ports) {
      const edge = new THREE.Vector3(Math.sin(port.angle) * (ringR + 1.9), GROUND, CZ - Math.cos(port.angle) * (ringR + 1.9))
      decor.add(roadBetween(edge, port.coast))
      for (let r = 9 * f; r < 30 * f; r += 4) avoid.push({ x: Math.sin(port.angle) * r, z: CZ - Math.cos(port.angle) * r, w: 7, d: 7 })
    }
    const lamps = Math.round(8 * f)
    for (let i = 0; i < lamps; i++) {
      const a = (i / lamps) * Math.PI * 2 + 0.4
      if (ports.some((p) => Math.abs(wrapAngle(a - p.angle)) < 0.3 / f)) continue
      decor.add(lamp(Math.sin(a) * (ringR + 2.9), CZ - Math.cos(a) * (ringR + 2.9), Math.sin(a)))
    }
    decor.add(bench(-6.0 * f, CZ - 8.2 * f, 0.6), bench(6.0 * f, CZ + 7.6 * f, 3.6), bench(-9.4 * f, CZ + 6.2 * f, 1.3))
    hubRoot.add(scatterNature(this.hubOutline, avoid, hashString('hub-trees'), { trees: Math.round(26 * f * f), rocks: Math.round(12 * f) }))
    return out
  }

  private hubRoutes(hubBuildings: Building[], ports: Port[]): Route[] {
    const routes: Route[] = []
    const ringR = this.hubGeo.ringR
    const ringPoint = (a: number) => new THREE.Vector3(Math.sin(a) * ringR, GROUND, 2 - Math.cos(a) * ringR)
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
    // everything that never changes goes in here, and is merged into a few meshes once the island is built
    const decor = new THREE.Group()
    root.add(decor)

    const { rows, rowRoadZ } = plan
    const edge = COL_X + PAD_W / 2 + 0.4
    const gateZ = coastScan(outline, 'z') - 0.6
    const harbourRow = Math.floor((rows - 1) / 2)
    const harbourZ = rowRoadZ[harbourRow]
    const harbourCoast = coastScan(outline, 'x', harbourZ)
    const avoid: Rect[] = []

    // Roads: one spine from the gate, and a road in front of every row of pads, with a junction where they meet.
    const half = ROAD_W / 2
    decor.add(street(0, rowRoadZ[0] + half, gateZ + 0.2))
    for (let r = 0; r < rows; r++) {
      const z = rowRoadZ[r]
      decor.add(junction(0, z, r === rows - 1))
      if (r < rows - 1) decor.add(street(0, rowRoadZ[r + 1] + half, z - half))
      // no pavement on the pad side: that edge is the service lane, where cars pull in
      decor.add(streetX(z, -edge, -half, [-1]))
      decor.add(streetX(z, half, r === harbourRow ? harbourCoast - 8.3 : edge, [-1]))
      avoid.push({ x: 0, z, w: 2 * edge + 2, d: 2 * CURB + 1 })
      // keep the lawn between rows clear of trees, so the front of every building stays in view
      if (r < rows - 1) {
        const back = z - CURB - PAD_D, next = rowRoadZ[r + 1] + CURB
        avoid.push({ x: 0, z: (back + next) / 2, w: 2 * edge + 2, d: back - next })
      }
    }
    avoid.push({ x: 0, z: (gateZ + rowRoadZ[rows - 1]) / 2, w: 7, d: gateZ - rowRoadZ[rows - 1] + 4 })

    const buildings = new Map<string, Building>()
    for (const pad of plan.pads) {
      const roadZ = rowRoadZ[pad.row]
      const zf = roadZ - CURB
      const cx = (pad.col === 0 ? -1 : 1) * COL_X
      decor.add(blockPad(cx, zf - PAD_D, zf, PAD_W))
      // the service lane in front of the pad: where cars pull in, wait their turn and are served
      const out = pad.col === 0 ? -1 : 1
      const laneFrom = out * 3.0, laneTo = cx + out * (PAD_W / 2 + 0.4)
      decor.add(serviceLane((laneFrom + laneTo) / 2, roadZ - LANE_Z, Math.abs(laneTo - laneFrom), CURB - 2.1 - 0.7))
      avoid.push({ x: cx, z: zf - PAD_D / 2, w: PAD_W + 1, d: PAD_D + 1 })
      for (const side of [-1, 1]) decor.add(lamp(cx + side * (PAD_W / 2 - 3.4), zf + 0.45, 0, -Math.PI / 2))
    }
    for (const p of plan.placed) {
      const b = new Building(p.node.id, p.node.kind, g.color)
      b.root.position.set(p.x, GROUND + 0.08, p.z)
      root.add(b.root)
      this.buildings.set(p.node.id, b)
      buildings.set(p.node.id, b)
      const zf = p.roadZ - CURB
      // a little garden in front of each building and the odd bit of street furniture
      decor.add(prop('bush', p.x - 2.2, zf - 0.9, 0, 2.2), prop('bush', p.x + 2.8, zf - 0.9, 0, 1.8))
      if (p.node.kind === 'Worker') decor.add(prop('dumpster', p.x + 2.4, p.z - 3.6, 0.2))
      if (p.node.kind === 'Api') decor.add(prop('firehydrant', p.x + 2.9, zf + 0.5, 0, 2.4))
    }
    // a spare cell in the grid becomes a small park
    if (plan.pads.length % 2 === 1) {
      const row = rows - 1
      const zf = rowRoadZ[row] - CURB
      decor.add(...parkProps(COL_X, zf - PAD_D / 2))
      avoid.push({ x: COL_X, z: zf - PAD_D / 2, w: PAD_W + 1, d: PAD_D + 1 })
    }

    // the island's sign: one post, standing on land beside the gate
    const signZ = gateZ - 2.4
    decor.add(this.islandSign(g, -8.5, signZ))
    avoid.push({ x: -8.5, z: signZ, w: 12, d: 5 })
    // A pillar whose registry file is broken: the island stays on the map, empty, with the problem written on a board
    if (g.configError) decor.add(this.configErrorBoard(g.configError))
    // Lost & found: a heap of boxes and bins by the gate, for the systems nobody has claimed
    if (g.isLostFound) {
      const pile: [Parameters<typeof prop>[0], number, number, number, number][] = [
        ['box_A', 7.5, signZ + 0.4, 0.3, 9], ['box_B', 10.5, signZ - 0.5, 1.1, 8], ['box_A', 9, signZ + 2.4, 2.0, 7],
        ['box_B', 13, signZ + 0.8, 0.6, 7.5], ['trash_A', 15.2, signZ - 0.6, 0, 6], ['dumpster', 12, signZ - 3.2, 0.1, 5],
      ]
      for (const [name, x, z, rot, scale] of pile) decor.add(prop(name, x, z, rot, scale))
      avoid.push({ x: 11, z: signZ, w: 10, d: 7 })
    }
    // the island's own harbour on the east coast, at the end of a road
    decor.add(this.harbour(harbourCoast, harbourZ))
    const status = new HarbourStatus(harbourCoast, harbourZ)
    root.add(status.group)
    avoid.push({ x: harbourCoast - 4, z: harbourZ - 2, w: 13, d: 16 })

    const trees = Math.min(110, Math.round(40 * (plan.rx * plan.rz) / (24 * 20)))
    root.add(scatterNature(outline, avoid, hashString(g.id + '-nature'), { trees, rocks: Math.round(trees / 3) }))
    mergeStatic(decor)
    root.updateMatrixWorld(true)
    return { group: g, root, outline, buildings, harbour: status, messaging: messagingOf([]) }
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
    const c2 = kit('box_A')
    c2.scale.setScalar(2.4)
    c2.position.set(coastX - 3.2, GROUND + 0.05, z - 1.8)
    g.add(quay, house, p, c2, lamp(coastX - 2.6, z - 2.6, 1), cyl(0.16, 0.2, 0.8, flat(palette.woodDark), { x: coastX - 1.6, y: GROUND, z: z + 1.9 }, 8))
    return g
  }

  /** A big warning board in the middle of an island whose registry file could not be used, saying what is wrong. */
  private configErrorBoard(message: string): THREE.Group {
    const lines = wrapText(message, 30).slice(0, 7)
    const tex = canvasTexture(512, 320, (ctx) => {
      ctx.fillStyle = '#fff4d6'; roundRect(ctx, 4, 4, 504, 312, 26); ctx.fill()
      ctx.strokeStyle = '#d63a2f'; ctx.lineWidth = 10; ctx.stroke()
      ctx.fillStyle = '#d63a2f'; ctx.fillRect(14, 14, 484, 62)
      ctx.fillStyle = '#fff'; ctx.font = '800 44px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('CONFIG ERROR', 256, 46)
      ctx.fillStyle = '#26364f'; ctx.font = '600 25px system-ui, sans-serif'; ctx.textAlign = 'left'
      lines.forEach((l, i) => ctx.fillText(l, 28, 108 + i * 31, 460))
    })
    const g = new THREE.Group()
    const face = new THREE.Mesh(new THREE.PlaneGeometry(9, 5.625), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide }))
    face.position.y = 4.6
    const postMat = new THREE.MeshStandardMaterial({ color: palette.woodDark, flatShading: true })
    for (const x of [-3.6, 3.6]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 4.4, 7), postMat)
      post.position.set(x, 2.2, -0.1)
      g.add(post)
    }
    g.add(face)
    g.position.set(0, GROUND, -4)
    g.userData.configError = true
    return g
  }

  /** One thick post with a board on it, standing on the ground. */
  private islandSign(g: GroupSnapshot, x: number, z: number): THREE.Group {
    const tex = canvasTexture(512, 128, (ctx) => {
      ctx.fillStyle = '#f7f0df'; roundRect(ctx, 4, 4, 504, 120, 22); ctx.fill()
      ctx.fillStyle = g.color; ctx.fillRect(4, 4, 504, 22)
      ctx.fillStyle = '#26364f'; ctx.font = '800 68px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(g.displayName.toUpperCase(), 256, 74, 480)
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
    sign.scale.setScalar(1.9) // big enough to read from the usual camera distance
    return sign
  }

  // ── routes ──────────────────────────────────────────────────────────────

  /** A wooden quay on the hub's coast where boats leave for one island. Returns the water point at its tip. */
  private hubQuay(angle: number): THREE.Vector3 {
    const dir = new THREE.Vector3(Math.sin(angle), 0, -Math.cos(angle))
    const coast = coastPoint(this.hubOutline, dir, 1.6)
    const p = pier(QUAY)
    p.position.copy(coast).setY(0)
    p.rotation.y = Math.atan2(dir.x, dir.z)
    const c = crates()
    c.position.set(coast.x - dir.x * 1.2 - dir.z * 1.6, 0, coast.z - dir.z * 1.2 + dir.x * 1.6)
    c.rotation.y = p.rotation.y
    this.hubDecor.add(p, c)
    return coast.clone().addScaledVector(dir, QUAY + 3).setY(0)
  }

  /** The open water beside an island's harbour pier, in world coordinates. */
  private harbourWater(island: Island, plan: Plan): THREE.Vector3 {
    const harbourZ = plan.rowRoadZ[Math.floor((plan.rows - 1) / 2)]
    const coast = coastScan(island.outline, 'x', harbourZ)
    return island.root.localToWorld(new THREE.Vector3(coast + 7, 0, harbourZ + 3.6)).setY(0)
  }

  /** The sea lane from a hub quay to an island's harbour, sailed there and back. */
  private boatRoute(island: Island, path: THREE.Vector3[], hubBuildings: Building[]): BoatRoute {
    const broker = hubBuildings.find((b) => b.kind === 'Broker')
    const workers = [...island.buildings.values()].filter((b) => b.kind === 'Worker')
    return {
      path,
      rate: () => {
        const bn = broker?.node
        if (!bn || (bn.state !== 'Healthy' && bn.state !== 'Degraded')) return 0
        const rps = workers.reduce((a, w) => a + (w.node && w.node.state !== 'Stale' && w.node.state !== 'Down' ? w.node.requestsPerSecond : 0), 0)
        return rps <= 0 ? 0 : 0.016 * Math.sqrt(rps)
      },
      speed: () => (broker?.node ? speedFactor(broker.node.p99Ms, broker.node.slaP99Ms) : 1),
      load: () => Math.log10(1 + island.messaging.perSecond) / 2.5,
    }
  }

  private islandRoutes(island: Island, plan: Plan, angle: number, hubCoast: THREE.Vector3, gate: THREE.Vector3): Route[] {
    const routes: Route[] = []
    const w = (x: number, z: number) => island.root.localToWorld(new THREE.Vector3(x, GROUND, z))
    const ringR = this.hubGeo.ringR
    const ringAt = (a: number) => new THREE.Vector3(Math.sin(a) * ringR, GROUND, 2 - Math.cos(a) * ringR)
    const fromRing = [ringAt(angle - 0.4), ringAt(angle - 0.2), ringAt(angle), hubCoast.clone().setY(GROUND), gate]
    // Where a car turns off the road for a destination, and the service lane it then waits in: first slot at
    // the door, the others behind it toward the spine.
    const toDest = (dest: Placed, head: THREE.Vector3[], startX: number | null): Pick<Route, 'path' | 'bay'> | null => {
      const out = dest.pad.col === 0 ? -1 : 1
      const slot = (k: number) => w(dest.x - out * QUEUE_GAP * k, dest.roadZ - LANE_Z)
      // five cars wait where the lane is long enough, three beside the spine
      const n = Math.max(3, Math.min(LANE_SLOTS, Math.floor((Math.abs(dest.x) - 5) / QUEUE_GAP) + 1))
      const tailX = dest.x - out * ((n - 1) * QUEUE_GAP)
      let mergeX = tailX - out * 3.6
      if (Math.abs(mergeX) < 2.8) mergeX = out * 2.8
      if (startX !== null) {
        if ((tailX - startX) * out < 1.5) return null // the caller stands past the lane's far end: it cannot get there
        if ((mergeX - startX) * out < 0.5) mergeX = startX + out * 0.5
      }
      return { path: [...head, w(mergeX, dest.roadZ)], bay: { drive: Array.from({ length: n }, (_, i) => slot(n - 1 - i)), slots: n, marker: slot(1) } }
    }

    for (const dest of plan.placed) {
      const b = island.buildings.get(dest.node.id)!
      if (dest.node.kind === 'Worker' || dest.node.kind === 'Cron' || dest.node.kind === 'Broker') continue
      const external = dest.node.external
      // Callers from other islands arrive through the gate house, over the bridge and up the spine.
      const inbound = toDest(dest, [...fromRing, w(0, dest.roadZ)], null)!
      routes.push({ dest: b, origin: external ? 'external' : 'internal', share: external ? 0.85 : dest.node.kind === 'Api' ? 0.35 : 0.08, ...inbound })
      // Systems on the same island that declare a call to it drive over from their own doors. Without a declared
      // caller there is no such traffic. The callee's rate is shared evenly between its callers until a source reports each link's own rate.
      const callers = plan.placed.filter((s) => s !== dest && s.node.calls.includes(dest.node.id))
      callers.forEach((from) => {
        const share = (external ? 0.15 : dest.node.kind === 'Api' ? 0.65 : 0.92) / callers.length
        const head = from.roadZ !== dest.roadZ ? [w(from.x, from.roadZ), w(0, from.roadZ), w(0, dest.roadZ)] : [w(from.x, from.roadZ)]
        const same = from.roadZ === dest.roadZ && from.pad.col === dest.pad.col
        const r = toDest(dest, head, same ? from.x : null)
        if (r) routes.push({ dest: b, origin: 'internal', share, ...r })
      })
    }
    return routes
  }

  /** What the camera should look at to show one building: its place in the world and how far back to stand. */
  focusOf(id: string): { target: THREE.Vector3; distance: number } | null {
    const b = this.buildings.get(id)
    if (!b) return null
    b.root.updateWorldMatrix(true, false)
    return { target: b.root.getWorldPosition(new THREE.Vector3()).setY(2), distance: 46 }
  }

  /** The same for a whole island, standing back far enough to show it. */
  islandFocusOf(groupId: string): { target: THREE.Vector3; distance: number } | null {
    const isl = this.islands.find((i) => i.group.id === groupId)
    if (!isl) return null
    let reach = 0
    for (const p of isl.outline.points) reach = Math.max(reach, Math.hypot(p.x, p.y))
    return { target: isl.root.getWorldPosition(new THREE.Vector3()).setY(0), distance: reach * 2.1 }
  }

  /** Marks one building as selected, so its name board stays visible. */
  select(id: string | null): void {
    for (const b of this.buildings.values()) b.pinned = b.id === id
  }

  node(id: string): NodeSnapshot | null {
    return this.buildings.get(id)?.node ?? null
  }
}

/** Breaks text into lines of at most `width` characters at word boundaries; a word longer than a line is cut. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    let word = raw
    while (word.length > width) {
      if (line) { lines.push(line); line = '' }
      lines.push(word.slice(0, width))
      word = word.slice(width)
    }
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word }
    else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
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
  return `${s.townId}|${s.groups.map((g) => `${g.id}${g.configError ? '!' : ''}:${g.nodes.map((n) => `${n.id}/${n.kind}/${n.service ?? ''}/${n.calls.join('+')}`).join(',')}`).join(';')}`
}

/** Where a straight line from the hub's centre leaves the hub's coast (inset a little). */
function laneLength(p: THREE.Vector3[]): number {
  let l = 0
  for (let i = 1; i < p.length; i++) l += p[i].distanceTo(p[i - 1])
  return l
}

function coastPoint(outline: Outline, dir: THREE.Vector3, inset: number): THREE.Vector3 {
  let lo = 0, hi = 140
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (outline.contains(dir.x * mid, dir.z * mid)) lo = mid
    else hi = mid
  }
  return new THREE.Vector3(dir.x * (lo - inset), GROUND, dir.z * (lo - inset))
}
