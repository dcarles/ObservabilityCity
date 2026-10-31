// The per-region view as pure functions. A service that runs in two or more regions arrives with the numbers of its worst region on the building
// and every region listed; the viewer can look at one region instead, or at all of them together. Nothing here touches three.js.

import type { NodeSnapshot } from './types'

/** What the viewer looks at: the region under most pressure (the default), all regions together, or one region by its id. */
export type RegionChoice = 'worst' | 'all' | (string & {})

export const WORST: RegionChoice = 'worst'

export interface RegionOption {
  id: RegionChoice
  label: string
}

/** The choices for a building: none unless it runs in two or more regions. */
export function regionOptions(n: Pick<NodeSnapshot, 'regions'>): RegionOption[] {
  const regions = n.regions ?? []
  if (regions.length < 2) return []
  return [{ id: 'worst', label: 'Worst' }, { id: 'all', label: 'All' }, ...regions.map((r) => ({ id: r.region, label: r.label }))]
}

/** A choice the building has (a region that left the snapshot falls back to the default). */
export function validChoice(n: Pick<NodeSnapshot, 'regions'>, choice: RegionChoice): RegionChoice {
  return regionOptions(n).some((o) => o.id === choice) ? choice : WORST
}

const busiest = (a: number | null | undefined, b: number | null | undefined): number | null => (a == null ? b ?? null : b == null ? a : Math.max(a, b))

/**
 * The node as the viewer's choice shows it. Worst is the node as the backend sent it; one region puts that region's instances, CPU and memory on the
 * building; all puts the instances of every region together (when each reports a count) and the busiest CPU and memory. Health is not recomputed: it is the
 * backend's, from the worst region, whatever the viewer looks at.
 */
export function withRegion(n: NodeSnapshot, choice: RegionChoice): NodeSnapshot {
  const regions = n.regions ?? []
  if (regions.length < 2 || choice === WORST) return n
  if (choice === 'all') {
    const counted = regions.every((r) => r.instances != null)
    const total = counted ? regions.reduce((a, r) => a + (r.instances ?? 0), 0) : n.instancesTotal
    return {
      ...n,
      instancesTotal: total,
      instancesHealthy: counted ? total : n.instancesHealthy,
      cpu: regions.reduce<number | null>((a, r) => busiest(a, r.cpu), null) ?? n.cpu,
      memory: regions.reduce<number | null>((a, r) => busiest(a, r.memory), null) ?? n.memory,
    }
  }
  const one = regions.find((r) => r.region === choice)
  if (!one) return n
  return {
    ...n,
    instancesTotal: one.instances ?? n.instancesTotal,
    instancesHealthy: one.instances ?? n.instancesHealthy,
    cpu: one.cpu ?? n.cpu,
    memory: one.memory ?? n.memory,
  }
}

/** The region the backend put on the building: the one whose numbers it carries. Null when no region has a number to go by. */
export function worstRegion(n: Pick<NodeSnapshot, 'regions' | 'cpu' | 'memory'>): string | null {
  const regions = n.regions ?? []
  if (regions.length < 2) return null
  const pressure = (r: (typeof regions)[number]) => Math.max(r.cpu ?? 0, r.memory ?? 0)
  const top = regions.reduce((a, r) => (pressure(r) > pressure(a) ? r : a), regions[0]!)
  return top.label
}

/** The line under a building's name that says which region its numbers are, so the region shown is never ambiguous. Empty for a one-region service. */
export function regionLine(n: Pick<NodeSnapshot, 'regions' | 'cpu' | 'memory'>, choice: RegionChoice): string {
  const regions = n.regions ?? []
  if (regions.length < 2) return ''
  if (choice === 'all') return `all ${regions.length} regions`
  const chosen = choice === WORST ? null : regions.find((r) => r.region === choice)
  if (chosen) return chosen.label
  return `${worstRegion(n)} (worst of ${regions.length})`
}
