import * as THREE from 'three'

// Every bridge is an arch, so a boat can sail under any of them and no island is ever walled off from the sea by a road. The deck rises from the
// shore at both ends to a crown over the water. The bridge builder draws it; the cars read the same curve here so they climb and descend with it.

/** Lowest crown, in world units above the shore: enough for the tallest boat to pass under with room to spare. */
export const ARCH_MIN = 2.0
/** Highest crown, so the longest causeway does not tower over the town. */
export const ARCH_MAX = 3.0
/** How much of the span's length the crown rises, between the two limits. */
export const ARCH_RATIO = 0.1

/** The crown height of an arch that spans `len`. */
export function archPeak(len: number): number {
  return Math.min(ARCH_MAX, Math.max(ARCH_MIN, len * ARCH_RATIO))
}

/** The height of the deck above the shore at `t` (0 to 1) along a span of length `len`: a parabola, zero at both ends. */
export function archHeight(t: number, len: number): number {
  const u = 2 * Math.min(1, Math.max(0, t)) - 1
  return archPeak(len) * (1 - u * u)
}

/** The slope of the deck (rise over run) at `t` along a span of length `len`. */
export function archSlope(t: number, len: number): number {
  const u = 2 * Math.min(1, Math.max(0, t)) - 1
  return (archPeak(len) * -4 * u) / len
}

interface Span {
  ax: number
  az: number
  /** Unit direction of the span along the ground, and its length. */
  ux: number
  uz: number
  len: number
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
export function registerArch(from: THREE.Vector3, to: THREE.Vector3, width: number): void {
  const dx = to.x - from.x, dz = to.z - from.z
  const len = Math.hypot(dx, dz)
  if (len < 1e-6) return
  const half = width / 2 + 0.3
  spans.push({
    ax: from.x, az: from.z, ux: dx / len, uz: dz / len, len, half,
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
    const h = archHeight(t, s.len)
    if (h >= lift) {
      lift = h
      slope = archSlope(t, s.len) * (dx * s.ux + dz * s.uz)
    }
  }
  return { lift, slope }
}
