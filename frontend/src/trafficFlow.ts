// What each pillar's services take in from outside the pillar, send to other pillars and handle among themselves, in requests a second. One place, so the
// dashboard and the signs in the town always say the same numbers.
//
// It is read from what the snapshot already says, the same numbers the bridges and the dependency overlay use:
//  - in:       what other pillars, the hub and third parties send to the pillar's services (the dependency links), plus what comes straight from outside
//              (the part of an API's traffic that no town system accounts for, `outsideRequestsPerSecond`);
//  - out:      what the pillar's services send to the services of other pillars (the same links, seen from the caller);
//  - internal: the rest of what its services take in, which is what they send each other.
// Where a source does not measure who calls whom, the links are an even share of the callee's rate, as everywhere else in the app.

import type { Snapshot } from './types'

export interface PillarTraffic {
  id: string
  in: number
  out: number
  internal: number
}

const rate = (v: number | null | undefined): number => (v != null && Number.isFinite(v) && v > 0 ? v : 0)

/** The traffic of every pillar that takes in or sends any request. */
export function pillarTraffic(s: Snapshot): Map<string, PillarTraffic> {
  const pillars = s.groups.filter((g) => !g.isHub)
  const ids = new Set(pillars.map((g) => g.id))
  const out = new Map<string, PillarTraffic>()
  for (const g of pillars) {
    const nodes = g.nodes.filter((n) => n.state !== 'Stale' && n.kind !== 'Database')
    const taken = nodes.reduce((a, n) => a + rate(n.requestsPerSecond), 0)
    const fromOutside = nodes.reduce((a, n) => a + rate(n.outsideRequestsPerSecond), 0)
    const fromLinks = s.dependencies.filter((d) => d.to === g.id && d.from !== g.id).reduce((a, d) => a + rate(d.requestsPerSecond), 0)
    const sent = s.dependencies.filter((d) => d.from === g.id && d.to !== g.id && ids.has(d.to)).reduce((a, d) => a + rate(d.requestsPerSecond), 0)
    const into = fromLinks + fromOutside
    if (taken <= 0 && into <= 0 && sent <= 0) continue
    out.set(g.id, { id: g.id, in: into, out: sent, internal: Math.max(0, taken - into) })
  }
  return out
}
