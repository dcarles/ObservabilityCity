// Messages a second from one pillar to another, for the dashboard's Message flow tile and the flows on each pillar card. Pure rules, no markup.
//
// A flow is read from the queues, not guessed: a queue a service reads has a rate (`perSecond`), and the subscription that names it says which pillar
// publishes it. Adding the queues up by (publishing pillar, reading pillar) gives the real rate of each pair. Only direct pillar-to-pillar queues count:
// the hub's own topics (the old egress route), the old pillar-to-pillar reads marked legacy, queues of the same pillar and queues whose publisher the
// names do not tell are left out. The town's boats split a pillar's total by the share of its subscriptions, so they only estimate this.

import type { Snapshot } from '../types'

export interface Flow {
  /** `from>to`: the publishing pillar and the reading pillar. */
  id: string
  from: string
  fromName: string
  to: string
  toName: string
  perSecond: number
}

/** How many pairs the tile lists before "show all". */
export const FLOW_TOP = 5
/** A pair slower than this is left out of the tile's short list (still in "show all"). */
export const FLOW_MIN = 1
/** A pair moves above the one before it only when it is this much bigger, so the lines do not trade places on every update. */
export const FLOW_SWAP = 1.15

/** Every pillar pair with messages flowing, biggest first. */
export function flowsOf(s: Snapshot): Flow[] {
  const names = new Map(s.groups.filter((g) => !g.isHub).map((g) => [g.id, g.displayName]))
  const sums = new Map<string, Flow>()
  for (const g of s.groups) {
    if (g.isHub) continue
    for (const sub of g.messaging?.subscriptions ?? []) {
      if (sub.legacy || sub.publisher === g.id || !names.has(sub.publisher)) continue
      const reader = g.nodes.find((n) => n.id === sub.consumer)
      const queue = reader?.queues?.find((q) => q.name === sub.topic)
      if (!queue || !(queue.perSecond != null && queue.perSecond > 0)) continue
      const id = `${sub.publisher}>${g.id}`
      const flow = sums.get(id) ?? { id, from: sub.publisher, fromName: names.get(sub.publisher)!, to: g.id, toName: g.displayName, perSecond: 0 }
      flow.perSecond += queue.perSecond
      sums.set(id, flow)
    }
  }
  return [...sums.values()].sort((a, b) => b.perSecond - a.perSecond || a.id.localeCompare(b.id))
}

/**
 * The flows in the order to show them. Pairs keep the order of the last draw (`previous`, a list of ids) unless a later pair is clearly bigger
 * (FLOW_SWAP); pairs seen for the first time go after the ones already listed, then take their place the same way.
 */
export function stableOrder(flows: readonly Flow[], previous: readonly string[]): Flow[] {
  const rank = new Map(previous.map((id, i) => [id, i]))
  const out = [...flows].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || b.perSecond - a.perSecond || a.id.localeCompare(b.id))
  for (let again = true; again;) {
    again = false
    for (let i = 1; i < out.length; i++) {
      if (out[i].perSecond > out[i - 1].perSecond * FLOW_SWAP) { [out[i - 1], out[i]] = [out[i], out[i - 1]]; again = true }
    }
  }
  return out
}

export interface FlowTile {
  /** The short list: the biggest pairs of at least FLOW_MIN, at most FLOW_TOP. */
  top: Flow[]
  /** Every pair with messages, in the same order. */
  all: Flow[]
  /** The busiest pair's rate, which the bars are scaled to. */
  max: number
}

export function flowTile(flows: readonly Flow[], previous: readonly string[]): FlowTile | null {
  if (flows.length === 0) return null
  const all = stableOrder(flows, previous)
  return { top: all.filter((f) => f.perSecond >= FLOW_MIN).slice(0, FLOW_TOP), all, max: Math.max(...flows.map((f) => f.perSecond)) }
}

/** What one pillar sends and receives, biggest first. */
export interface PillarFlows { out: Flow[]; in: Flow[] }

export function pillarFlows(flows: readonly Flow[], pillar: string): PillarFlows {
  return { out: flows.filter((f) => f.from === pillar), in: flows.filter((f) => f.to === pillar) }
}
