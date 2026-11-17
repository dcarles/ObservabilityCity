// What each pillar sends to the other pillars and receives from them, in messages a second, for the flow on each pillar card.
// Pure rules, no markup.
//
// The numbers are read from the broker, not guessed: the environment says which broker entities carry a pillar's traffic (its egress topic, the topic its
// ingress queues hang on), and the backend reports the rate of each as `group.flow`. They are totals per pillar. The names of those entities say the pillar,
// never the other end, so nothing here says who sent what to whom. A side the environment does not measure is null and is left out, not shown as 0.

import type { Snapshot } from '../types'

export interface Flow {
  /** The pillar's id. */
  id: string
  name: string
  /** Messages a second the pillar sends to other pillars; null when nothing measures it. */
  sent: number | null
  /** Messages a second other pillars send to it; null when nothing measures it. */
  received: number | null
  /** Messages a second the pillar's own services send each other, the sum of the queues they read from a service of the same pillar; null when none of those queues is measured. */
  internal: number | null
  /** The time the rates are averaged over, as the source's window says. */
  windowSeconds: number
}

/** The rate of the pillar's busier side. */
export const busiest = (f: Flow): number => Math.max(f.sent ?? 0, f.received ?? 0, f.internal ?? 0)

/**
 * What each pillar's own services send each other: the rate of every queue a service reads from another service of its own pillar (the subscription says the
 * publisher is the same pillar), added up. This is the number the town's boats inside an island use. Null for a pillar whose such queues are not measured.
 */
export function internalOf(s: Snapshot): Map<string, number> {
  const out = new Map<string, number>()
  for (const g of s.groups) {
    if (g.isHub) continue
    for (const sub of g.messaging?.subscriptions ?? []) {
      if (sub.publisher !== g.id) continue
      const queue = g.nodes.find((n) => n.id === sub.consumer)?.queues?.find((q) => q.name === sub.topic)
      if (queue?.perSecond != null) out.set(g.id, (out.get(g.id) ?? 0) + queue.perSecond)
    }
  }
  return out
}

/** Every pillar with a measured flow (external either way, or internal), busiest first. */
export function flowsOf(s: Snapshot): Flow[] {
  const internal = internalOf(s)
  return s.groups
    .filter((g) => !g.isHub && ((g.flow && (g.flow.sentPerSecond != null || g.flow.receivedPerSecond != null)) || internal.has(g.id)))
    .map((g) => ({
      id: g.id, name: g.displayName, sent: g.flow?.sentPerSecond ?? null, received: g.flow?.receivedPerSecond ?? null,
      internal: internal.get(g.id) ?? null, windowSeconds: g.flow?.windowSeconds ?? 0,
    }))
    .sort((a, b) => busiest(b) - busiest(a) || a.name.localeCompare(b.name))
}

/** The pillar's flow, or null when nothing measures it. */
export function pillarFlow(flows: readonly Flow[], pillar: string): Flow | null {
  return flows.find((f) => f.id === pillar) ?? null
}

/** A window as people say it: "15 min", "90 s", "2 h". Nothing for a window of no length. */
export function windowText(seconds: number): string {
  if (!(seconds > 0)) return ''
  if (seconds < 60) return `${Math.round(seconds)} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}
