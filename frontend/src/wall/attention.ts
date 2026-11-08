// What needs looking at on the wall: incidents first, then systems that are down, then systems with dead letters, then degraded ones, then systems with no data. Pure: a snapshot in, a list out.

import { isUnmonitored } from '../signals'
import type { GroupSnapshot, NodeSnapshot, Snapshot } from '../types'
import { reasons } from '../inspectorModel'
import { dlqCount } from '../deadLetters'
import { formatCount } from '../visuals'

export type AttentionKind = 'incident' | 'down' | 'deadLetters' | 'degraded' | 'stale'

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

/** How bad each kind is, worst first. */
export const RANK: Record<AttentionKind, number> = { incident: 0, down: 1, deadLetters: 2, degraded: 3, stale: 4 }

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
    const dead = n.state === 'Stale' || isUnmonitored(n) ? 0 : dlqCount(n)
    // a system that is healthy by its own numbers but has dead letters waiting is still a stop: a message nobody could handle sits in a queue
    const kind: AttentionKind | null = n.state === 'Down' ? 'down' : n.state === 'Degraded' ? 'degraded' : n.state === 'Stale' && !isUnmonitored(n) ? 'stale'
      : dead > 0 ? 'deadLetters' : null
    if (!kind) return
    const deadText = dead > 0 ? deadLettersText(n, dead) : ''
    const why = kind === 'down' ? 'is down' : kind === 'stale' ? 'has no fresh data' : kind === 'deadLetters' ? deadText
      : `is degraded: ${reasons(n)[0]?.replace(/\.$/, '') ?? 'running outside its limits'}${dead > 0 ? ` · ${deadText.replace(/^has /, '')}` : ''}`
    items.push({
      key: `${kind}:${n.id}`, subject: n.id, kind, focus: { kind: 'building', id: n.id }, name: n.name,
      caption: `${n.name}${where ? ` (${where})` : ''} ${why}`,
      weight: kind === 'deadLetters' ? dead : n.requestsPerSecond, order: order++,
    })
  }
  for (const g of groups) for (const n of g.nodes) add(n, g.displayName)
  for (const v of s.vendors) add(v.node, v.internal ? 'internal service' : 'third party')
  return items
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.weight - a.weight || a.order - b.order)
    .map(({ weight: _w, order: _o, ...rest }) => rest)
}

/** "has 130 dead letters in q-orders", naming the queue with the most (and how many more queues have some). */
export function deadLettersText(n: Pick<NodeSnapshot, 'queues'>, total: number): string {
  const queues = (n.queues ?? []).filter((q) => (q.deadLetters ?? 0) > 0).sort((a, b) => (b.deadLetters ?? 0) - (a.deadLetters ?? 0) || a.name.localeCompare(b.name))
  const words = `${formatCount(total)} dead letter${total === 1 ? '' : 's'}`
  if (queues.length === 0) return `has ${words}`
  const more = queues.length - 1
  return `has ${words} in ${queues[0].name}${more > 0 ? ` and ${more} more queue${more === 1 ? '' : 's'}` : ''}`
}
