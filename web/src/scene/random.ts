/** Small deterministic helpers so a pillar always gets the same coastline and trees. */

export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** mulberry32: a fast seeded generator returning [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Smooth periodic 1D noise on a circle: a few seeded sine harmonics, in roughly -1..1. */
export function circleNoise(seed: number): (theta: number) => number {
  const r = rng(seed)
  const harmonics = [2, 3, 4, 6, 9].map((k) => ({ k, amp: 1 / k ** 0.8, phase: r() * Math.PI * 2 }))
  const norm = harmonics.reduce((s, h) => s + h.amp, 0)
  return (theta) => harmonics.reduce((s, h) => s + h.amp * Math.sin(h.k * theta + h.phase), 0) / norm
}
