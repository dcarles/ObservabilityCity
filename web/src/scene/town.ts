import * as THREE from 'three'
import { Building } from '../buildings/building'
import { box, canvasTexture, cyl, flat, group, roundRect } from '../buildings/mk'
import { kit } from '../assets/kit'
import type { GroupSnapshot, NodeSnapshot, Snapshot } from '../types'
import { palette } from '../themes/harbour-town/palette'
import { blockPad, bench, bridge, crates, fountain, lamp, pier, prop, ring, street, streetX } from './props'
import { buildIslandBody, GROUND, hill, makeOutline, scatterNature, type Outline, type Rect } from './island'
import { hashString } from './random'
import { CarSystem, type Route } from './cars'

const HUB_RX = 22
const HUB_RZ = 21
const RING_R = 5.7
const SLOT = 6.8 // street length per building
const BLOCK_X = 6.3 // building centre from the street centre line
const PAD_W = 8.6

interface Slot {
  node: NodeSnapshot
  side: -1 | 1
  row: number
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

    // ── Hub ────────────────────────────────────────────────────────────────
    const hubRoot = new THREE.Group()
    this.hubOutline = makeOutline(hashString('hub'), HUB_RX, HUB_RZ, 0.05)
    hubRoot.add(buildIslandBody(this.hubOutline))
    const hubBuildings = this.buildHub(hubRoot, hub)
    this.root.add(hubRoot)
    this.bounds.expandByPoint(new THREE.Vector3(-HUB_RX - 8, 0, -HUB_RZ - 4)).expandByPoint(new THREE.Vector3(HUB_RX + 14, 0, HUB_RZ + 4))
    const hubCoast = coastPoint(this.hubOutline, new THREE.Vector3(0, 0, -1), 0.9)

    // ── Islands on a ring ────────────────────────────────────────────────────
    pillars.forEach((g, index) => {
      const { slots, rows } = planBlocks(g.nodes)
      const rz = Math.max(21, (rows * SLOT) / 2 + 14)
      const rx = 18
      const ringR = HUB_RZ + 12 + rz
      // Clockwise from the top (north, -z).
      const angle = pillars.length === 1 ? 0 : (index / pillars.length) * Math.PI * 2
      const center = new THREE.Vector3(Math.sin(angle) * ringR, 0, -Math.cos(angle) * ringR)
      const island = this.buildIsland(g, slots, rows, center, rx, rz)
      this.islands.push(island)
      this.root.add(island.root)
      this.bounds.expandByPoint(new THREE.Vector3(center.x - rx - 8, 0, center.z - rz - 6)).expandByPoint(new THREE.Vector3(center.x + rx + 30, 0, center.z + rz + 6))

      const gateLocal = new THREE.Vector3(0, GROUND, coastScan(island.outline, 'z') - 0.7)
      const gate = island.root.localToWorld(gateLocal.clone())
      this.root.add(bridge({ from: hubCoast.clone().setY(0), to: gate.clone().setY(0) }))
      routes.push(...this.islandRoutes(island, slots, hubCoast, gate))
    })

    routes.push(...this.hubRoutes(hubBuildings))
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

  // ── hub ─────────────────────────────────────────────────────────────────

  private buildHub(hubRoot: THREE.Group, hub: GroupSnapshot | undefined): Building[] {
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
    hubRoot.add(street(0, -8.4, -5.8), street(0, -21, -13.7), street(0, 9.8, 11.4), streetX(2, 7.8, 11), streetX(2, -11.2, -7.8))
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.4
      hubRoot.add(lamp(Math.sin(a) * 8.6, 2 - Math.cos(a) * 8.6, Math.sin(a)))
    }
    hubRoot.add(bench(-6.0, -6.2, 0.6), bench(6.0, 9.6, 3.6), bench(-9.4, 8.2, 1.3))
    hubRoot.add(scatterNature(this.hubOutline, avoid, hashString('hub-trees'), { trees: 26, rocks: 12 }))
    return out
  }

  private hubRoutes(hubBuildings: Building[]): Route[] {
    const routes: Route[] = []
    const ringPoint = (a: number) => new THREE.Vector3(Math.sin(a) * RING_R, GROUND, 2 - Math.cos(a) * RING_R)
    const arc = (from: number, to: number) => {
      const steps = Math.max(2, Math.ceil(Math.abs(to - from) / 0.25))
      return Array.from({ length: steps + 1 }, (_, i) => ringPoint(from + ((to - from) * i) / steps))
    }
    const exits: Partial<Record<Building['kind'], number>> = { Broker: Math.PI / 2, Egress: -Math.PI / 2, Database: Math.PI }
    for (const b of hubBuildings) {
      const exit = exits[b.kind]
      if (exit === undefined) continue
      const door = b.doorWorld().setY(GROUND)
      const toExit = exit > Math.PI * 0.99 ? exit - 2 * Math.PI : exit // go the short way round
      routes.push({
        dest: b, origin: b.kind === 'Egress' ? 'external' : 'internal', share: 1,
        path: [new THREE.Vector3(0, GROUND, -12.6), new THREE.Vector3(0, GROUND, -8.4), ...arc(0, toExit), door],
      })
    }
    return routes
  }

  // ── pillar islands ──────────────────────────────────────────────────────

  private buildIsland(g: GroupSnapshot, slots: Slot[], rows: number, center: THREE.Vector3, rx: number, rz: number): Island {
    const root = new THREE.Group()
    root.position.copy(center)
    // local +z points at the hub, where the gate is
    root.rotation.y = Math.atan2(-center.x, -center.z)

    const outline = makeOutline(hashString(g.id), rx, rz, 0.06)
    root.add(buildIslandBody(outline))

    const gateZ = coastScan(outline, 'z') - 0.6
    const firstZ = gateZ - 6.5
    const lastZ = firstZ - (rows - 1) * SLOT
    const streetNorth = lastZ - SLOT / 2 - 1
    const avoid: Rect[] = [{ x: 0, z: (gateZ + streetNorth) / 2, w: 6.5, d: Math.abs(gateZ - streetNorth) + 3 }]
    root.add(street(0, streetNorth, gateZ + 0.2))

    const buildings = new Map<string, Building>()
    // one pad per service block so a service reads as a unit
    for (const block of blocksOf(slots)) {
      const zMax = firstZ - block.rowFrom * SLOT + SLOT / 2
      const zMin = firstZ - block.rowTo * SLOT - SLOT / 2
      root.add(blockPad(block.side * BLOCK_X, zMin, zMax, PAD_W))
      avoid.push({ x: block.side * BLOCK_X, z: (zMin + zMax) / 2, w: PAD_W + 1, d: zMax - zMin + 1 })
    }
    for (const slot of slots) {
      const z = firstZ - slot.row * SLOT
      const x = slot.side * BLOCK_X
      const b = new Building(slot.node.id, slot.node.kind, g.color)
      b.root.position.set(x, GROUND + 0.08, z)
      b.root.rotation.y = slot.side < 0 ? Math.PI / 2 : -Math.PI / 2
      root.add(b.root)
      this.buildings.set(slot.node.id, b)
      buildings.set(slot.node.id, b)
      // street furniture in front of each building
      root.add(prop('bush', slot.side * 3.35, z + 2.7, 0, 2.2))
      if (slot.node.kind === 'Worker') root.add(prop('dumpster', slot.side * (BLOCK_X + 3.6), z - 1.6, slot.side < 0 ? 0.4 : -0.4))
      if (slot.node.kind === 'Api') root.add(prop('firehydrant', slot.side * 3.45, z - 2.6, 0, 2.4))
    }
    // spare plots on whichever side has fewer rows: a small park
    for (const side of [-1, 1] as const) {
      const used = Math.max(-1, ...slots.filter((s) => s.side === side).map((s) => s.row))
      for (let row = used + 1; row < rows; row++) {
        const z = firstZ - row * SLOT
        root.add(...parkProps(side * BLOCK_X, z, side))
        avoid.push({ x: side * BLOCK_X, z, w: 8, d: SLOT })
      }
    }
    // lamps along the street
    for (let row = 0; row < rows; row++) {
      const z = firstZ - row * SLOT + SLOT / 2
      root.add(lamp(-3.55, z, 1), lamp(3.55, z, -1))
    }
    // the island's sign: one post, standing on land beside the street end
    const signZ = gateZ - 2.2
    root.add(this.islandSign(g, -6.4, signZ))
    avoid.push({ x: -6.4, z: signZ, w: 5, d: 3 })
    // the island's own harbour on the east coast, beside the middle of the town
    const harbourZ = (firstZ + lastZ) / 2
    const harbourCoast = coastScan(outline, 'x', harbourZ)
    root.add(this.harbour(harbourCoast, harbourZ))
    avoid.push({ x: harbourCoast - 3, z: harbourZ, w: 9, d: 10 })

    const hillZ = streetNorth - 5
    root.add(hill(-5, hillZ, 8, 3.2), hill(6, hillZ - 3, 5.5, 2.2))
    avoid.push({ x: -5, z: hillZ, w: 10, d: 10 }, { x: 6, z: hillZ - 3, w: 6, d: 6 })
    root.add(scatterNature(outline, avoid, hashString(g.id + '-nature'), { trees: 36, rocks: 14 }))
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

  private islandRoutes(island: Island, slots: Slot[], hubCoast: THREE.Vector3, gate: THREE.Vector3): Route[] {
    const routes: Route[] = []
    const w = (x: number, z: number) => island.root.localToWorld(new THREE.Vector3(x, GROUND, z))
    const slotZ = (s: Slot) => this.rowZ(island, s.row)
    const pullIn = (s: Slot) => w(s.side * 1.1, slotZ(s))
    const street = (s: Slot) => w(0, slotZ(s))
    const ringTop = new THREE.Vector3(0, GROUND, 2 - RING_R)
    const fromRing = [
      new THREE.Vector3(Math.sin(-0.7) * RING_R, GROUND, 2 - Math.cos(-0.7) * RING_R),
      new THREE.Vector3(Math.sin(-0.35) * RING_R, GROUND, 2 - Math.cos(-0.35) * RING_R),
      ringTop, new THREE.Vector3(0, GROUND, -9), hubCoast.clone().setY(GROUND), gate,
    ]

    for (const dest of slots) {
      const b = island.buildings.get(dest.node.id)!
      if (dest.node.kind === 'Worker' || dest.node.kind === 'Cron' || dest.node.kind === 'Broker') continue
      const external = dest.node.external
      // Callers from other islands arrive through the gate house, over the bridge and up the street.
      routes.push({
        dest: b, origin: external ? 'external' : 'internal', share: external ? 0.85 : dest.node.kind === 'Api' ? 0.35 : 0.08,
        path: [...fromRing, w(0, slotZ(dest) + 3), pullIn(dest)],
      })
      // Neighbours on the same island call it from their own doors; the same service block most of all.
      const callers = slots.filter((s) => s !== dest && (s.node.kind === 'Api' || s.node.kind === 'Worker'))
      const sameService = callers.filter((s) => s.node.service && s.node.service === dest.node.service)
      const weights = callers.map((c) => (sameService.includes(c) ? 3 : 1))
      const total = weights.reduce((a, b2) => a + b2, 0) || 1
      callers.forEach((from, i) => {
        const share = (external ? 0.15 : dest.node.kind === 'Api' ? 0.65 : 0.92) * (weights[i] / total)
        routes.push({
          dest: b, origin: 'internal', share,
          path: [pullIn(from), street(from), street(dest), pullIn(dest)],
        })
      })
      // and the answers drive back out toward the gate
      routes.push({
        dest: b, origin: external ? 'external' : 'internal', share: external ? 0.4 : 0.15, leaving: true,
        path: [...fromRing, w(0, slotZ(dest) + 3), pullIn(dest)],
      })
    }
    return routes
  }

  private rowZ(island: Island, row: number): number {
    const gateZ = coastScan(island.outline, 'z') - 0.6
    return gateZ - 6.5 - row * SLOT
  }

  node(id: string): NodeSnapshot | null {
    return this.buildings.get(id)?.node ?? null
  }
}

/** Groups nodes into service blocks and deals blocks to the two sides of the street, keeping them balanced. */
function planBlocks(nodes: NodeSnapshot[]): { slots: Slot[]; rows: number } {
  const blocks: NodeSnapshot[][] = []
  for (const n of nodes) {
    const last = blocks[blocks.length - 1]
    if (n.service && last && last[0].service === n.service) last.push(n)
    else blocks.push([n])
  }
  const rows = { '-1': 0, '1': 0 }
  const slots: Slot[] = []
  for (const block of blocks) {
    const side: -1 | 1 = rows['-1'] <= rows['1'] ? -1 : 1
    for (const node of block) slots.push({ node, side, row: rows[String(side) as '-1' | '1']++ })
  }
  return { slots, rows: Math.max(rows['-1'], rows['1'], 1) }
}

/** The runs of rows that belong to one service block, per side. */
function blocksOf(slots: Slot[]): { side: -1 | 1; rowFrom: number; rowTo: number }[] {
  const out: { side: -1 | 1; rowFrom: number; rowTo: number; service: string }[] = []
  for (const s of slots) {
    const last = out[out.length - 1]
    if (last && last.side === s.side && last.service === (s.node.service ?? s.node.id) && last.rowTo === s.row - 1) last.rowTo = s.row
    else out.push({ side: s.side, rowFrom: s.row, rowTo: s.row, service: s.node.service ?? s.node.id })
  }
  return out
}

/** A couple of trees, flower beds and a bench for a spare plot. */
function parkProps(x: number, z: number, side: -1 | 1): THREE.Object3D[] {
  const out: THREE.Object3D[] = []
  const trunk = new THREE.MeshStandardMaterial({ color: palette.tree.trunk, flatShading: true })
  const leaf = new THREE.MeshStandardMaterial({ color: '#58b85a', flatShading: true })
  for (const [dx, dz, s] of [[side * 0.8, -1.7, 1.25], [side * 1.9, 1.6, 0.95]] as const) {
    const t = new THREE.Group()
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 1.1, 5), trunk); tr.position.y = 0.55; tr.castShadow = true
    const l = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 0), leaf); l.position.y = 1.9; l.castShadow = true
    t.add(tr, l)
    t.scale.setScalar(s)
    t.position.set(x + dx, GROUND, z + dz)
    out.push(t)
  }
  out.push(bench(x - side * 2.2, z, side < 0 ? Math.PI / 2 : -Math.PI / 2))
  const colors = ['#ff7a8a', '#ffd84d', '#ffffff', '#b58cff']
  for (let i = 0; i < 8; i++) {
    const f = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 0), new THREE.MeshStandardMaterial({ color: colors[i % 4], flatShading: true }))
    f.position.set(x - side * (0.4 + (i % 4) * 0.5), GROUND + 0.18, z + 1.9 - Math.floor(i / 4) * 0.6)
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
