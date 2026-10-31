// Which signals a system has a source for. A signal with no source is absent: the town shows nothing for it, which is not the same as grey
// (a source that is configured but has no fresh data) and not zero.

import type { NodeSnapshot } from './types'

export const SIGNALS = ['requests', 'errors', 'latency', 'instances', 'cpu', 'memory', 'utilisation', 'throttled', 'backlog', 'deadLetters'] as const
/** Every signal a registry names: the ten every building has and the jobs of a function building. */
export const KNOWN_SIGNALS = [...SIGNALS, 'jobs'] as const
export type Signal = (typeof KNOWN_SIGNALS)[number]

/** Words for a system with too few calls to judge: its error share and latency are left out, not shown as a good 0. */
export const QUIET_TEXT = 'quiet: too few calls to judge'

type WithAbsent = Pick<NodeSnapshot, never> & { absent?: readonly string[] | null; kind?: string; jobs?: readonly unknown[] | null }

export function isAbsent(n: WithAbsent, signal: Signal): boolean {
  return n.absent?.includes(signal) === true
}

/** A system no source is configured for at all. It stands in the town, but its numbers are not missing: there are none to show. */
export function isUnmonitored(n: WithAbsent): boolean {
  // a function building has one more signal: its jobs; the backend lists it as absent only when no source reads it
  return SIGNALS.every((s) => isAbsent(n, s)) && !(n.kind === 'Function' && !isAbsent(n, 'jobs'))
}

/** Whether no system in the snapshot has a source for the signal. A total built from it would be a made-up zero, so the top bar leaves it out. */
export function absentEverywhere(s: { groups: readonly { nodes: readonly WithAbsent[] }[] }, signal: Signal): boolean {
  const nodes = s.groups.flatMap((g) => g.nodes)
  return nodes.length > 0 && nodes.every((n) => isAbsent(n, signal))
}

/** The numbers that set a beacon's colour; with none of them the beacon is off. */
export function drivesBeacon(n: WithAbsent): boolean {
  return !(isAbsent(n, 'errors') && isAbsent(n, 'cpu') && isAbsent(n, 'memory') && isAbsent(n, 'utilisation') && isAbsent(n, 'throttled')) || (n.jobs?.length ?? 0) > 0
}
