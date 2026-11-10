// The overview stops of an alert tour: the whole town first, then each pillar island in the order they stand round the hub (the hub itself is left out). Pure.

import type { Snapshot } from '../types'
import type { Attention, Focus } from './attention'
import { servicesText } from './servicesText'

export interface OverviewStop {
  /** `overview` for the whole town, `overview:island:<id>` for an island. */
  key: string
  focus: Focus
  caption: string
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** "Overview: 3 systems need attention across 2 islands", or the incident count when only incidents are about. */
export function overviewCaption(s: Snapshot, attention: readonly Attention[]): string {
  const systems = attention.filter((a) => a.kind !== 'incident')
  const islands = new Set<string>()
  for (const a of attention) {
    if (a.focus.kind === 'island') islands.add(a.focus.id)
    else if (a.focus.kind === 'building') {
      const id = a.focus.id
      const g = s.groups.find((x) => x.nodes.some((n) => n.id === id))
      if (g) islands.add(g.id)
    }
  }
  if (systems.length === 0) return `Overview: ${plural(attention.length, 'incident')}`
  const where = islands.size > 0 ? ` across ${plural(islands.size, 'island')}` : ''
  return `Overview: ${plural(systems.length, 'system')} ${systems.length === 1 ? 'needs' : 'need'} attention${where}`
}

/**
 * The whole town, then every island the snapshot shows (a team's view has only its own) with `islandSeconds` above 0, each as "Overview: Name, 4 services plus scheduler".
 * Islands are the groups in snapshot order, which is the order they stand round the hub.
 */
export function overviewStops(s: Snapshot, attention: readonly Attention[], islandSeconds: number): OverviewStop[] {
  const stops: OverviewStop[] = [{ key: 'overview', focus: { kind: 'home', id: '' }, caption: overviewCaption(s, attention) }]
  if (islandSeconds <= 0) return stops
  for (const g of s.groups) {
    if (g.isHub || g.nodes.length === 0) continue
    stops.push({ key: `overview:island:${g.id}`, focus: { kind: 'island', id: g.id }, caption: `Overview: ${g.displayName}, ${servicesText(g.nodes)}` })
  }
  return stops
}
