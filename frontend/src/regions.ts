// The per-region view as pure functions. A service that runs in two or more regions arrives with the numbers of its worst region on the building
// and every region listed; the viewer can look at one region instead. Nothing here touches three.js.

import type { NodeSnapshot } from './types'

/** What the viewer looks at: the region under most pressure (the default), or one region by its id. */
export type RegionChoice = 'worst' | (string & {})

export const WORST: RegionChoice = 'worst'

export interface RegionOption {
  id: RegionChoice
  label: string
}

/** The choices for a building: none unless it runs in two or more regions. */
export function regionOptions(n: Pick<NodeSnapshot, 'regions'>): RegionOption[] {
  const regions = n.regions ?? []
  if (regions.length < 2) return []
  return [{ id: 'worst', label: 'Worst' }, ...regions.map((r) => ({ id: r.region, label: r.label }))]
}

/** A choice the building has (a region that left the snapshot falls back to the default). */
export function validChoice(n: Pick<NodeSnapshot, 'regions'>, choice: RegionChoice): RegionChoice {
  return regionOptions(n).some((o) => o.id === choice) ? choice : WORST
}

/**
 * The node as the viewer's choice shows it. Worst is the node as the backend sent it; one region puts that region's instances, CPU and memory on the
 * building. Health is not recomputed: it is the backend's, from the worst region, whatever the viewer looks at.
 */
export function withRegion(n: NodeSnapshot, choice: RegionChoice): NodeSnapshot {
  const regions = n.regions ?? []
  if (regions.length < 2 || choice === WORST) return n
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
  const chosen = choice === WORST ? null : regions.find((r) => r.region === choice)
  if (chosen) return chosen.label
  return `${worstRegion(n)} (worst of ${regions.length})`
}

/** A share as a whole percent; under one percent it says so rather than 0. */
export function sharePercent(share: number): string {
  const pct = share * 100
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`
}

/**
 * How a service divides its requests between its regions, for the sign and the drawer ("North 95% · West 5%"). Null when no region has a measured share.
 * `hot` is true when the backend flagged a region for taking more than the environment allows while another region runs.
 */
export function splitLine(n: Pick<NodeSnapshot, 'regions'>): { text: string; hot: boolean } | null {
  const regions = n.regions ?? []
  if (regions.length < 2 || regions.every((r) => r.share == null)) return null
  const measured = regions.filter((r) => r.share != null)
  return { text: measured.map((r) => `${r.label} ${sharePercent(r.share!)}`).join(' · '), hot: regions.some((r) => r.skewed === true) }
}

/**
 * What the drawer says about one region: the instances only when there is a real count (a plan that gives none says nothing about them), CPU and memory when
 * a source reports them, and its part of the requests when they are measured.
 */
export function regionFigures(r: NonNullable<NodeSnapshot['regions']>[number]): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`
  return [
    r.instances == null ? null : `${r.instances} ${r.instances === 1 ? 'instance' : 'instances'}`,
    r.cpu == null ? null : `CPU ${pct(r.cpu)}`,
    r.memory == null ? null : `memory ${pct(r.memory)}`,
    r.share == null ? null : `${sharePercent(r.share)} of requests`,
  ].filter((p) => p !== null).join(' · ')
}
