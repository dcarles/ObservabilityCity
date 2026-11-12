import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { layoutWithHubRoom } from '../../src/scene/hubRoom'
import { layoutTown, type HubGeometry, type TownLayout } from '../../src/scene/layout'
import { HUB_CENTRE_Z, HUB_COMPACT, HUB_PLOT, hubBenches, hubFree, hubMainSpots, hubReserved, placeHubBuildings, placeHubClusters, planIsland, rectsTouch, type HubSlot } from '../../src/scene/plan'
import { makeOutline } from '../../src/scene/island'
import { hashString } from '../../src/scene/random'
import type { AssetSnapshot, Snapshot } from '../../src/types'
import { AIRPORT } from './layout.testutil'

// The hub holds one building for each system it declares. The first of each kind stands where it always stood; a second broker or a second gateway is a building of its own,
// on a free place of the hub with its own street from the ring road or, a little smaller, beside a spoke road, and the hub grows until every one of them fits.

const golden = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}.json`), 'utf8')) as Snapshot
const island = { rx: 30, rz: 26 }
const ONE_OF_EACH = ['Gateway', 'Broker', 'Egress', 'Database']
const portsOf = (l: TownLayout) => [...l.islands, ...(l.airport ? [l.airport] : [])].map((i) => i.portAngle)
const nodesOf = (kinds: readonly string[]) => kinds.map((kind, i) => ({ id: `hub.${kind.toLowerCase()}${i}`, kind }))
const asset = (id: string, group: string): AssetSnapshot => ({ id, name: id, label: 'Resource', shape: 'observatory', service: null, region: null, links: [], group })
const CZ = HUB_CENTRE_Z
const plotOf = (s: HubSlot) => ({ x: s.x, z: s.z, w: HUB_PLOT * s.scale, d: HUB_PLOT * s.scale })
const segmentDistance = (px: number, pz: number, ax: number, az: number, bx: number, bz: number) => {
  const dx = bx - ax, dz = bz - az
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)))
  return Math.hypot(px - ax - t * dx, pz - az - t * dz)
}

/**
 * What every hub with further buildings must keep, measured on the drawn geometry: no two plots on each other; every plot on land; a further building (as the circle its model
 * fits in, turned any way) clear of the ring road and its lamps, every spoke road (6 wide with its curbs), the main buildings and their streets and the benches; its street
 * straight from a road's edge to it and clear of every other building; and what it reserves (its street, a broker's jetty) clear of every other building.
 */
function expectClearHub(slots: HubSlot[], geo: HubGeometry, ports: readonly number[]): void {
  const f = geo.scale
  for (const a of slots) for (const b of slots) if (a !== b) expect(rectsTouch(plotOf(a), plotOf(b)), `${a.id} ${b.id}`).toBe(false)
  const outline = makeOutline(hashString('hub'), geo.rx, geo.rz, 0.05)
  for (const s of slots) for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) expect(outline.contains(s.x + (dx * HUB_PLOT * s.scale) / 2, s.z + (dz * HUB_PLOT * s.scale) / 2), s.id).toBe(true)
  const mains = slots.filter((s) => s.main)
  const spokes = ports.map((a) => ({ ax: Math.sin(a) * geo.ringR, az: CZ - Math.cos(a) * geo.ringR, bx: Math.sin(a) * 4 * geo.rx, bz: CZ - Math.cos(a) * 4 * geo.rx }))
  for (const s of slots.filter((x) => !x.main)) {
    const r = (HUB_PLOT * s.scale) / 2
    expect(Math.hypot(s.x, s.z - CZ) - r, s.id).toBeGreaterThan(geo.ringR + 2.9)
    for (const l of spokes) expect(segmentDistance(s.x, s.z, l.ax, l.az, l.bx, l.bz) - r, s.id).toBeGreaterThan(3)
    for (const m of mains) expect(segmentDistance(s.x, s.z, 0, CZ, m.x, m.z) - r, `${s.id} and the street to ${m.id}`).toBeGreaterThan(3)
    for (const [x, z] of hubBenches(f)) expect(rectsTouch(plotOf(s), { x, z, w: 3, d: 3 }), s.id).toBe(false)
    // its street starts on the edge of the ring road, or of the spoke road it stands beside, and runs straight to it past every other building
    const front = s.front!
    const onRing = Math.abs(Math.hypot(front.x, front.z - CZ) - (geo.ringR + 2.1)) < 1e-6
    const onSpoke = spokes.some((l, i) => Math.abs(ports[i] - s.exit) < 1e-9 && Math.abs(segmentDistance(front.x, front.z, l.ax, l.az, l.bx, l.bz) - 2.1) < 1e-6)
    expect(onRing || onSpoke, s.id).toBe(true)
    for (let k = 0; k <= 20; k++) {
      const p = { x: front.x + ((s.x - front.x) * k) / 20, z: front.z + ((s.z - front.z) * k) / 20, w: 0.1, d: 0.1 }
      for (const o of slots) if (o !== s) expect(rectsTouch(p, plotOf(o)), `${s.id}'s street and ${o.id}`).toBe(false)
    }
    for (const part of s.reserved.slice(1)) for (const o of slots) if (o !== s) expect(rectsTouch(part, plotOf(o)), `${s.id}'s ground and ${o.id}`).toBe(false)
    // a further building beside a spoke road is drawn smaller, one off the ring road as big as the first of its kind
    expect(s.scale).toBe(onRing ? 1 : HUB_COMPACT)
  }
}

describe('a hub with one of each kind', () => {
  it('keeps its size and every building on its axis, as it always was', () => {
    const sizes = [island, island, island]
    const plain = layoutTown(sizes, undefined, AIRPORT)
    const layout = layoutWithHubRoom(sizes, undefined, AIRPORT, [], ONE_OF_EACH)
    expect(layout).toEqual(plain)

    const { slots, left, skipped, reserved } = placeHubBuildings(nodesOf(ONE_OF_EACH), layout.hub, portsOf(layout))
    const f = layout.hub.scale
    expect(left).toEqual([])
    expect(skipped).toEqual([])
    expect(reserved).toEqual([])
    expect(slots.map((s) => ({ kind: s.kind, x: s.x, z: s.z, yaw: s.yaw, exit: s.exit, main: s.main }))).toEqual([
      { kind: 'Gateway', x: 0, z: HUB_CENTRE_Z - 13.5 * f, yaw: 0, exit: 0, main: true },
      { kind: 'Broker', x: 14.5 * f, z: HUB_CENTRE_Z, yaw: Math.PI / 2, exit: Math.PI / 2, main: true },
      { kind: 'Egress', x: -14.5 * f, z: HUB_CENTRE_Z, yaw: Math.PI / 2, exit: -Math.PI / 2, main: true },
      { kind: 'Database', x: 0, z: HUB_CENTRE_Z + 14 * f, yaw: Math.PI, exit: Math.PI, main: true },
    ])
  })

  it('reserves the same ground for clusters as before', () => {
    const layout = layoutTown([island, island, island], undefined, AIRPORT)
    const ports = portsOf(layout)
    expect(hubReserved(layout.hub.scale, ONE_OF_EACH, ports, placeHubBuildings(nodesOf(ONE_OF_EACH), layout.hub, ports).reserved)).toEqual(hubReserved(layout.hub.scale, ONE_OF_EACH, ports))
  })

  it('grows for clusters exactly as before', () => {
    const assets = Array.from({ length: 6 }, (_, i) => asset(`hub.logs${i}`, 'Logs'))
    const sizes = [island, island, island]
    const base = layoutWithHubRoom(sizes, undefined, AIRPORT, assets, ['Gateway', 'Broker'])
    // the same as a hub whose kinds are listed once each, whatever the order
    expect(layoutWithHubRoom(sizes, undefined, AIRPORT, assets, ['Broker', 'Gateway'])).toEqual(base)
  })

  it('leaves out a kind the hub has no place for, without growing for it', () => {
    const layout = layoutWithHubRoom([island, island], undefined, AIRPORT, [], ['Gateway', 'Cache'])
    expect(layout).toEqual(layoutTown([island, island], undefined, AIRPORT))
    expect(placeHubBuildings([{ id: 'hub.cache', kind: 'Cache' }], layout.hub, portsOf(layout)).skipped).toEqual(['hub.cache'])
  })
})

describe('a hub with two of each kind', () => {
  const kinds = ['Gateway', 'Gateway', 'Broker', 'Broker', 'Egress', 'Egress', 'Database', 'Database']
  const sizes = [island, island, island, island]
  const plain = layoutTown(sizes, undefined, AIRPORT)
  const layout = layoutWithHubRoom(sizes, undefined, AIRPORT, [], kinds)
  const ports = portsOf(layout)
  const placed = placeHubBuildings(nodesOf(kinds), layout.hub, ports)

  it('grows the hub, and gives every building a place', () => {
    expect(layout.hub.scale).toBeGreaterThan(plain.hub.scale)
    expect(placed.left).toEqual([])
    expect(placed.slots).toHaveLength(8)
    expect(placed.slots.filter((s) => s.main).map((s) => s.kind)).toEqual(ONE_OF_EACH)
  })

  it('keeps the first of each kind on its axis, and stands the second elsewhere', () => {
    const mains = hubMainSpots(layout.hub.scale)
    for (const s of placed.slots.filter((x) => x.main)) expect({ x: s.x, z: s.z }).toEqual({ x: mains[s.kind].x, z: mains[s.kind].z })
    const at = new Set(placed.slots.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`))
    expect(at.size).toBe(8)
  })

  it('stands no two buildings on each other, and none on the plaza, a spoke road or another building\'s street', () => {
    expectClearHub(placed.slots, layout.hub, ports)
    const reserved = hubReserved(layout.hub.scale, ONE_OF_EACH, ports)
    for (const s of placed.slots.filter((x) => !x.main)) {
      // one with a street off the ring road keeps off all the ground the clusters keep off too
      if (s.scale === 1) for (const r of reserved) expect(rectsTouch(plotOf(s), r), s.id).toBe(false)
      for (const other of placed.slots.filter((x) => x !== s && !x.main)) for (const r of other.reserved) expect(rectsTouch(plotOf(s), r)).toBe(false)
      // its street from the road toward the building
      expect(s.reserved.length).toBeGreaterThan(1)
    }
  })

  it('keeps the clusters of resource buildings off them and their streets', () => {
    const assets = Array.from({ length: 5 }, (_, i) => asset(`hub.logs${i}`, 'Logs'))
    const grown = layoutWithHubRoom(sizes, undefined, AIRPORT, assets, kinds)
    const p = portsOf(grown)
    const b = placeHubBuildings(nodesOf(kinds), grown.hub, p)
    const { clusters, left } = placeHubClusters(assets, grown.hub.rx, grown.hub.rz, HUB_CENTRE_Z, hubFree(grown.hub, kinds, p, b.reserved))
    expect(b.left).toEqual([])
    expect(left).toEqual([])
    for (const c of clusters) for (const r of b.reserved) expect(rectsTouch(c, r)).toBe(false)
  })

  it('is the same every time', () => {
    expect(placeHubBuildings(nodesOf(kinds), layout.hub, ports)).toEqual(placed)
  })
})

/** The airport's size as the scene draws it (Airport.rx and rz), for the towns as the scene lays them out. */
const SCENE_AIRPORT = { rx: 52, rz: 30 }

/** A sample town's hub as the scene lays it out: its islands' coasts, with hub lanes when its broker reports flows, grown for its further buildings, and the hub with one of each. */
function sceneHub(name: string, lanes?: boolean) {
  const s = golden(name)
  const hub = s.groups.find((g) => g.isHub)!
  const plans = s.groups.filter((g) => !g.isHub).map((g) => planIsland(g))
  const withLanes = lanes ?? s.groups.some((g) => g.flow != null)
  const sizes = plans.map((p) => ({ rx: p.rx, rz: p.rz }))
  const layout = layoutWithHubRoom(sizes, s.ringCapacity, SCENE_AIRPORT, hub.assets ?? [], hub.nodes.map((n) => n.kind), withLanes)
  const plain = layoutTown(sizes, s.ringCapacity, SCENE_AIRPORT, 0, withLanes)
  return { s, hub, layout, plain, placed: placeHubBuildings(hub.nodes, layout.hub, portsOf(layout)) }
}

describe('the multi-hub test town', () => {
  const { hub, layout, plain, placed } = sceneHub('multi-hub-town')

  it('stands each of its seven hub systems as a building of its own', () => {
    expect(hub.nodes).toHaveLength(7)
    expect(placed.left).toEqual([])
    expect(placed.slots.map((x) => x.id).sort()).toEqual(hub.nodes.map((n) => n.id).sort())
    expect(placed.slots.filter((x) => x.main).map((x) => x.id)).toEqual(['hub.public-gateway', 'hub.event-broker', 'hub.egress', 'hub.customer-db'])
  })

  it('keeps them clear of each other and of everything on the hub, on a hub hardly bigger than one with one of each', () => {
    expectClearHub(placed.slots, layout.hub, portsOf(layout))
    expect(layout.hub.scale).toBeLessThanOrEqual(plain.hub.scale * 1.3)
  })
})

describe('the sample town, whose hub has a second gateway, broker and database among eighteen spokes', () => {
  const { hub, layout, plain, placed } = sceneHub('calm')

  it('stands all ten hub systems as buildings of their own', () => {
    expect(portsOf(layout)).toHaveLength(18)
    expect(hub.nodes).toHaveLength(7)
    expect(placed.left).toEqual([])
    expect(placed.skipped).toEqual([])
    expect(placed.slots.map((x) => x.id).sort()).toEqual(hub.nodes.map((n) => n.id).sort())
    expect(placed.slots.filter((x) => !x.main)).toHaveLength(3)
  })

  it('keeps them clear of each other, the plaza, the main buildings, the spoke roads and the benches, with a street each', () => {
    expectClearHub(placed.slots, layout.hub, portsOf(layout))
  })

  it('grows the hub by a quarter at most, so the islands keep their places', () => {
    expect(layout.hub.scale).toBeLessThanOrEqual(plain.hub.scale * 1.25)
    expect(layout.islands.map((i) => i.radius)).toEqual(plain.islands.map((i) => i.radius))
  })

  it('fits too without hub lanes, where the hub starts smaller', () => {
    const bare = sceneHub('calm', false)
    expect(bare.placed.left).toEqual([])
    expectClearHub(bare.placed.slots, bare.layout.hub, portsOf(bare.layout))
    expect(bare.layout.hub.scale).toBeLessThanOrEqual(bare.plain.hub.scale * 1.3)
    expect(bare.layout.hub.rx).toBeLessThan(70)
  })

  it('leaves room for its clusters of resource buildings off them', () => {
    const assets = Array.from({ length: 5 }, (_, i) => asset(`hub.logs${i}`, 'Logs'))
    const s = golden('calm')
    const sizes = s.groups.filter((g) => !g.isHub).map((g) => planIsland(g)).map((p) => ({ rx: p.rx, rz: p.rz }))
    const kinds = hub.nodes.map((n) => n.kind)
    const grown = layoutWithHubRoom(sizes, s.ringCapacity, SCENE_AIRPORT, assets, kinds, true)
    const p = portsOf(grown)
    const b = placeHubBuildings(hub.nodes, grown.hub, p)
    const { clusters, left } = placeHubClusters(assets, grown.hub.rx, grown.hub.rz, CZ, hubFree(grown.hub, kinds, p, b.reserved))
    expect(b.left).toEqual([])
    expect(left).toEqual([])
    for (const c of clusters) for (const r of b.reserved) expect(rectsTouch(c, r)).toBe(false)
  })
})
