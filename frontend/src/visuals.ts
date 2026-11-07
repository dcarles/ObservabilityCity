// The visual language as pure functions: numbers from a snapshot in, visual parameters out.
// Nothing here touches three.js, so it is unit tested against the same golden fixtures as the backend.

import { drivesBeacon, isAbsent, isUnmonitored } from './signals'
import type { HealthState, NodeSnapshot } from './types'

export const MAX_FLOORS = 8

/** Floors on a doubling scale: 1, 2, 3-4, 5-8, 9-16, 17-32, 33-64, 65+ instances give 1 to 8 floors. */
export function floorsFor(instances: number): number {
  if (instances <= 1) return 1
  if (instances === 2) return 2
  const tier = Math.ceil(Math.log2(instances)) + 1
  return Math.min(MAX_FLOORS, tier)
}

/** Dark, cracked floors: the share of unhealthy instances, at least one floor if any are unhealthy. */
export function darkFloorsFor(total: number, healthy: number, floors: number): number {
  if (total <= 0 || healthy >= total) return 0
  if (healthy <= 0) return floors
  return Math.max(1, Math.min(floors - 1, Math.round(((total - healthy) / total) * floors)))
}

/** Share of windows that are lit. Never fully dark while the building is up, so a quiet service still looks alive. */
export function litFraction(load: number): number {
  return clamp(load * 1.25, 0.1, 1)
}

/** off: nothing is measured that would colour it (no source for errors or resources), so the lamp is dark. */
export type BeaconLevel = 'green' | 'amber' | 'red' | 'grey' | 'off'

/** Share of capacity in use across CPU, memory and a data store's utilisation: the busiest one counts. */
export function resourceUse(n: Pick<NodeSnapshot, 'cpu' | 'memory' | 'utilisation'> & Partial<Pick<NodeSnapshot, 'absent'>>): number {
  // a signal nothing supplies counts for nothing, whatever number comes with it
  const seen = (signal: 'cpu' | 'memory' | 'utilisation') => (isAbsent(n, signal) ? 0 : n[signal] ?? 0)
  return Math.max(seen('cpu'), seen('memory'), seen('utilisation'))
}

type BeaconInput = Pick<NodeSnapshot, 'state' | 'errorRate' | 'errorAmber' | 'errorRed'> &
  Partial<Pick<NodeSnapshot, 'cpu' | 'memory' | 'utilisation' | 'throttled' | 'resourceAmber' | 'throttleAmber' | 'throttleRed' | 'absent' | 'jobs' | 'deadLetters'>>

/**
 * Rooftop beacon colour. Red means requests are failing: a system that is down (the beacon then stays on, steady), errors
 * past the red threshold, or a data store turning requests away past its throttle threshold. Amber is the warning: errors, throttling or CPU,
 * memory or utilisation past their amber thresholds, and dead letters in a queue it reads.
 */
export function beaconLevel(n: BeaconInput): BeaconLevel {
  if (!drivesBeacon(n)) return 'off' // nothing here is measured: not grey, there is no data to be missing
  if (n.state === 'Stale') return 'grey'
  if (n.state === 'Down') return 'red' // a system that is down is red whatever its error rate or silence says
  const throttled = n.throttled ?? 0
  if (n.errorRate >= n.errorRed || (n.throttleRed !== undefined && throttled >= n.throttleRed)) return 'red'
  if (n.errorRate >= n.errorAmber) return 'amber'
  // a function's scheduled jobs: one that failed its last run or did not run when it should have is amber (the app runs); every job failed is Down, red above
  if (n.jobs?.some((j) => j.status === 'Failed' || j.status === 'Overdue')) return 'amber'
  if (n.throttleAmber !== undefined && throttled >= n.throttleAmber) return 'amber'
  // messages that could not be delivered sit in the queue this system reads: a warning on it, so the one to open is not green
  if ((n.deadLetters ?? 0) > 0 && !isAbsent(n, 'deadLetters')) return 'amber'
  if (n.resourceAmber !== undefined && resourceUse(n) >= n.resourceAmber) return 'amber'
  return 'green'
}

/** Walker speed multiplier: full speed when p99 is well inside the SLA, crawling as it reaches and passes it. */
export function speedFactor(p99Ms: number, slaP99Ms: number): number {
  const ratio = slaP99Ms > 0 ? p99Ms / slaP99Ms : 0
  return clamp(1.1 - 0.7 * ratio, 0.25, 1.1)
}

/** Walkers arriving per second at a building: grows with request rate, but gently so busy services stay readable. */
export function spawnRate(rps: number): number {
  return rps <= 0 ? 0 : 0.1 * Math.pow(rps, 0.6)
}

/** The fewest cars a confirmed link sends: one every 20 seconds, so a small link still shows life on its road. */
export const MIN_CAR_RATE = 1 / 20

/**
 * Cars leaving per second on one route: the destination's request rate, gently scaled, times the route's share and the town's own settings.
 * A route with a real share (something is measured or declared on it) never sends fewer than MIN_CAR_RATE cars a second, however small the share;
 * above that the rate follows the traffic as before. With no traffic at all, or the cars turned off (scale 0), it sends none.
 */
export function carRate(rps: number, share: number, scale: number, traffic: number): number {
  if (!(rps > 0) || !(share > 0) || !(scale > 0)) return 0
  return Math.max(spawnRate(rps) * traffic * scale * share, MIN_CAR_RATE * scale)
}

/** The fewest boats a real route sends: one every 30 seconds, so a quiet route still shows a boat now and then. */
export const MIN_BOAT_RATE = 1 / 30

/** The most boats one route sends a second, however busy: more would only crowd the boat pool. */
export const MAX_BOAT_RATE = 1.5

/**
 * Boats leaving per second on one sea lane: the messages a second that reach the island, scaled like the cars (gently, so a very busy broker stays readable),
 * times the lane's share of them. A lane with messages on it never sends fewer than MIN_BOAT_RATE boats a second, however small its share. No messages: none.
 */
export function boatRate(messagesPerSecond: number, share: number): number {
  if (!(messagesPerSecond > 0) || !(share > 0)) return 0
  return Math.min(MAX_BOAT_RATE, Math.max(0.04 * Math.pow(messagesPerSecond, 0.6) * share, MIN_BOAT_RATE))
}

export function plaqueText(n: Pick<NodeSnapshot, 'state' | 'instancesTotal' | 'instancesHealthy'> & Partial<Pick<NodeSnapshot, 'absent' | 'app'>>): string {
  if (n.app === 'Missing') return 'not found'
  if (n.app === 'Stopped') return 'stopped'
  if (isUnmonitored(n)) return 'not monitored'
  if (isAbsent(n, 'instances')) return n.state === 'Stale' ? 'no data' : ''
  if (n.state === 'Stale') return 'no data'
  if (n.instancesTotal <= 0) return '' // asked for and not counted (a plan that gives no number): never "0/0 healthy", and no "unknown" either
  return `${n.instancesHealthy}/${n.instancesTotal} healthy`
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function formatRate(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v >= 10 ? v.toFixed(0) : v.toFixed(1)
}

/** A count of messages (dead letters): a whole number, or thousands as 1.2k. Not for rates, which keep their decimals (see formatRate). */
export function formatCount(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v))
}

/** Age of the oldest waiting message: seconds, minutes or hours. */
export function formatAge(seconds: number): string {
  return seconds < 90 ? `${Math.round(seconds)}s` : seconds < 5400 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(1)}h`
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`
}

/** The state of a group of buildings (a service): the worst of them. Down, then Degraded, then Stale (no data is not healthy), then Healthy. */
export function worstState(states: readonly HealthState[]): HealthState {
  for (const s of ['Down', 'Degraded', 'Stale'] as const) if (states.includes(s)) return s
  return 'Healthy'
}
