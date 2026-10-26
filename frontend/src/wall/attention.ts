// What needs looking at on the wall: incidents first, then systems that are down, then degraded ones, then systems with no data. Pure: a snapshot in, a list out.

import type { GroupSnapshot, NodeSnapshot, Snapshot } from '../types'
import { reasons } from '../inspectorModel'

export type AttentionKind = 'incident' | 'down' | 'degraded' | 'stale'

/** Where the camera goes: an island (the hub is 'hub'), one building, or the whole town. */
export interface Focus {
  kind: 'island' | 'building' | 'home'
  id: string
}

export interface Attention {
  /** Unique and stable while the trouble lasts: kind and the id of what it is about. */
  key: string
  /** What the trouble is about: an incident id or a system id. Stays the same when a degraded system goes down. */
  subject: string
  kind: AttentionKind
  focus: Focus
  /** What the caption says. */
  caption: string
  /** The name of the thing, for notes such as "Payments API is healthy again". */
  name: string
}

const RANK: Record<AttentionKind, number> = { incident: 0, down: 1, degraded: 2, stale: 3 }

/** Highest priority first: how bad (incident, down, degraded, no data) and then how busy the system is, so the loudest trouble comes first. */
export function attentionOf(s: Snapshot): Attention[] {
  const items: (Attention & { weight: number; order: number })[] = []
  let order = 0
  const groups: Pick<GroupSnapshot, 'id' | 'displayName' | 'incidents' | 'nodes'>[] = s.groups
  for (const g of groups) {
    for (const inc of g.incidents) {
      items.push({
        key: `incident:${inc.id}`, subject: inc.id, kind: 'incident', focus: { kind: 'island', id: g.id }, name: g.displayName,
        caption: `Sev ${inc.severity} incident on ${g.displayName}: ${inc.title}`,
        weight: 5 - inc.severity, order: order++,
      })
    }
  }
  const add = (n: NodeSnapshot, where: string) => {
    const kind: AttentionKind | null = n.state === 'Down' ? 'down' : n.state === 'Degraded' ? 'degraded' : n.state === 'Stale' ? 'stale' : null
    if (!kind) return
    const why = kind === 'down' ? 'is down' : kind === 'stale' ? 'has no fresh data' : `is degraded: ${reasons(n)[0]?.replace(/\.$/, '') ?? 'running outside its limits'}`
    items.push({
      key: `${kind}:${n.id}`, subject: n.id, kind, focus: { kind: 'building', id: n.id }, name: n.name,
      caption: `${n.name}${where ? ` (${where})` : ''} ${why}`,
      weight: n.requestsPerSecond, order: order++,
    })
  }
  for (const g of groups) for (const n of g.nodes) add(n, g.displayName)
  for (const v of s.vendors) add(v.node, 'third party')
  return items
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.weight - a.weight || a.order - b.order)
    .map(({ weight: _w, order: _o, ...rest }) => rest)
}
