import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { layoutWithHubRoom } from '../../src/scene/hubRoom'
import { layoutTown, type TownLayout } from '../../src/scene/layout'
import { HUB_CENTRE_Z, hubFree, hubMainSpots, hubReserved, placeHubBuildings, placeHubClusters, planIsland, rectsTouch } from '../../src/scene/plan'
import { makeOutline } from '../../src/scene/island'
import { hashString } from '../../src/scene/random'
import type { AssetSnapshot, Snapshot } from '../../src/types'
import { AIRPORT } from './layout.testutil'

// The hub holds one building for each system it declares. The first of each kind stands where it always stood; a second broker or a second gateway is a building of its own,
// on a free place of the hub with its own street, and the hub grows until every one of them fits.

const golden = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}.json`), 'utf8')) as Snapshot
const island = { rx: 30, rz: 26 }
const ONE_OF_EACH = ['Gateway', 'Broker', 'Egress', 'Database']
const portsOf = (l: TownLayout) => [...l.islands, ...(l.airport ? [l.airport] : [])].map((i) => i.portAngle)
const nodesOf = (kinds: readonly string[]) => kinds.map((kind, i) => ({ id: `hub.${kind.toLowerCase()}${i}`, kind }))
const asset = (id: string, group: string): AssetSnapshot => ({ id, name: id, label: 'Resource', shape: 'observatory', service: null, region: null, links: [], group })

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
    const plot = (s: { x: number; z: number }) => ({ x: s.x, z: s.z, w: 12, d: 12 })
    for (const a of placed.slots) for (const b of placed.slots) if (a !== b) expect(rectsTouch(plot(a), plot(b)), `${a.id} ${b.id}`).toBe(false)
    const f = layout.hub.scale
    const reserved = hubReserved(f, ONE_OF_EACH, ports)
    for (const s of placed.slots.filter((x) => !x.main)) {
      for (const r of reserved) expect(rectsTouch(plot(s), r), s.id).toBe(false)
      for (const other of placed.slots.filter((x) => x !== s && !x.main)) for (const r of other.reserved) expect(rectsTouch(plot(s), r)).toBe(false)
      // its street runs from the ring road toward the building
      expect(s.reserved.length).toBeGreaterThan(1)
    }
    // every plot is on land
    const outline = makeOutline(hashString('hub'), layout.hub.rx, layout.hub.rz, 0.05)
    for (const s of placed.slots) for (const [dx, dz] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) expect(outline.contains(s.x + dx, s.z + dz), s.id).toBe(true)
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

describe('the multi-hub test town', () => {
  const s = golden('multi-hub-town')
  const hub = s.groups.find((g) => g.isHub)!
  const plans = s.groups.filter((g) => !g.isHub).map((g) => planIsland(g))
  const lanes = s.groups.some((g) => g.flow != null)
  const layout = layoutWithHubRoom(plans.map((p) => ({ rx: p.rx, rz: p.rz })), s.ringCapacity, AIRPORT, hub.assets ?? [], hub.nodes.map((n) => n.kind), lanes)
  const placed = placeHubBuildings(hub.nodes, layout.hub, portsOf(layout))

  it('stands each of its seven hub systems as a building of its own', () => {
    expect(hub.nodes).toHaveLength(7)
    expect(placed.left).toEqual([])
    expect(placed.slots.map((x) => x.id).sort()).toEqual(hub.nodes.map((n) => n.id).sort())
    expect(placed.slots.filter((x) => x.main).map((x) => x.id)).toEqual(['hub.public-gateway', 'hub.event-broker', 'hub.egress', 'hub.customer-db'])
  })
})
