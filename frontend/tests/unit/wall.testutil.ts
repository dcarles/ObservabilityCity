import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { HealthState, NodeSnapshot, Snapshot } from '../../src/types'

const calm = JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/calm.json'), 'utf8')) as Snapshot

/** The healthy sample town (Galactic Credit, 17 islands and the hub). A fresh copy every time, so a test can change it. */
export const healthyTown = (): Snapshot => structuredClone(calm)

const allNodes = (s: Snapshot): NodeSnapshot[] => [...s.groups.flatMap((g) => g.nodes), ...s.vendors.map((v) => v.node)]

/** The same town with one system in another state. The totals follow, as the backend would work them out. */
export function withState(s: Snapshot, id: string, state: HealthState, patch: Partial<NodeSnapshot> = {}): Snapshot {
  const out = structuredClone(s)
  const n = allNodes(out).find((x) => x.id === id)
  if (!n) throw new Error(`no system ${id}`)
  Object.assign(n, { state }, patch)
  recount(out)
  return out
}

/** The same town with an open incident on an island. */
export function withIncident(s: Snapshot, groupId: string, incident: { id: string; severity: number; title: string }): Snapshot {
  const out = structuredClone(s)
  out.groups.find((g) => g.id === groupId)!.incidents.push({ ...incident, startedAt: out.generatedAt })
  recount(out)
  out.incidentFreeSince = null
  out.incidentsSeen = true
  return out
}

/** The same town seen only through some islands (the hub stays), as the backend's island filter makes it. */
export function onlyIslands(s: Snapshot, ids: string[]): Snapshot {
  const out = structuredClone(s)
  out.groups = out.groups.filter((g) => g.isHub || ids.includes(g.id))
  const shown = new Set(out.groups.flatMap((g) => g.nodes.map((n) => n.id)))
  out.vendors = out.vendors.filter((v) => v.calledBy.some((id) => shown.has(id)))
  recount(out)
  return out
}

function recount(s: Snapshot): void {
  const nodes = allNodes(s)
  s.totals.degraded = nodes.filter((n) => n.state === 'Degraded').length
  s.totals.down = nodes.filter((n) => n.state === 'Down').length
  s.totals.incidents = s.groups.reduce((a, g) => a + g.incidents.length, 0)
}
