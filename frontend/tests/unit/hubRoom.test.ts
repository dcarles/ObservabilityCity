import { describe, expect, it } from 'vitest'
import { layoutWithHubRoom } from '../../src/scene/hubRoom'
import { layoutTown } from '../../src/scene/layout'
import { HUB_CENTRE_Z, hubFree, placeHubClusters, rectsTouch, hubReserved } from '../../src/scene/plan'
import type { AssetSnapshot } from '../../src/types'

// The hub of a small town has room for its four main buildings and its spoke roads, and none to spare: it grows until its clusters of resource buildings fit.

const asset = (id: string, group: string): AssetSnapshot => ({ id, name: id, label: 'Resource', shape: 'observatory', service: null, region: null, links: [], group })
const many = (group: string, n: number) => Array.from({ length: n }, (_, i) => asset(`hub.${group}${i}`, group))
const island = { rx: 30, rz: 26 }
const kinds = ['Gateway', 'Broker']

describe('the hub with clusters of resource buildings', () => {
  it('keeps the size it always had when it holds none', () => {
    const plain = layoutTown([island, island, island], undefined, { rx: 20, rz: 18 })

    expect(layoutWithHubRoom([island, island, island], undefined, { rx: 20, rz: 18 }, [], kinds).hub).toEqual(plain.hub)
  })

  it('grows until every cluster has a place, and no place touches the plaza, a main building or a spoke road', () => {
    const assets = [...many('Logs', 3), ...many('Hub insights', 6), ...many('Platform insights', 5)]
    const plain = layoutTown([island, island, island], undefined, { rx: 20, rz: 18 })
    const layout = layoutWithHubRoom([island, island, island], undefined, { rx: 20, rz: 18 }, assets, kinds)
    const ports = [...layout.islands, layout.airport!].map((i) => i.portAngle)

    expect(layout.hub.scale).toBeGreaterThan(plain.hub.scale)
    const { clusters, left } = placeHubClusters(assets, layout.hub.rx, layout.hub.rz, HUB_CENTRE_Z, hubFree(layout.hub, kinds, ports))
    expect(left).toEqual([])
    expect(clusters).toHaveLength(3)
    for (const c of clusters) for (const r of hubReserved(layout.hub.scale, kinds, ports)) expect(rectsTouch(c, r)).toBe(false)
  })

  it('stays no bigger than needed: one step smaller would not hold them', () => {
    const assets = many('Logs', 3)
    const layout = layoutWithHubRoom([island, island, island], undefined, { rx: 20, rz: 18 }, assets, kinds)
    const smaller = layoutTown([island, island, island], undefined, { rx: 20, rz: 18 }, layout.hub.scale - 0.1)
    const ports = [...smaller.islands, smaller.airport!].map((i) => i.portAngle)

    if (layout.hub.scale > layoutTown([island, island, island], undefined, { rx: 20, rz: 18 }).hub.scale + 1e-9)
      expect(placeHubClusters(assets, smaller.hub.rx, smaller.hub.rz, HUB_CENTRE_Z, hubFree(smaller.hub, kinds, ports)).left).not.toEqual([])
  })
})
