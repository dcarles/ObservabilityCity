// What each pillar sends to the other pillars and receives from them, in messages a second, for the dashboard's Message flow tile and the flow on each pillar card.
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
  /** The time the rates are averaged over, as the source's window says. */
  windowSeconds: number
}

/** How many pillars the tile lists before "show all". */
export const FLOW_TOP = 5
/** A pillar moving less than this (on its busier side) is left out of the tile's short list (still in "show all"). */
export const FLOW_MIN = 1
/** A pillar moves above the one before it only when it is this much busier, so the lines do not trade places on every update. */
export const FLOW_SWAP = 1.15

/** The rate of the pillar's busier side. */
export const busiest = (f: Flow): number => Math.max(f.sent ?? 0, f.received ?? 0)

/** Every pillar with a measured flow, busiest first. */
export function flowsOf(s: Snapshot): Flow[] {
  return s.groups
    .filter((g) => !g.isHub && g.flow && (g.flow.sentPerSecond != null || g.flow.receivedPerSecond != null))
    .map((g) => ({ id: g.id, name: g.displayName, sent: g.flow!.sentPerSecond ?? null, received: g.flow!.receivedPerSecond ?? null, windowSeconds: g.flow!.windowSeconds }))
    .sort((a, b) => busiest(b) - busiest(a) || a.name.localeCompare(b.name))
}

/**
 * The flows in the order to show them. Pillars keep the order of the last draw (`previous`, a list of ids) unless a later one is clearly busier
 * (FLOW_SWAP); pillars seen for the first time go after the ones already listed, then take their place the same way.
 */
export function stableOrder(flows: readonly Flow[], previous: readonly string[]): Flow[] {
  const rank = new Map(previous.map((id, i) => [id, i]))
  const out = [...flows].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || busiest(b) - busiest(a) || a.name.localeCompare(b.name))
  for (let again = true; again;) {
    again = false
    for (let i = 1; i < out.length; i++) {
      if (busiest(out[i]) > busiest(out[i - 1]) * FLOW_SWAP) { [out[i - 1], out[i]] = [out[i], out[i - 1]]; again = true }
    }
  }
  return out
}

export interface FlowTile {
  /** The short list: the busiest pillars of at least FLOW_MIN, at most FLOW_TOP. */
  top: Flow[]
  /** Every pillar with a measured flow that moves anything, in the same order. */
  all: Flow[]
  /** The busiest rate of any pillar, which the bars are scaled to. */
  max: number
  /** The time the rates are averaged over (the source's window), for the line under the list. */
  windowSeconds: number
}

/** The tile, or null when no pillar moves any message (then the tile is left out). */
export function flowTile(flows: readonly Flow[], previous: readonly string[]): FlowTile | null {
  const moving = flows.filter((f) => busiest(f) > 0)
  if (moving.length === 0) return null
  const all = stableOrder(moving, previous)
  return { top: all.filter((f) => busiest(f) >= FLOW_MIN).slice(0, FLOW_TOP), all, max: Math.max(...moving.map(busiest)), windowSeconds: Math.max(...moving.map((f) => f.windowSeconds)) }
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
