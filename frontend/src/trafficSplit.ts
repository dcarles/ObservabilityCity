// How the town's request rate splits into what comes from outside (the airport) and what is internal traffic. One place, so the dashboard and the
// airport board always show the same numbers.

import type { Snapshot } from './types'
import { absentEverywhere } from './signals'

export interface TrafficSplit {
  total: number
  external: number
  internal: number
}

/**
 * `total` is the request rate of the systems on view and `share` the part of the environment's traffic that is on view (1 for all of it). The
 * outside part is what the server measured, else what the hub's declared callers add up to, and can never be more than the total. Null when no
 * system reports a request rate, because then there is nothing to split.
 */
export function trafficSplit(s: Snapshot, total: number, share = 1): TrafficSplit | null {
  if (absentEverywhere(s, 'requests')) return null
  const outside = s.outsideRequestsPerSecond ?? s.externalCallers.reduce((a, c) => a + c.requestsPerSecond, 0)
  const external = Math.min(total, outside * share)
  return { total, external, internal: Math.max(0, total - external) }
}
