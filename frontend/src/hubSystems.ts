// The hub can hold several systems of one kind: two gateways, two brokers. Each is its own building, but some things in the town stand for the
// kind as a whole (the gateway the airport's traffic goes through, the words of the wall's hub caption). These pure helpers say what the
// kind adds up to, so one gateway or one broker reads exactly as it always did.

import type { HealthState, NodeSnapshot } from './types'
import { speedFactor, worstState } from './visuals'

/** What the hub's gateways add up to: the requests of them all, the error rate weighted by requests, and the worst state of any. */
export interface GatewayTotal {
  requestsPerSecond: number
  errorRate: number
  state: HealthState
  /** How many gateways there are. */
  count: number
}

/** The hub's gateways together; null when the hub has none. One gateway gives its own numbers unchanged. */
export function combinedGateways(nodes: readonly NodeSnapshot[]): GatewayTotal | null {
  const gateways = nodes.filter((n) => n.kind === 'Gateway')
  if (gateways.length === 0) return null
  if (gateways.length === 1) {
    const [g] = gateways
    return { requestsPerSecond: g.requestsPerSecond, errorRate: g.errorRate, state: g.state, count: 1 }
  }
  const rps = gateways.reduce((a, g) => a + g.requestsPerSecond, 0)
  // with no requests anywhere there is nothing to weigh by: the plain mean, so an error rate still shows
  const errorRate = rps > 0 ? gateways.reduce((a, g) => a + g.errorRate * g.requestsPerSecond, 0) / rps : gateways.reduce((a, g) => a + g.errorRate, 0) / gateways.length
  return { requestsPerSecond: rps, errorRate, state: worstState(gateways.map((g) => g.state)), count: gateways.length }
}

/** The names of the hub's brokers, in the order the hub lists them. */
export function brokerNames(nodes: readonly NodeSnapshot[]): string[] {
  return nodes.filter((n) => n.kind === 'Broker').map((n) => n.name)
}

/** Names as a list in words: "A", "A and B", "A, B and C". */
export function andList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** What the boats follow: whether any broker is up, and the sailing speed of the slowest one that is. */
export interface BrokerSea {
  running: boolean
  speed: number
}

/**
 * The boats stand for the town's messaging as a whole, so they sail while at least one broker is up and sail as slowly as the slowest of those.
 * A broker with no reading yet counts as up at normal speed, and a hub with no broker leaves the boats as they were. One broker gives its own answer.
 */
export function brokerSea(brokers: readonly (Pick<NodeSnapshot, 'state' | 'p99Ms' | 'slaP99Ms'> | null | undefined)[]): BrokerSea {
  const up = brokers.filter((b) => b?.state !== 'Down')
  if (brokers.length > 0 && up.length === 0) return { running: false, speed: 1 }
  const speeds = up.map((b) => (b ? speedFactor(b.p99Ms, b.slaP99Ms) : 1))
  return { running: true, speed: speeds.length > 0 ? Math.min(...speeds) : 1 }
}
