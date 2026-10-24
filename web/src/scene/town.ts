import * as THREE from 'three'
import { Building } from '../buildings/building'
import { canvasTexture, roundRect } from '../buildings/mk'
import type { GroupSnapshot, NodeSnapshot, Snapshot } from '../types'
import { palette } from '../themes/harbour-town/palette'
import { avenue, bench, bridge, fountain, lamp, plotPad } from './props'
import { buildIslandBody, GROUND, hill, makeOutline, scatterNature, type Outline, type Rect } from './island'
import { hashString } from './random'
import { spreadLane, WalkerSystem, type Route } from './walkers'

const HUB_RX = 20
const HUB_RZ = 19
const SLOT = 8 // street length per plot
const PLOT_W = 8
const PLOT_D = 7.6
const PLOT_X = 6.7 // plot centre from the street centre line
const STREET = 4.2

interface Island {
  group: GroupSnapshot
  root: THREE.Group
  outline: Outline
  buildings: Building[]
  /** Island-local street end (the gate), toward the hub. */
  gateZ: number
  streetNorthZ: number
}

/**
 * Builds the town from the first snapshot (the hub in the middle, one island per group on a ring) and then
 * only updates it. Layout is deterministic: the same registry gives the same town every time.
 */
export class Town {
  readonly root = new THREE.Group()
  readonly walkers = new WalkerSystem()
  readonly buildings = new Map<string, Building>()
  readonly islands: Island[] = []
  hubOutline!: Outline
  /** Extent used to frame the camera. */
  readonly bounds = new THREE.Box3()
  private snapshotId = ''

  constructor() {
    this.root.add(this.walkers.object)
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

    // ── Hub ────────────────────────────────────────────────────────────────
    const hubRoot = new THREE.Group()
    this.hubOutline = makeOutline(hashString('hub'), HUB_RX, HUB_RZ, 0.05)
    hubRoot.add(buildIslandBody(this.hubOutline))
    const hubBuildings = this.buildHub(hubRoot, hub)
    this.root.add(hubRoot)
    this.bounds.expandByPoint(new THREE.Vector3(-HUB_RX - 8, 0, -HUB_RZ - 4)).expandByPoint(new THREE.Vector3(HUB_RX + 14, 0, HUB_RZ + 4))

    const apim = hubBuildings.find((b) => b.kind === 'Gateway')
    const plaza = new THREE.Vector3(0, GROUND, 2)

    // ── Islands on a ring ────────────────────────────────────────────────────
    pillars.forEach((g, index) => {
      const rows = Math.ceil((g.nodes.length + 1) / 2)
      const rz = Math.max(18, rows * SLOT / 2 + 10)
      const rx = 17
      const ringR = HUB_RZ + 11 + rz
      // Clockwise from the top (north, -z).
      const angle = pillars.length === 1 ? 0 : (index / pillars.length) * Math.PI * 2
      const center = new THREE.Vector3(Math.sin(angle) * ringR, 0, -Math.cos(angle) * ringR)
      const island = this.buildIsland(g, center, rx, rz)
      this.islands.push(island)
      this.root.add(island.root)
      this.bounds.expandByPoint(new THREE.Vector3(center.x - rx - 6, 0, center.z - rz - 6)).expandByPoint(new THREE.Vector3(center.x + rx + 6, 0, center.z + rz + 6))

      // The bridge starts at the hub's coast on the way to the island and ends at the island's gate.
      const toIsland = center.clone().normalize()
      const start = coastPoint(this.hubOutline, toIsland, 1.0)
      const gateLocal = new THREE.Vector3(0, GROUND, island.gateZ + 1.2)
      const gate = island.root.localToWorld(gateLocal.clone())
      this.root.add(bridge({ from: start.clone().setY(0), to: gate.clone().setY(0), width: 3.4 }))
      // hub-side road from the gate house to the bridge head
      if (apim) {
        const apimDoor = apim.doorWorld()
        const through = apim.doorWorld().clone().addScaledVector(apim.doorDirWorld(), -5.5)
        routes.push(...this.routesFor(island, g, apim, apimDoor, through, start, gate, plaza))
      }
    })

    // hub destinations reached from the gate house: egress and the shared DB
    if (apim) {
      const door = apim.doorWorld()
      for (const b of hubBuildings) {
        if (b === apim || b.kind === 'Broker' || b.kind === 'Worker' || b.kind === 'Cron') continue
        routes.push({
          dest: b,
          share: 1,
          color: new THREE.Color(hub?.color ?? palette.flagFallback),
          makePath: (lane) => spreadLane([door, plaza.clone(), b.doorWorld().clone().addScaledVector(b.doorDirWorld(), 1.2), b.doorWorld()], lane, 1.2),
        })
      }
    }
    this.walkers.setRoutes(routes)
  }

  /** Feed a snapshot into the existing buildings. */
  apply(s: Snapshot): void {
    for (const g of s.groups) for (const n of g.nodes) this.buildings.get(n.id)?.setNode(n)
  }

  update(dt: number, time: number, camera: THREE.Camera): void {
    for (const b of this.buildings.values()) b.update(dt, time, camera)
    this.walkers.update(dt)
  }

  // ── hub ─────────────────────────────────────────────────────────────────

  private buildHub(hubRoot: THREE.Group, hub: GroupSnapshot | undefined): Building[] {
    const out: Building[] = []
    const avoid: Rect[] = [{ x: 0, z: 0, w: 15, d: 15 }, { x: 0, z: -14, w: 6, d: 10 }]
    const plan: Record<string, { x: number; z: number; yaw: number }> = {
      Gateway: { x: 0, z: -11.5, yaw: 0 },
      Broker: { x: 10.5, z: 0.5, yaw: Math.PI / 2 },
      Egress: { x: -11.5, z: 1.5, yaw: Math.PI / 2 },
      Database: { x: 0.5, z: 12.5, yaw: Math.PI },
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
      avoid.push({ x: spot.x, z: spot.z, w: 11, d: 11 })
    }
    // plaza: round paving, fountain, benches, lamps
    const paving = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 6.4, 0.12, 40), new THREE.MeshStandardMaterial({ color: palette.island.pavement, roughness: 0.95, flatShading: true }))
    paving.position.set(0, GROUND + 0.02, 2)
    paving.receiveShadow = true
    const fount = fountain()
    fount.position.x = 0
    fount.position.z = 2
    hubRoot.add(paving, fount)
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.5
      hubRoot.add(bench(Math.sin(a) * 4.7, 2 + Math.cos(a) * 4.7, a + Math.PI))
      hubRoot.add(lamp(Math.sin(a + 0.5) * 6.6, 2 + Math.cos(a + 0.5) * 6.6))
    }
    // road from the gate house to the plaza
    hubRoot.add(avenue(0, -8.4, -3.8, STREET))
    hubRoot.add(avenue(0, -19.5, -13.6, STREET))
    hubRoot.add(scatterNature(this.hubOutline, avoid, hashString('hub-trees'), { trees: 26, rocks: 12 }))
    return out
  }

  // ── pillar islands ──────────────────────────────────────────────────────

  private buildIsland(g: GroupSnapshot, center: THREE.Vector3, rx: number, rz: number): Island {
    const root = new THREE.Group()
    root.position.copy(center)
    // local +z points at the hub, where the gate is
    root.rotation.y = Math.atan2(-center.x, -center.z)

    const outline = makeOutline(hashString(g.id), rx, rz, 0.06)
    root.add(buildIslandBody(outline))

    const rows = Math.ceil((g.nodes.length + 1) / 2)
    const gateZ = rz - 3.2
    // rows are laid out from the gate end toward the far end of the island
    const firstZ = gateZ - 5.2
    const avoid: Rect[] = []
    const streetNorth = firstZ - (rows - 1) * SLOT - SLOT / 2
    root.add(avenue(0, gateZ + 2.5, streetNorth, STREET))
    avoid.push({ x: 0, z: (gateZ + streetNorth) / 2, w: STREET + 3, d: Math.abs(gateZ - streetNorth) + 4 })

    const buildings: Building[] = []
    const slots = rows * 2
    for (let slot = 0; slot < slots; slot++) {
      const row = Math.floor(slot / 2)
      const left = slot % 2 === 0
      const x = left ? -PLOT_X : PLOT_X
      const z = firstZ - row * SLOT
      root.add(plotPad(x, z, PLOT_W, PLOT_D))
      avoid.push({ x, z, w: PLOT_W + 1, d: PLOT_D + 1 })
      const node = g.nodes[slot]
      if (!node) {
        // a spare plot: lawn with a bench so new systems can slot in without moving anything
        root.add(bench(x + (left ? -1.2 : 1.2), z, left ? Math.PI / 2 : -Math.PI / 2))
        root.add(...parkTrees(x, z, left))
        continue
      }
      const b = new Building(node.id, node.kind, g.color)
      b.root.position.set(x, GROUND + 0.08, z)
      b.root.rotation.y = left ? Math.PI / 2 : -Math.PI / 2
      root.add(b.root)
      this.buildings.set(node.id, b)
      buildings.push(b)
    }
    // lamps along the street
    for (let row = 0; row < rows; row++) {
      const z = firstZ - row * SLOT + SLOT / 2
      root.add(lamp(-2.9, z), lamp(2.9, z))
    }
    root.add(this.islandSign(g, gateZ + 0.5))
    const hillZ = streetNorth - 6
    root.add(hill(-5, hillZ, 8, 3.2), hill(6, hillZ - 3, 5.5, 2.2))
    avoid.push({ x: -5, z: hillZ, w: 10, d: 10 }, { x: 6, z: hillZ - 3, w: 6, d: 6 })
    root.add(scatterNature(outline, avoid, hashString(g.id + '-nature'), { trees: 34, rocks: 14 }))
    root.updateMatrixWorld(true)
    return { group: g, root, outline, buildings, gateZ, streetNorthZ: streetNorth }
  }

  private islandSign(g: GroupSnapshot, z: number): THREE.Group {
    const tex = canvasTexture(512, 128, (ctx) => {
      ctx.fillStyle = '#f7f0df'; roundRect(ctx, 4, 4, 504, 120, 22); ctx.fill()
      ctx.fillStyle = g.color; ctx.fillRect(4, 4, 504, 22)
      ctx.fillStyle = '#26364f'; ctx.font = '800 54px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(g.displayName.toUpperCase(), 256, 72, 470)
    })
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.6), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide }))
    sign.position.y = 3.3
    const post = (x: number) => {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 3.6, 6), new THREE.MeshStandardMaterial({ color: palette.woodDark, flatShading: true }))
      p.position.set(x, 1.8, -0.05)
      p.castShadow = true
      return p
    }
    const g2 = new THREE.Group()
    g2.add(sign, post(-3), post(3))
    // beside the street end, facing the bridge so it reads on arrival
    g2.position.set(-7.5, GROUND, z + 1.5)
    g2.rotation.y = 0.35
    return g2
  }

  // ── routes ──────────────────────────────────────────────────────────────

  private routesFor(
    island: Island, g: GroupSnapshot, apim: Building, apimDoor: THREE.Vector3, through: THREE.Vector3,
    bridgeStart: THREE.Vector3, gate: THREE.Vector3, plaza: THREE.Vector3,
  ): Route[] {
    const routes: Route[] = []
    const local = (b: Building) => island.root.worldToLocal(b.doorWorld())
    const streetPoint = (z: number) => island.root.localToWorld(new THREE.Vector3(0, GROUND, z))
    const hubColor = new THREE.Color(this.hubColorOf(apim))
    const islandColor = new THREE.Color(g.color)
    const callers = island.buildings.filter((b) => b.kind === 'Api' || b.kind === 'Worker' || b.kind === 'Cron')

    for (const dest of island.buildings) {
      if (dest.kind === 'Worker' || dest.kind === 'Cron' || dest.kind === 'Broker') continue
      const doorW = dest.doorWorld()
      const dz = local(dest).z
      const outside = g.nodes.find((n) => n.id === dest.id)?.kind === 'Api' && isExternal(g, dest.id)
      // People from outside the island arrive through the gate house, cross the bridge and walk up the street.
      const fromGate = (lane: number) => spreadLane([
        apimDoor, through, bridgeStart.clone().setY(GROUND), gate, streetPoint(dz), doorW,
      ], lane, 1.1)
      routes.push({ dest, share: outside ? 1 : dest.kind === 'Api' ? 0.45 : 0.1, color: hubColor, makePath: fromGate })

      // Neighbours on the same island call this building from their own door.
      const others = callers.filter((c) => c !== dest)
      if (others.length && (dest.kind !== 'Api' || !outside)) {
        const share = (dest.kind === 'Api' ? 0.55 : 0.9) / others.length
        for (const from of others) {
          routes.push({
            dest, share, color: islandColor,
            makePath: (lane) => spreadLane([from.doorWorld(), streetPoint(local(from).z), streetPoint(dz), doorW], lane, 1.1),
          })
        }
      }
    }
    void plaza
    return routes
  }

  private hubColorOf(b: Building): string {
    void b
    return '#f2d27a'
  }

  node(id: string): NodeSnapshot | null {
    return this.buildings.get(id)?.node ?? null
  }
}

/** A couple of trees and flower beds for a spare plot. */
function parkTrees(x: number, z: number, left: boolean): THREE.Object3D[] {
  const out: THREE.Object3D[] = []
  const side = left ? -1 : 1
  const trunk = new THREE.MeshStandardMaterial({ color: palette.tree.trunk, flatShading: true })
  const leaf = new THREE.MeshStandardMaterial({ color: '#58b85a', flatShading: true })
  for (const [dx, dz, s] of [[side * 1.0, -2, 1.2], [side * 2.4, 1.6, 0.95]] as const) {
    const t = new THREE.Group()
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 1.1, 5), trunk); tr.position.y = 0.55; tr.castShadow = true
    const l = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 0), leaf); l.position.y = 1.9; l.castShadow = true
    t.add(tr, l)
    t.scale.setScalar(s)
    t.position.set(x + dx, GROUND, z + dz)
    out.push(t)
  }
  const colors = ['#ff7a8a', '#ffd84d', '#ffffff', '#b58cff']
  for (let i = 0; i < 8; i++) {
    const f = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 0), new THREE.MeshStandardMaterial({ color: colors[i % 4], flatShading: true }))
    f.position.set(x + side * (-1.5 + (i % 4) * 0.55), GROUND + 0.18, z + 1.8 - Math.floor(i / 4) * 0.6 - 1.4)
    out.push(f)
  }
  return out
}

function isExternal(g: GroupSnapshot, id: string): boolean {
  // The contract does not carry the external flag yet; the first API on an island plays the front door.
  return g.nodes.find((n) => n.kind === 'Api')?.id === id
}

function layoutKey(s: Snapshot): string {
  return `${s.townId}|${s.groups.map((g) => `${g.id}:${g.nodes.map((n) => `${n.id}/${n.kind}`).join(',')}`).join(';')}`
}

/** Where the line from the hub's centre toward a direction leaves the hub's coast (inset a little). */
function coastPoint(outline: Outline, dir: THREE.Vector3, inset: number): THREE.Vector3 {
  let lo = 0, hi = 60
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (outline.contains(dir.x * mid, dir.z * mid)) lo = mid
    else hi = mid
  }
  return new THREE.Vector3(dir.x * (lo - inset), GROUND, dir.z * (lo - inset))
}
