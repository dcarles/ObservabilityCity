// The visual language as pure functions: numbers from a snapshot in, visual parameters out.
// Nothing here touches three.js, so it is unit tested against the same golden fixtures as the backend.

import type { NodeSnapshot } from './types'

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

export type BeaconLevel = 'green' | 'amber' | 'red' | 'grey' | 'off'

/** Share of capacity in use across CPU, memory and a data store's utilisation: the busiest one counts. */
export function resourceUse(n: Pick<NodeSnapshot, 'cpu' | 'memory' | 'utilisation'>): number {
  return Math.max(n.cpu ?? 0, n.memory ?? 0, n.utilisation ?? 0)
}

type BeaconInput = Pick<NodeSnapshot, 'state' | 'errorRate' | 'errorAmber' | 'errorRed'> &
  Partial<Pick<NodeSnapshot, 'cpu' | 'memory' | 'utilisation' | 'throttled' | 'resourceAmber' | 'throttleAmber' | 'throttleRed'>>

/**
 * Rooftop beacon colour. Red means requests are failing: errors past the red threshold, or a data store
 * turning requests away past its throttle threshold. Amber is the warning: errors, throttling or CPU,
 * memory or utilisation past their amber thresholds.
 */
export function beaconLevel(n: BeaconInput): BeaconLevel {
  if (n.state === 'Stale') return 'grey'
  if (n.state === 'Down') return 'off'
  const throttled = n.throttled ?? 0
  if (n.errorRate >= n.errorRed || (n.throttleRed !== undefined && throttled >= n.throttleRed)) return 'red'
  if (n.errorRate >= n.errorAmber) return 'amber'
  if (n.throttleAmber !== undefined && throttled >= n.throttleAmber) return 'amber'
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

export function plaqueText(n: Pick<NodeSnapshot, 'state' | 'instancesTotal' | 'instancesHealthy'>): string {
  if (n.state === 'Stale') return 'no data'
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

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`
}
