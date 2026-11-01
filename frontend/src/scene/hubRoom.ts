import type { AssetSnapshot } from '../types'
import { layoutTown, type IslandSize, type TownLayout } from './layout'
import { HUB_CENTRE_Z, hubFree, placeHubClusters } from './plan'

/**
 * The town's layout, with the hub grown (a tenth of its scale at a time) until every cluster of resource buildings it holds has a place of its own, clear of the
 * plaza, the main buildings and the spoke roads. A hub with none keeps the size it always had.
 */
export function layoutWithHubRoom(
  sizes: IslandSize[], capacity: number | undefined, airportSize: IslandSize | null, hubAssets: readonly AssetSnapshot[], hubKinds: readonly string[],
): TownLayout {
  let layout = layoutTown(sizes, capacity, airportSize)
  const room = (l: TownLayout) => {
    const ports = [...l.islands, ...(l.airport ? [l.airport] : [])].map((i) => i.portAngle)
    return placeHubClusters(hubAssets, l.hub.rx, l.hub.rz, HUB_CENTRE_Z, hubFree(l.hub, hubKinds, ports)).left.length === 0
  }
  for (let step = 0; hubAssets.length > 0 && !room(layout) && step < 60; step++) layout = layoutTown(sizes, capacity, airportSize, layout.hub.scale + 0.1)
  return layout
}
