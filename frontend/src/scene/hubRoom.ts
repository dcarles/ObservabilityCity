import type { AssetSnapshot } from '../types'
import { layoutTown, type IslandSize, type TownLayout } from './layout'
import { HUB_CENTRE_Z, hubFree, placeHubBuildings, placeHubClusters } from './plan'

/**
 * The town's layout, with the hub grown (a tenth of its scale at a time) until every further building of a kind (a second broker, a second gateway) and every cluster
 * of resource buildings it holds has a place of its own, clear of the plaza, the main buildings and the spoke roads. A hub with one of each kind and no clusters keeps
 * the size it always had. `hubKinds` is the kind of each hub system, in the hub's order.
 */
export function layoutWithHubRoom(
  sizes: IslandSize[], capacity: number | undefined, airportSize: IslandSize | null, hubAssets: readonly AssetSnapshot[], hubKinds: readonly string[], lanes = false,
): TownLayout {
  let layout = layoutTown(sizes, capacity, airportSize, 0, lanes)
  const nodes = hubKinds.map((kind, i) => ({ id: `${i}`, kind }))
  const room = (l: TownLayout) => {
    const ports = [...l.islands, ...(l.airport ? [l.airport] : [])].map((i) => i.portAngle)
    const buildings = placeHubBuildings(nodes, l.hub, ports)
    if (buildings.left.length > 0) return false
    return placeHubClusters(hubAssets, l.hub.rx, l.hub.rz, HUB_CENTRE_Z, hubFree(l.hub, hubKinds, ports, buildings.reserved)).left.length === 0
  }
  const extras = hubKinds.length > new Set(hubKinds).size
  for (let step = 0; (hubAssets.length > 0 || extras) && !room(layout) && step < 60; step++) layout = layoutTown(sizes, capacity, airportSize, layout.hub.scale + 0.1, lanes)
  return layout
}
