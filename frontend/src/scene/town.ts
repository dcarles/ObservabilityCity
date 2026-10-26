import * as THREE from 'three'
import { Building, type BuildingStatus } from '../buildings/building'
import { box, canvasTexture, cyl, flat, group, roundRect } from '../buildings/mk'
import { kit } from '../assets/kit'
import type { GroupSnapshot, NodeSnapshot, Snapshot } from '../types'
import { palette } from '../themes/active'
import { blockPad, bench, bridge, crates, fountain, junction, lamp, pier, prop, ring, roadBetween, ROAD_W, serviceLane, street, streetX } from './props'
import { buildIslandBody, GROUND, makeOutline, scatterNature, type Outline, type Rect } from './island'
import { COL_X, CURB, LANE_Z, PAD_D, PAD_W, coastScan, planIsland, type Placed, type Plan } from './plan'
import { hashString } from './random'
import { clamp, speedFactor } from '../visuals'
import { CarSystem, type Route } from './cars'
import { BoatSystem, type BoatRoute } from './boats'
import { consumersOf, HarbourStatus, messagingOf, type Messaging } from './harbour'
import { Lighthouse } from './lighthouse'
import { connectorsOf, portSummary, type Connectors, type PortSummary } from './links'
import { findLane, type SeaMap } from './sea'
import { mergeStatic } from './merge'
import { bayTo } from './bay'
import { islandSign } from './sign'
import { backBridgeClear, hubGeometry, layoutTown, loopArc, placeVendorsOnRing, ringRoadRadius, wrapAngle, type Disc, type HubGeometry, type VendorSpec } from './layout'
import { Weather, type SkyStatus } from './weather'
import { Airport, type AirportStatus } from './airport'
import { VendorIsland, VENDOR_COLOR } from './vendors'
import { DependencyOverlay } from './overlay'
import { ServiceSign, summariseService, type ServiceSummary } from './service'
import type { TenantView } from '../tenants'
import { DEFAULT_LAYERS, buildingShown, type LayerState } from '../layers'
import { edgeKey, edgeLinks, edgeMode, signLines, type EdgeMode } from '../edgeTraffic'
import { Signpost } from './signpost'
import { portSignText } from '../portSign'

const QUAY = 9
/** Traffic that crosses the hub drives a long way, so fewer cars are drawn for it than a short trip would need. */
const REMOTE_TRAFFIC = 0.5

/** Where an island's road leaves the hub: the direction it lies in and the point on the hub's coast. */
interface Port {
  angle: number
  coast: THREE.Vector3
}

/** Where an island meets its bridge: the gate house on the island and the hub end of the bridge. */
interface Gate {
  /** False for an island with no bridge: its gate point exists, but nothing is built there and no car crosses it. */
  bridged: boolean
  island: Island
  plan: Plan
  gate: THREE.Vector3
  coast: THREE.Vector3
  angle: number
}

interface Island {
  group: GroupSnapshot
  root: THREE.Group
  outline: Outline
  buildings: Map<string, Building>
  /** Null for an island with no messaging: it has no pier. */
  harbour: HarbourStatus | null
  links: Connectors
  /** Ids of the workers that consume a topic. */
  consumers: Set<string>
  messaging: Messaging
  weather: Weather
  /** Island-local z of the back gate, where the road to a third party's bridge leaves. Null for an island with no third party to reach. */
  backGateZ: number | null
  /** The sign and hedge of every service pad, by the pad's key. */
  services: Map<string, ServiceSign>
  /** The signpost to hidden islands, for a town whose islands call each other directly. Null where the island has no link to a hidden island. */
  signpost: Signpost | null
  /** Ids of the systems standing on the island. */
  nodeIds: Set<string>
}

/** An island's road to one third party: out of its back gate, over its bridge to the ring road, round the loop and down the vendor's spur. */
interface VendorLink {
  group: number
  vendor: VendorIsland
  /** Ids of the systems on that island that call the vendor. */
  callers: string[]
  /** How many islands have a road to this vendor. The vendor's traffic is shared between them. */
  of: number
  /** Direction of the island and of the vendor from the hub, where each one's road meets the ring road. */
  islandAngle: number
  vendorAngle: number
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
  /** The hub's message broker by name (Service Bus, Kafka, ...), for the port's board. */
  private brokerName: string | null = null
  private lighthouse: Lighthouse | null = null
  private port: PortSummary = { topics: 0, subscriptions: 0, piers: 0, legacy: 0 }
  /** The islands that have a sea lane for boats, and how many car routes cross each one's bridge. */
  private readonly boatLanes = new Set<string>()
  private readonly crossings = new Map<string, number>()
  private hubWeather: Weather | null = null
  /** Third parties on their own small islands, by vendor id. */
  readonly vendors = new Map<string, VendorIsland>()
  airport: Airport | null = null
  readonly overlay = new DependencyOverlay()
  /** The road a taxi takes from the airport terminal to the plaza, in world coordinates; null when the airport has no bridge. */
  private airportPath: THREE.Vector3[] | null = null
  /** The angle on the plaza's ring road where that road joins it. */
  private airportJoin = 0
  /** How many bridges reach each third party. */
  private readonly vendorBridges = new Map<string, number>()
  /** The tenant filter the buildings and cars follow. */
  private tenantView: TenantView | null = null
  /** Which layers are drawn. */
  private layers: LayerState = DEFAULT_LAYERS
  /** How traffic to and from islands the filter hides is shown, and which systems have such traffic. */
  private edge: { mode: EdgeMode; out: Set<string>; in: Set<string> } = { mode: 'plaza', out: new Set(), in: new Set() }

  constructor() {
    this.root.add(this.cars.object, this.boats.object, this.overlay.object)
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

    // Islands stand round the hub in registry order, `ringCapacity` to a ring and the rest in a staggered second ring, with the airport
    // in the second ring's northernmost place. The hub grows with their number, so every spoke road has room where it leaves the plaza.
    const airport = new Airport()
    const plans = pillars.map((g) => planIsland(g))
    const layout = layoutTown(plans.map((p) => ({ rx: p.rx, rz: p.rz })), s.ringCapacity, { rx: airport.rx, rz: airport.rz })
    this.hubGeo = layout.hub
    const airportPlace = layout.airport!
    // pillars first, then the airport: one entry for everything that has a spoke to the hub
    const places = [...layout.islands, airportPlace]
    const angles = places.map((i) => i.angle)
    const ports = places.map((i) => i.portAngle)
    const dirOf = (a: number) => new THREE.Vector3(Math.sin(a), 0, -Math.cos(a))

    // ── Third parties are planned first: the islands need to know which of them get a back gate ──
    this.vendors.clear()
    this.vendorBridges.clear()
    this.boatLanes.clear()
    this.crossings.clear()
    const connectors = pillars.map((g) => connectorsOf(g))
    this.port = portSummary(s.groups)
    const links = edgeLinks(s)
    this.edge = { mode: edgeMode(s), out: new Set(links.filter((l) => !l.incoming).map((l) => l.nodeId)), in: new Set(links.filter((l) => l.incoming).map((l) => l.nodeId)) }
    this.airport = null
    this.airportPath = null
    const centres = places.map((l) => dirOf(l.angle).multiplyScalar(l.radius))
    const discs: Disc[] = pillars.map((g, i) => ({ id: g.id, x: centres[i].x, z: centres[i].z, r: Math.max(plans[i].rx, plans[i].rz) * 0.95 + 3 }))
    const airportDisc: Disc = { id: 'airport', x: centres[pillars.length].x, z: centres[pillars.length].z, r: Math.max(airport.rx, airport.rz) * 0.95 + 3 }
    const groupOfNode = new Map(s.groups.flatMap((g) => g.nodes.map((n) => [n.id, g.id] as const)))
    const vendorIslands = s.vendors.map((v) => new VendorIsland(v.node.id, v.node.name, v.node))
    const order = pillars.map((g) => g.id)
    const callerIslands = (calledBy: string[]) => [...new Set(calledBy.map((id) => groupOfNode.get(id)).filter((g): g is string => !!g && g !== 'hub' && order.includes(g)))]
    const loopR = vendorIslands.length > 0 ? ringRoadRadius([...discs, airportDisc]) : 0
    const specs: VendorSpec[] = s.vendors.map((v, i) => ({
      id: v.node.id,
      callerAngles: callerIslands(v.calledBy).map((g) => angles[order.indexOf(g)]),
      front: vendorIslands[i].gateZ,
    }))
    const spots = placeVendorsOnRing(loopR, specs)
    // an island that calls a third party gets a back gate and a bridge to the ring road, unless a neighbour stands in the way
    const bridgedIslands = new Set<string>()
    for (const v of s.vendors) {
      for (const g of callerIslands(v.calledBy)) {
        const i = order.indexOf(g)
        if (bridgedIslands.has(g)) continue
        const back = coastScan(makeOutline(hashString(g), plans[i].rx, plans[i].rz, 0.06), '-z') - 0.7
        if (backBridgeClear(discs[i], back, [...discs, airportDisc], loopR)) bridgedIslands.add(g)
      }
    }

    // ── Hub ────────────────────────────────────────────────────────────────
    const hubRoot = new THREE.Group()
    this.hubOutline = makeOutline(hashString('hub'), this.hubGeo.rx, this.hubGeo.rz, 0.05)
    hubRoot.add(buildIslandBody(this.hubOutline))
    this.hubWeather = new Weather('hub', this.hubGeo.rx, this.hubGeo.rz, new THREE.Vector3(0, 0, 2))
    hubRoot.add(this.hubWeather.object)
    const hubCoasts = ports.map((a) => coastPoint(this.hubOutline, dirOf(a), 0.9))
    // a spoke road from the plaza only for an island that has a bridge (and for the airport, which always has one)
    const hubPorts = ports.map((a, i) => ({ angle: a, coast: hubCoasts[i] })).filter((_p, i) => i === pillars.length || connectors[i].bridge)
    const hubBuildings = this.buildHub(hubRoot, hub, hubPorts)
    this.root.add(hubRoot)
    this.expandBounds(this.hubOutline, new THREE.Vector3(), 0)
    const broker = hubBuildings.find((b) => b.kind === 'Broker')
    this.brokerName = broker?.node?.name ?? null
    this.hubBoard = null
    this.lighthouse?.set(0)
    if (broker) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTexture(400, 130, () => {}), transparent: true, depthTest: false, toneMapped: false }))
      sprite.renderOrder = 10
      sprite.scale.set(4.4, 1.43, 1)
      sprite.position.copy(broker.root.position).add(new THREE.Vector3(0, 8.4, 0))
      hubRoot.add(sprite)
      this.hubBoard = { sprite, key: '' }
    }

    // ── Islands ──────────────────────────────────────────────────────────────
    const bridgeDecor = new THREE.Group()
    this.root.add(bridgeDecor)
    const gates: Gate[] = []
    pillars.forEach((g, index) => {
      const plan = plans[index]
      const center = centres[index].clone()
      const island = this.buildIsland(g, plan, center, bridgedIslands.has(g.id), connectors[index], this.edge.mode === 'signpost' && links.some((l) => g.nodes.some((n) => n.id === l.nodeId)))
      this.islands.push(island)
      this.root.add(island.root)
      this.expandBounds(island.outline, center, island.root.rotation.y, 12)

      const gate = island.root.localToWorld(new THREE.Vector3(0, GROUND, coastScan(island.outline, 'z') - 0.7))
      if (connectors[index].bridge) {
        bridgeDecor.add(bridge({ from: hubCoasts[index].clone().setY(0), to: gate.clone().setY(0) }))
        bridges.push([new THREE.Vector2(hubCoasts[index].x, hubCoasts[index].z), new THREE.Vector2(gate.x, gate.z)])
      }
      gates.push({ bridged: connectors[index].bridge, island, plan, gate, coast: hubCoasts[index].clone().setY(GROUND), angle: ports[index] })
    })

    // ── The ring road outside every island, a bridge to it from each calling island's back gate, and the third parties on spurs beyond it ──
    this.root.updateMatrixWorld(true)
    const vendorLinks: VendorLink[] = []
    const backGate = (id: string) => {
      const isl = this.islands[order.indexOf(id)]
      return isl.root.localToWorld(new THREE.Vector3(0, GROUND, isl.backGateZ!))
    }
    const loopPoint = (a: number) => dirOf(a).multiplyScalar(loopR)
    const landed = new Set<string>() // islands whose bridge to the ring road is already built
    spots.forEach((spot, i) => {
      const vi = vendorIslands[i]
      const vendor = s.vendors[i]
      vi.root.position.set(spot.x, 0, spot.z)
      vi.root.rotation.y = Math.atan2(spot.loopX - spot.x, spot.loopZ - spot.z) // local +z faces the ring road
      this.root.add(vi.root)
      vi.root.updateMatrixWorld(true)
      this.expandBounds(vi.outline, vi.root.position, vi.root.rotation.y, 12)
      this.vendors.set(vendor.node.id, vi)
      this.buildings.set(vendor.node.id, vi.building)
      const gate = vi.gate()
      bridgeDecor.add(bridge({ from: new THREE.Vector3(spot.loopX, 0, spot.loopZ), to: gate.clone().setY(0) }))
      bridges.push([new THREE.Vector2(spot.loopX, spot.loopZ), new THREE.Vector2(gate.x, gate.z)])
      const links = callerIslands(vendor.calledBy).filter((g) => bridgedIslands.has(g))
      this.vendorBridges.set(vendor.node.id, links.length)
      for (const id of links) {
        const index = order.indexOf(id)
        const back = backGate(id)
        const land = loopPoint(angles[index])
        if (!landed.has(id)) {
          landed.add(id)
          bridgeDecor.add(bridge({ from: back.clone().setY(0), to: land.clone().setY(0) }))
          bridges.push([new THREE.Vector2(back.x, back.z), new THREE.Vector2(land.x, land.z)])
        }
        vendorLinks.push({ group: index, vendor: vi, callers: vendor.calledBy.filter((c) => groupOfNode.get(c) === id), of: links.length, islandAngle: angles[index], vendorAngle: spot.angle })
      }
    })
    if (spots.length > 0) {
      // the ring road is one causeway all the way round, built in short pieces
      const pieces = Math.max(24, Math.ceil((2 * Math.PI * loopR) / 36))
      for (let k = 0; k < pieces; k++) {
        const a0 = (k / pieces) * Math.PI * 2, a1 = ((k + 1) / pieces) * Math.PI * 2
        bridgeDecor.add(bridge({ from: loopPoint(a0).setY(0), to: loopPoint(a1).setY(0), ends: false }))
      }
      for (let k = 0; k < 72; k++) {
        const p = dirOf((k / 72) * Math.PI * 2).multiplyScalar(loopR + 14)
        this.bounds.expandByPoint(p)
        this.extent.push(p)
      }
    }

    // ── The airport: an island in the second ring, due north, with a spoke to the hub like any other ──
    this.airport = airport
    const airportCentre = centres[pillars.length]
    airport.root.position.copy(airportCentre)
    airport.root.rotation.y = Math.atan2(-airportCentre.x, -airportCentre.z)
    this.root.add(airport.root)
    airport.root.updateMatrixWorld(true)
    this.expandBounds(airport.outline, airport.root.position, airport.root.rotation.y, 12)
    {
      const gate = airport.gate()
      const coast = hubCoasts[pillars.length].clone().setY(0)
      bridgeDecor.add(bridge({ from: coast, to: gate.clone().setY(0) }))
      bridges.push([new THREE.Vector2(coast.x, coast.z), new THREE.Vector2(gate.x, gate.z)])
      this.airportPath = [airport.doorWorld(), gate.setY(GROUND), coast.clone().setY(GROUND)]
      this.airportJoin = ports[pillars.length]
    }

    // ── Sea lanes: boats sail from a hub quay in the gap beside each bridge to the island's harbour ──
    this.root.updateMatrixWorld(true)
    const land = [this.hubOutline.points.map((p) => new THREE.Vector2(p.x, p.y))]
    for (const isl of this.islands) land.push(isl.outline.points.map((p) => {
      const w = isl.root.localToWorld(new THREE.Vector3(p.x, 0, p.y))
      return new THREE.Vector2(w.x, w.z)
    }))
    for (const vi of this.vendors.values()) land.push(vi.outline.points.map((p) => {
      const w = vi.root.localToWorld(new THREE.Vector3(p.x, 0, p.y))
      return new THREE.Vector2(w.x, w.z)
    }))
    land.push(airport.outline.points.map((p) => {
      const w = airport.root.localToWorld(new THREE.Vector3(p.x, 0, p.y))
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
      if (!connectors[index].pier) return // boats sail only to a pier
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
      this.boatLanes.add(this.islands[index].group.id)
    })

    mergeStatic(bridgeDecor)
    mergeStatic(this.hubDecor)
    // Cars always start at a building's front and cross the bridges to get where they are going.
    this.root.updateMatrixWorld(true)
    const gateway = hubBuildings.find((b) => b.kind === 'Gateway')
    gates.forEach((_g, index) => routes.push(...this.islandRoutes(index, gates, gateway)))
    for (const link of vendorLinks) routes.push(...this.vendorRoutes(link, gates, loopR))
    routes.push(...this.hubRoutes(hubBuildings, gates.filter((g) => g.bridged)))
    routes.push(...this.edgeRoutes(s, gates, gateway))
    this.cars.setRoutes(routes)
    this.boats.setRoutes(boatRoutes)
    const anchors = new Map<string, { at: THREE.Vector3; color: string }>([['hub', { at: new THREE.Vector3(0, 0, 0), color: hub?.color ?? palette.flagFallback }]])
    this.islands.forEach((isl) => anchors.set(isl.group.id, { at: isl.root.position.clone(), color: isl.group.color }))
    for (const [id, vi] of this.vendors) anchors.set(id, { at: vi.root.position.clone(), color: VENDOR_COLOR })
    this.overlay.setAnchors(anchors)
    this.snapshotId = layoutKey(s)
    if (this.tenantView) this.setTenantView(this.tenantView)
    this.setLayers(this.layers)
  }

  /** The words on the broker port: what the broker building's own sign says (its model is built knowing the broker's name). */
  private brokerSign(): string {
    const broker = [...this.buildings.values()].find((b) => b.kind === 'Broker')
    return broker?.model.signText ?? portSignText(this.brokerName)
  }

  /** The message broker port's board: how many topics and subscriptions the town has, and how many piers they reach. */
  private updateHubBoard(camera: THREE.Camera): void {
    const hb = this.hubBoard
    if (!hb) return
    const p = this.port
    const key = `${p.topics}|${p.subscriptions}|${p.piers}|${p.legacy}`
    const d = camera.position.distanceTo(hb.sprite.getWorldPosition(new THREE.Vector3()))
    const opacity = 1 - clamp((d - 70) / 40, 0, 1)
    ;(hb.sprite.material as THREE.SpriteMaterial).opacity = opacity
    hb.sprite.visible = opacity > 0.02 && this.layers.messaging
    if (key === hb.key) return
    hb.key = key
    const tex = (hb.sprite.material as THREE.SpriteMaterial).map as THREE.CanvasTexture
    const ctx = (tex.image as HTMLCanvasElement).getContext('2d')!
    ctx.clearRect(0, 0, 400, 130)
    ctx.fillStyle = 'rgba(20,28,40,0.92)'; roundRect(ctx, 4, 6, 392, 118, 24); ctx.fill()
    ctx.strokeStyle = p.legacy > 0 ? '#ffb830' : '#9fb4cc'; ctx.lineWidth = 6; ctx.stroke()
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillStyle = '#fff'; ctx.font = '800 32px system-ui, sans-serif'
    ctx.fillText(this.brokerSign(), 200, 38, 370)
    ctx.fillStyle = '#b8c7da'; ctx.font = '700 26px system-ui, sans-serif'
    ctx.fillText(`${p.topics} topics · ${p.subscriptions} subscriptions`, 200, 72, 370)
    ctx.fillStyle = p.legacy > 0 ? '#ffb830' : '#b8c7da'
    ctx.fillText(`${p.piers} pier${p.piers === 1 ? '' : 's'}${p.legacy > 0 ? ` · ${p.legacy} legacy` : ''}`, 200, 102, 370)
    tex.needsUpdate = true
  }

  /** Feed a snapshot into the existing buildings. */
  apply(s: Snapshot): void {
    // One building that cannot take its numbers must not stop the others from taking theirs.
    for (const g of s.groups) for (const n of g.nodes) this.guard(`apply ${n.id}`, () => this.buildings.get(n.id)?.setNode(n))
    for (const isl of this.islands) {
      const g = s.groups.find((x) => x.id === isl.group.id)
      if (g) this.guard(`messaging ${g.id}`, () => { isl.messaging = messagingOf([...g.nodes], g.messaging) })
    }
    for (const isl of this.islands) {
      const g = s.groups.find((x) => x.id === isl.group.id)
      if (!g) continue
      const nodes = new Map(g.nodes.map((n) => [n.id, n]))
      for (const [key, sign] of isl.services) this.guard(`service ${key}`, () => sign.set(summariseService(sign.pad, g.id, g.displayName, nodes).state))
    }
    this.guard('tenants', () => this.cars.setTenants(s.tenants ?? []))
    if (this.edge.mode === 'signpost') {
      const links = edgeLinks(s)
      for (const isl of this.islands) if (isl.signpost) this.guard(`signpost ${isl.group.id}`, () => isl.signpost!.set(signLines(links, isl.nodeIds)))
    }
    // the lighthouse shows the town-wide total, the same number the snapshot's totals carry
    this.hubDeadLetters = s.totals.deadLetters
    this.lighthouse?.set(this.hubDeadLetters)
    for (const v of s.vendors) this.guard(`apply ${v.node.id}`, () => this.buildings.get(v.node.id)?.setNode(v.node))
    this.guard('airport', () => this.airport?.setCallers(s.externalCallers))
    this.guard('overlay', () => this.overlay.set(s.dependencies))
    // weather: each island's own open incidents, and nothing anywhere else
    for (const g of s.groups) {
      const sky = g.isHub ? this.hubWeather : this.islands.find((i) => i.group.id === g.id)?.weather
      if (sky) this.guard(`weather ${g.id}`, () => sky.set(g.incidents))
    }
  }

  update(dt: number, time: number, camera: THREE.Camera): void {
    for (const [id, b] of this.buildings) this.guard(`update ${id}`, () => b.update(dt, time, camera))
    for (const isl of this.islands) this.guard(`harbour ${isl.group.id}`, () => isl.harbour?.update(isl.messaging, time, camera))
    this.guard('hub board', () => this.updateHubBoard(camera))
    this.guard('lighthouse', () => this.lighthouse?.update(time, camera))
    for (const isl of this.islands) this.guard(`weather ${isl.group.id}`, () => isl.weather.update(dt, time, camera))
    this.guard('weather hub', () => this.hubWeather?.update(dt, time, camera))
    this.guard('airport', () => this.airport?.update(dt, time, camera))
    this.guard('overlay', () => this.overlay.update(dt))
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

  /**
   * What an island shows: its buildings (and their kinds), whether it has a bridge, a pier and a sea lane for boats, how many car routes cross its
   * bridge, and what the pier shows. Also whether it is a config error island. For tests.
   */
  inspectIsland(groupId: string): {
    id: string; buildings: number; kinds: string[]; configError: string | null
    bridge: boolean; pier: boolean; lane: boolean; crossings: number
    crates: number; brokenCrates: number; alarm: boolean; pennant: boolean; sky: SkyStatus
  } | null {
    const none = { kinds: [], bridge: false, pier: false, lane: false, crossings: 0, crates: 0, brokenCrates: 0, alarm: false, pennant: false }
    if (groupId === 'hub' && this.hubWeather) return { id: groupId, buildings: 0, configError: null, ...none, sky: this.hubWeather.status() }
    const isl = this.islands.find((i) => i.group.id === groupId)
    if (!isl) return null
    return {
      id: groupId, buildings: isl.buildings.size, kinds: [...isl.buildings.values()].map((b) => b.kind), configError: isl.group.configError ?? null,
      bridge: isl.links.bridge, pier: isl.harbour !== null, lane: this.boatLanes.has(groupId), crossings: this.crossings.get(groupId) ?? 0,
      ...(isl.harbour?.status() ?? { crates: 0, brokenCrates: 0, alarm: false, pennant: false }), sky: isl.weather.status(),
    }
  }

  /** Boxes over every service's sign and hedge, for picking with the pointer. Each carries `userData.serviceKey`. */
  serviceHits(): THREE.Object3D[] {
    return this.islands.flatMap((i) => [...i.services.values()].flatMap((s) => s.hits))
  }

  /** What one service is and how it is doing, from the latest snapshot. Null when no island has it. */
  serviceSummary(key: string, s: Snapshot): ServiceSummary | null {
    for (const isl of this.islands) {
      const sign = isl.services.get(key)
      const g = s.groups.find((x) => x.id === isl.group.id)
      if (sign && g) return summariseService(sign.pad, g.id, g.displayName, new Map(g.nodes.map((n) => [n.id, n])))
    }
    return null
  }

  /** The services on an island: key, name, and the state the sign shows. For tests. */
  inspectServices(groupId: string): { key: string; name: string; state: string | null; systems: string[] }[] {
    const isl = this.islands.find((i) => i.group.id === groupId)
    return isl ? [...isl.services].map(([key, sg]) => ({ key, name: sg.pad.name, state: sg.state, systems: sg.pad.nodes.map((n) => n.id) })) : []
  }

  /** Which tenants the town shows: tenant yards dim the others, and cars of hidden tenants are not drawn. */
  setTenantView(view: TenantView): void {
    this.tenantView = view
    this.cars.setTenantView(view)
    for (const b of this.buildings.values()) b.setTenantView(view)
  }

  /** What the Service Bus port and the lighthouse show: topics, subscriptions, piers, the old-route reads, and the dead-letter total. For tests. */
  inspectHub(): PortSummary & { lighthouse: { total: number; alarm: boolean } | null; boats: number; sign: { board: string; model: string | null } } {
    const broker = [...this.buildings.values()].find((b) => b.kind === 'Broker')
    return { ...this.port, lighthouse: this.lighthouse?.status() ?? null, boats: this.boatLanes.size, sign: { board: this.brokerSign(), model: broker?.model.signText ?? null } }
  }

  /** What the airport shows right now. For tests. */
  inspectAirport(): (AirportStatus & { bridge: boolean }) | null {
    return this.airport ? { ...this.airport.status(), bridge: this.airportPath !== null } : null
  }

  /** Where the third parties stand and what is bridged to them, as plain values. For tests. */
  inspectVendors(): { id: string; x: number; z: number; bridges: number }[] {
    return [...this.vendors].map(([id, vi]) => ({ id, x: vi.root.position.x, z: vi.root.position.z, bridges: this.vendorBridges.get(id) ?? 0 }))
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
    // the lighthouse stands beside the Service Bus port, just off its axis where no spoke road runs
    const lx = spots.Broker.x + 1.5, lz = CZ - 7.7
    this.lighthouse = new Lighthouse(lx, lz)
    hubRoot.add(this.lighthouse.group)
    avoid.push({ x: lx, z: lz, w: 6, d: 6 })
    const seen = new Set<string>()
    for (const n of hub?.nodes ?? []) {
      const spot = spots[n.kind]
      if (!spot || seen.has(n.kind)) {
        // the hub has one slot for each of gateway, broker, egress and database
        console.warn(`Hub resource ${n.id} has no free slot and is not drawn`)
        continue
      }
      seen.add(n.kind)
      const b = new Building(n.id, n.kind, hub?.color ?? palette.flagFallback, false, n.name)
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

  /**
   * Cars from the systems on one island to a third party: out of the caller's door, up the spine to the back gate, over the island's bridge
   * to the ring road, the short way round it, and down the vendor's spur into its lane. Nothing touches the hub or crosses another island.
   */
  private vendorRoutes(link: VendorLink, gates: Gate[], loopR: number): Route[] {
    const { island, plan } = gates[link.group]
    const callers = link.callers.map((id) => plan.placed.find((p) => p.node.id === id)).filter((p): p is Placed => !!p)
    const from = callers.find((p) => p.node.kind === 'Api') ?? callers[0]
    if (!from) return []
    const w = (x: number, z: number) => island.root.localToWorld(new THREE.Vector3(x, GROUND, z))
    const head = [w(from.x, from.roadZ)]
    if (Math.abs(from.x) > 0.5) head.push(w(0, from.roadZ))
    head.push(w(0, island.backGateZ!))
    for (const p of loopArc(loopR, link.islandAngle, link.vendorAngle, GROUND)) head.push(new THREE.Vector3(p.x, p.y, p.z))
    head.push(link.vendor.gate().setY(GROUND))
    const lane = link.vendor.into(head)
    return [{ dest: link.vendor.building, source: island.buildings.get(from.node.id)!, origin: 'internal', share: 1 / link.of, ...lane }]
  }

  private ringPoint(a: number): THREE.Vector3 {
    const ringR = this.hubGeo.ringR
    return new THREE.Vector3(Math.sin(a) * ringR, GROUND, 2 - Math.cos(a) * ringR)
  }

  /** Points round the hub's ring from one angle to another, the short way. */
  private ringArc(from: number, to: number): THREE.Vector3[] {
    const delta = wrapAngle(to - from)
    const steps = Math.max(2, Math.ceil(Math.abs(delta) / 0.25))
    return Array.from({ length: steps + 1 }, (_, i) => this.ringPoint(from + (delta * i) / steps))
  }

  /** The system on an island that calls out over the bridge: its API nearest the gate, or failing that its first building that serves requests. */
  private callerOf(plan: Plan): Placed | undefined {
    const pool = [plan.placed.filter((p) => p.node.kind === 'Api'), plan.placed.filter((p) => !['Worker', 'Cron', 'Broker'].includes(p.node.kind)), plan.placed].find((l) => l.length > 0)
    return pool?.reduce((best, p) => (p.roadZ > best.roadZ || (p.roadZ === best.roadZ && Math.abs(p.x) < Math.abs(best.x)) ? p : best))
  }

  /** From a building's front on an island, along its road and the spine, through the gate, over the bridge to the hub's coast. */
  private outbound(g: Gate, from: Placed): THREE.Vector3[] {
    const w = (x: number, z: number) => g.island.root.localToWorld(new THREE.Vector3(x, GROUND, z))
    const head = [w(from.x, from.roadZ)]
    if (Math.abs(from.x) > 0.5) head.push(w(0, from.roadZ))
    return [...head, g.gate.clone(), g.coast.clone()]
  }

  /** Callers on every island drive to a hub building: out of the caller's door, over its bridge, and round the plaza to the building's street. */
  private hubRoutes(hubBuildings: Building[], gates: Gate[]): Route[] {
    const routes: Route[] = []
    const exits: Partial<Record<Building['kind'], number>> = { Gateway: 0, Broker: Math.PI / 2, Egress: -Math.PI / 2, Database: Math.PI }
    for (const b of hubBuildings) {
      const exit = exits[b.kind]
      if (exit === undefined) continue
      const door = b.doorWorld().setY(GROUND)
      for (const g of gates) {
        const from = this.callerOf(g.plan)
        if (!from) continue // an island that failed to load has nothing to call from
        const source = g.island.buildings.get(from.node.id)!
        this.cross(g.island.group.id)
        routes.push({
          dest: b, source, origin: b.kind === 'Egress' ? 'external' : 'internal', share: 1 / gates.length,
          path: [...this.outbound(g, from), ...this.ringArc(g.angle, exit), door],
        })
      }
    }
    return routes
  }

  // ── pillar islands ──────────────────────────────────────────────────────

  private buildIsland(g: GroupSnapshot, plan: Plan, center: THREE.Vector3, backGate: boolean, links: Connectors, signpost = false): Island {
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
    if (links.bridge) decor.add(street(0, rowRoadZ[0] + half, gateZ + 0.2)) // the road to the gate only where a bridge leaves
    for (let r = 0; r < rows; r++) {
      const z = rowRoadZ[r]
      decor.add(junction(0, z, r === rows - 1 && !backGate))
      if (r < rows - 1) decor.add(street(0, rowRoadZ[r + 1] + half, z - half))
      // no pavement on the pad side: that edge is the service lane, where cars pull in
      decor.add(streetX(z, -edge, -half, [-1]))
      decor.add(streetX(z, half, r === harbourRow && links.pier ? harbourCoast - 8.3 : edge, [-1]))
      avoid.push({ x: 0, z, w: 2 * edge + 2, d: 2 * CURB + 1 })
      // keep the lawn between rows clear of trees, so the front of every building stays in view
      if (r < rows - 1) {
        const back = z - CURB - PAD_D, next = rowRoadZ[r + 1] + CURB
        avoid.push({ x: 0, z: (back + next) / 2, w: 2 * edge + 2, d: back - next })
      }
    }
    if (links.bridge) avoid.push({ x: 0, z: (gateZ + rowRoadZ[rows - 1]) / 2, w: 7, d: gateZ - rowRoadZ[rows - 1] + 4 })
    // an island that has a bridge to a third party continues its spine to the far coast
    const backZ = backGate ? -(coastScan(outline, '-z') - 0.7) : null
    if (backZ !== null) {
      decor.add(street(0, rowRoadZ[rows - 1] - half, backZ - 0.2))
      avoid.push({ x: 0, z: (rowRoadZ[rows - 1] + backZ) / 2, w: 7, d: rowRoadZ[rows - 1] - backZ + 4 })
    }

    const buildings = new Map<string, Building>()
    const services = new Map<string, ServiceSign>()
    const signSpans: { x: number; zf: number }[] = []
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
      // the service's low sign and hedge; the sign repaints with its worst state, so it is not merged into the static decor
      const sign = new ServiceSign(pad, cx, zf, PAD_D, PAD_W)
      root.add(sign.object)
      services.set(pad.key, sign)
      signSpans.push({ x: cx, zf })
    }
    for (const p of plan.placed) {
      const b = new Building(p.node.id, p.node.kind, g.color, p.node.tenants != null)
      b.root.position.set(p.x, GROUND + 0.08, p.z)
      root.add(b.root)
      this.buildings.set(p.node.id, b)
      buildings.set(p.node.id, b)
      const zf = p.roadZ - CURB
      // a little garden in front of each building and the odd bit of street furniture
      // the service sign stands at the middle of the pad's front, so a bush never grows through it
      const nearSign = (x: number) => signSpans.some((sp) => Math.abs(x - sp.x) < 2.6 && Math.abs(zf - sp.zf) < 1.5)
      for (const [bx, bs] of [[p.x - 2.2, 2.2], [p.x + 2.8, 1.8]] as const) if (!nearSign(bx)) decor.add(prop('bush', bx, zf - 0.9, 0, bs))
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
    // a town whose islands call each other directly: a signpost opposite the island's own sign, for the traffic to and from hidden islands
    let post: Signpost | null = null
    if (signpost && links.bridge) {
      post = new Signpost(8.5, signZ)
      root.add(post.object)
      avoid.push({ x: 8.5, z: signZ, w: 12, d: 5 })
    }
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
    // the island's pier on the east coast, at the end of a road: only for an island with messaging
    let status: HarbourStatus | null = null
    if (links.pier) {
      decor.add(this.harbour(harbourCoast, harbourZ))
      status = new HarbourStatus(harbourCoast, harbourZ)
      root.add(status.group)
      avoid.push({ x: harbourCoast - 4, z: harbourZ - 2, w: 13, d: 16 })
    }

    const trees = Math.min(110, Math.round(40 * (plan.rx * plan.rz) / (24 * 20)))
    root.add(scatterNature(outline, avoid, hashString(g.id + '-nature'), { trees, rocks: Math.round(trees / 3) }))
    mergeStatic(decor)
    root.updateMatrixWorld(true)
    const weather = new Weather(g.id, plan.rx, plan.rz)
    root.add(weather.object)
    return { group: g, root, outline, buildings, harbour: status, links, consumers: consumersOf(g.messaging), messaging: messagingOf([], g.messaging), weather, backGateZ: backZ, services, signpost: post, nodeIds: new Set(g.nodes.map((n) => n.id)) }
  }

  /** A quay with a pier house, a pier and crates: where the boats from the hub's Service Bus port land. */
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
      ctx.fillText('PIER', 128, 34)
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
    return islandSign(g.displayName, g.color, x, z)
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
    const workers = [...island.buildings.values()].filter((b) => b.kind === 'Worker' && island.consumers.has(b.id))
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

  /**
   * How cars reach the systems on one island. Calls from other islands cross the hub: out of the caller's door, over its bridge,
   * round the plaza and over this island's bridge. Outside callers come in at the hub's API gateway. Systems on the same island
   * that declare a call to it drive over from their own doors. No car starts anywhere else.
   */
  private islandRoutes(index: number, gates: Gate[], gateway: Building | undefined): Route[] {
    const here = gates[index]
    const { island, plan } = here
    const routes: Route[] = []
    const w = (x: number, z: number) => island.root.localToWorld(new THREE.Vector3(x, GROUND, z))
    // Where a car turns off the road for a destination, and the service lane it then waits in
    const toDest = (dest: Placed, head: THREE.Vector3[], startX: number | null) => bayTo({ x: dest.x, roadZ: dest.roadZ, col: dest.pad.col }, w, head, startX)
    /** Over this island's bridge and up the spine to a road, from a start that is already on the hub. */
    const intoIsland = (start: THREE.Vector3[], fromAngle: number, dest: Placed) => [
      ...start, ...this.ringArc(fromAngle, here.angle), here.coast.clone(), here.gate.clone(), w(0, dest.roadZ),
    ]

    for (const dest of plan.placed) {
      const b = island.buildings.get(dest.node.id)!
      if (dest.node.kind === 'Worker' || dest.node.kind === 'Cron' || dest.node.kind === 'Broker') continue
      const external = dest.node.external
      const apiShare = dest.node.kind === 'Api'
      // An island with no bridge is reached by no car from outside; only its own systems drive to each other.
      if (here.bridged) {
        // Callers on other islands: the ones that declare a call to it, else one other island picked from its name.
        const declared: { gate: number; from: Placed }[] = []
        gates.forEach((g, i) => {
          if (i === index || !g.bridged) return
          for (const p of g.plan.placed) if (p.node.calls.includes(dest.node.id) && !declared.some((d) => d.gate === i)) declared.push({ gate: i, from: p })
        })
        const remote = declared.slice(0, 3)
        // a system that is called from an island the filter hides is not called by a stand-in picked from the islands on screen
        const hiddenCaller = this.edge.in.has(dest.node.id)
        const callable = gates.map((_g, i) => i).filter((i) => i !== index && gates[i].bridged && this.callerOf(gates[i].plan))
        if (remote.length === 0 && callable.length > 0 && !hiddenCaller) {
          const other = callable[hashString(dest.node.id) % callable.length]
          remote.push({ gate: other, from: this.callerOf(gates[other].plan)! })
        }
        const remoteShare = (external ? 0.15 : apiShare ? 0.35 : 0.08) * REMOTE_TRAFFIC
        const outsideShare = external ? 0.85 : 0
        // outside callers (yellow) enter at the API gateway; without one they come from another island like the rest
        if (external && gateway) {
          // with an airport bridge they come in over it and join the ring road beside the gateway; otherwise they start at the gateway
          const exit = this.airportPath ? this.airportJoin : 0
          const head = this.airportPath ? this.airportPath.map((p) => p.clone()) : [gateway.doorWorld().setY(GROUND), this.ringPoint(exit)]
          this.cross(island.group.id)
          routes.push({ dest: b, source: this.airportPath && this.airport ? this.airport : gateway, origin: 'external', share: outsideShare, ...toDest(dest, intoIsland(head, exit, dest), null)! })
        }
        remote.forEach(({ gate, from }) => {
          const g = gates[gate]
          this.cross(island.group.id)
          this.cross(g.island.group.id)
          const head = [...this.outbound(g, from), this.ringPoint(g.angle)]
          const share = (external && gateway ? remoteShare : (external ? 0.85 : 0) + remoteShare) / remote.length
          routes.push({
            dest: b, source: g.island.buildings.get(from.node.id)!, origin: external && !gateway ? 'external' : 'internal',
            share, ...toDest(dest, intoIsland(head, g.angle, dest), null)!,
          })
        })
        if (remote.length === 0 && gateway && !external && (!hiddenCaller || this.edge.mode === 'plaza')) {
          // with no other island to call it: what comes in comes from the hub gateway
          this.cross(island.group.id)
          routes.push({ dest: b, source: gateway, origin: 'internal', share: remoteShare, ...toDest(dest, intoIsland([gateway.doorWorld().setY(GROUND), this.ringPoint(0)], 0, dest), null)! })
        }
      }
      // Systems on the same island that declare a call to it drive over from their own doors. Without a declared
      // caller there is no such traffic. The callee's rate is shared evenly between its callers until a source reports each link's own rate.
      const callers = plan.placed.filter((s) => s !== dest && s.node.calls.includes(dest.node.id))
      callers.forEach((from) => {
        const share = (external ? 0.15 : apiShare ? 0.65 : 0.92) / callers.length
        const head = from.roadZ !== dest.roadZ ? [w(from.x, from.roadZ), w(0, from.roadZ), w(0, dest.roadZ)] : [w(from.x, from.roadZ)]
        const same = from.roadZ === dest.roadZ && from.pad.col === dest.pad.col
        const r = toDest(dest, head, same ? from.x : null)
        if (r) routes.push({ dest: b, source: island.buildings.get(from.node.id)!, origin: 'internal', share, ...r })
      })
    }
    return routes
  }

  /**
   * Cars from the systems on screen to an island the filter hides, in a hub-and-spoke town: out of the caller's door, over its bridge and round the
   * plaza to the gateway, where they stop. Every call between islands goes through the gateway, so that is as far as they can be followed.
   */
  private edgeRoutes(s: Snapshot, gates: Gate[], gateway: Building | undefined): Route[] {
    if (this.edge.mode !== 'plaza' || !gateway) return []
    const gatewayRate = gateway.node?.requestsPerSecond ?? s.groups.find((g) => g.isHub)?.nodes.find((n) => n.kind === 'Gateway')?.requestsPerSecond ?? 0
    const rates = new Map<string, number>()
    for (const l of edgeLinks(s)) if (!l.incoming) rates.set(l.nodeId, (rates.get(l.nodeId) ?? 0) + l.requestsPerSecond)
    const routes: Route[] = []
    for (const [nodeId, rps] of rates) {
      const g = gates.find((x) => x.island.buildings.has(nodeId))
      const from = g?.plan.placed.find((p) => p.node.id === nodeId)
      if (!g || !g.bridged || !from) continue
      this.cross(g.island.group.id)
      routes.push({
        dest: gateway, source: g.island.buildings.get(nodeId)!, origin: 'internal', edge: true,
        share: gatewayRate > 0 ? clamp(rps / gatewayRate, 0.02, 1) : 0.1,
        path: [...this.outbound(g, from), ...this.ringArc(g.angle, 0), gateway.doorWorld().setY(GROUND)],
      })
    }
    return routes
  }

  /**
   * Shows or hides whole families of things. Traffic stops and its cars go; Messaging hides the boats, crates, pen, lighthouse and port board; Databases
   * and Workers hide those buildings, and the cars that were headed to or from them.
   */
  setLayers(state: LayerState): void {
    this.layers = state
    const hidden = new Set<Building>()
    for (const b of this.buildings.values()) {
      const shown = buildingShown(b.kind, state)
      b.root.visible = shown
      if (!shown) hidden.add(b)
    }
    this.cars.setEnabled(state.traffic)
    this.cars.setHidden(hidden)
    this.boats.setEnabled(state.messaging)
    for (const isl of this.islands) if (isl.harbour) isl.harbour.group.visible = state.messaging
    if (this.lighthouse) this.lighthouse.group.visible = state.messaging
    this.overlay.visible = state.dependencies
  }

  /** The hit boxes of the buildings that are drawn: a building hidden by a layer cannot be hovered or clicked. */
  hitMeshes(): THREE.Mesh[] {
    return [...this.buildings.values()].filter((b) => b.root.visible).map((b) => b.hit)
  }

  /** What the layers show right now, as plain values. For tests. */
  inspectLayers(): { layers: LayerState; hiddenBuildings: string[]; cars: number; boats: number; boatsDrawn: boolean; lighthouse: boolean | null; harbours: boolean[]; overlay: boolean } {
    return {
      layers: this.layers,
      hiddenBuildings: [...this.buildings].filter(([, b]) => !b.root.visible).map(([id]) => id),
      cars: this.cars.count, boats: this.boats.count, boatsDrawn: this.boats.object.visible,
      lighthouse: this.lighthouse ? this.lighthouse.group.visible : null,
      harbours: this.islands.filter((i) => i.harbour).map((i) => i.harbour!.group.visible),
      overlay: this.overlay.visible,
    }
  }

  /** How traffic to and from hidden islands is shown: the mode, the cars that end at the hub plaza, and what each signpost says. For tests. */
  inspectEdge(): { mode: EdgeMode; plazaRoutes: { from: string; to: string }[]; signposts: { island: string; lines: string[] }[] } {
    return {
      mode: this.edge.mode,
      plazaRoutes: this.cars.routeList.filter((r) => r.edge).map((r) => ({ from: [...this.buildings].find(([, b]) => b === r.source)?.[0] ?? '', to: r.dest.id })),
      signposts: this.islands.filter((i) => i.signpost).map((i) => ({ island: i.group.id, lines: i.signpost!.text })),
    }
  }

  /** Counts a car route over an island's bridge. */
  private cross(islandId: string): void {
    this.crossings.set(islandId, (this.crossings.get(islandId) ?? 0) + 1)
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
    if (groupId === 'hub') return { target: new THREE.Vector3(0, 0, 0), distance: Math.max(this.hubGeo.rx, this.hubGeo.rz) * 2.6 }
    if (groupId === 'airport' && this.airport) return { target: this.airport.root.getWorldPosition(new THREE.Vector3()).setY(0), distance: this.airport.rx * 2.2 }
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
  const leaf = new THREE.MeshStandardMaterial({ color: palette.tree.park, flatShading: true })
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
  const groups = s.groups.map((g) => `${g.id}${g.configError ? '!' : ''}:${g.nodes.map((n) => `${n.id}/${n.kind}/${n.tenants != null ? 'T' : ''}/${n.service ?? ''}/${n.calls.join('+')}/${(n.gatewayCalls ?? []).join('+')}`).join(',')}|${g.hasBridge === false ? 'nb' : 'b'}|${(g.messaging?.topics ?? []).map((t) => t.name).join('+')}|${(g.messaging?.subscriptions ?? []).map((x) => `${x.topic}>${x.consumer}${x.legacy ? '!' : ''}`).join('+')}`).join(';')
  const vendors = (s.vendors ?? []).map((v) => `${v.node.id}<${v.calledBy.join('+')}`).join(';')
  return `${s.townId}|${s.environment ?? ''}|${groups}|${vendors}|${edgeKey(s)}`
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
