import * as THREE from 'three'

// Every bridge is an arch, so a boat can sail under any of them and no island is ever walled off from the sea by a road. The deck climbs from the
// shore over a short ramp, then runs level at the crown over the water, and comes down the same way at the far end. The bridge builder draws it; the
// cars read the same curve here so they climb and descend with it.
//
// The boats that sail the circuit round an island pass under the bridge a few units off the coast, where a plain parabola is still low: a boat's
// crates would poke through the road. The ramp is short so the deck is already above the boats by the time it reaches that lane.

/** Lowest crown, in world units above the shore: only for a span too short to climb any higher. */
export const ARCH_MIN = 2.0
/** The crown of every span long enough to reach it: every boat's crates, and the cabin of a normal-size boat, pass under it on the circuit lane. Only the cabin of the very biggest boat can still touch the girder. */
export const ARCH_MAX = 3.2
/** How much of the span's length the crown rises, between the two limits (so a short span gets a lower crown). */
export const ARCH_RATIO = 0.2
/** How far from the shore the deck climbs before it levels off at the crown, in world units (less on a span too short for two ramps). */
export const ARCH_RAMP = 7

/** The crown height of an arch that spans `len`. */
export function archPeak(len: number): number {
  return Math.min(ARCH_MAX, Math.max(ARCH_MIN, len * ARCH_RATIO))
}

const smooth = (x: number): number => {
  const c = Math.min(1, Math.max(0, x))
  return c * c * (3 - 2 * c)
}

/** How far the deck climbs at each end of a span, in world units: at the `from` end and at the `to` end. */
export interface Ramps {
  from: number
  to: number
}

/** The climb at both ends of an island-to-island bridge: steep, so a boat that passes under it a few units off the coast clears the deck. */
export const STEEP_RAMPS: Ramps = { from: ARCH_RAMP, to: ARCH_RAMP }

/** The climb of the end of a bridge that lands on the ring road: long and gentle, so the deck meets the road at road level instead of rising over it. */
export const ARCH_RING_RAMP = 16

/** The ramps of a bridge with the ring road at one end: the steep climb at the island end, the gentle one at the road. */
export function ringRamps(ringEnd: 'from' | 'to'): Ramps {
  return ringEnd === 'from' ? { from: ARCH_RING_RAMP, to: ARCH_RAMP } : { from: ARCH_RAMP, to: ARCH_RING_RAMP }
}

/** The two ramps scaled down together when a short span has no room for both, so the crown is still reached where they meet. */
function fitRamps(len: number, ramps: Ramps): Ramps {
  const sum = ramps.from + ramps.to
  return sum > len ? { from: (ramps.from * len) / sum, to: (ramps.to * len) / sum } : ramps
}

/** The height of the deck above the shore at `t` (0 to 1) along a span of length `len`: a smooth climb over each end's ramp, level at the crown between. */
export function archHeight(t: number, len: number, ramps: Ramps = STEEP_RAMPS): number {
  const d = Math.min(1, Math.max(0, t)) * len
  const r = fitRamps(len, ramps)
  return archPeak(len) * Math.min(smooth(d / r.from), smooth((len - d) / r.to))
}

/** The slope of the deck (rise over run) at `t` along a span of length `len`. */
export function archSlope(t: number, len: number, ramps: Ramps = STEEP_RAMPS): number {
  const d = Math.min(1, Math.max(0, t)) * len
  const r = fitRamps(len, ramps)
  const x0 = d / r.from, x1 = (len - d) / r.to
  const peak = archPeak(len)
  if (x0 <= x1) return x0 >= 1 ? 0 : (peak * 6 * x0 * (1 - x0)) / r.from
  return x1 >= 1 ? 0 : -(peak * 6 * x1 * (1 - x1)) / r.to
}

interface Span {
  ax: number
  az: number
  /** Unit direction of the span along the ground, and its length. */
  ux: number
  uz: number
  len: number
  ramps: Ramps
  /** Half the deck width, plus a margin, for the sideways test. */
  half: number
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

const spans: Span[] = []

/** Forgets every span. The town calls this before it builds its bridges again. */
export function clearArches(): void {
  spans.length = 0
}

/** Records a bridge's deck (the ground line it spans, ends included) so cars can ride its arch. */
export function registerArch(from: THREE.Vector3, to: THREE.Vector3, width: number, ramps: Ramps = STEEP_RAMPS): void {
  const dx = to.x - from.x, dz = to.z - from.z
  const len = Math.hypot(dx, dz)
  if (len < 1e-6) return
  const half = width / 2 + 0.3
  spans.push({
    ax: from.x, az: from.z, ux: dx / len, uz: dz / len, len, ramps, half,
    minX: Math.min(from.x, to.x) - half, maxX: Math.max(from.x, to.x) + half,
    minZ: Math.min(from.z, to.z) - half, maxZ: Math.max(from.z, to.z) + half,
  })
}

/** How many bridges have an arch. For tests. */
export const archCount = (): number => spans.length

/**
 * How far above the shore the deck is at a ground point, and the slope of the road for a car heading (dx, dz). Zero lift and a flat road
 * where no bridge stands. Where two decks overlap at a joint, the higher one counts.
 */
export function deckAt(x: number, z: number, dx = 0, dz = 0): { lift: number; slope: number } {
  let lift = 0, slope = 0
  for (const s of spans) {
    if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue
    const along = (x - s.ax) * s.ux + (z - s.az) * s.uz
    const side = Math.abs(-(x - s.ax) * s.uz + (z - s.az) * s.ux)
    if (along < 0 || along > s.len || side > s.half) continue
    const t = along / s.len
    const h = archHeight(t, s.len, s.ramps)
    if (h >= lift) {
      lift = h
      slope = archSlope(t, s.len, s.ramps) * (dx * s.ux + dz * s.uz)
    }
  }
  return { lift, slope }
}
