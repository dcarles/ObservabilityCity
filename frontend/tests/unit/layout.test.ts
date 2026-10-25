import { describe, expect, it } from 'vitest'
import { hubGeometry, layoutTown, maxPillars, type IslandSize } from '../../src/scene/layout'
import { AIRPORT, layoutInvariants } from './layout.testutil'

// sizes like the sample town's islands: a few big ones, many small
const sizes = (n: number): IslandSize[] =>
  Array.from({ length: n }, (_, i) => ({ rx: 24 + ((i * 7) % 5) * 3.5, rz: 20 + ((i * 3) % 4) * 2.5 }))

describe('hub', () => {
  it('grows with the number of islands and never shrinks below the base hub', () => {
    expect(hubGeometry(1).scale).toBeGreaterThanOrEqual(1.25)
    expect(hubGeometry(15).scale).toBeGreaterThan(hubGeometry(5).scale)
    expect(hubGeometry(30).rx).toBeGreaterThan(hubGeometry(15).rx)
  })
})

for (const n of [1, 2, 5, 11, 12, 13, 15, 20, 23]) layoutInvariants(`layout of ${n} islands`, sizes(n))
// wider and narrower rings, up to the most each can hold
for (const [capacity, counts] of [[6, [5, 6, 7, 11]], [13, [24, 25]], [18, [18, 19, 27, 35]]] as const)
  for (const n of counts) layoutInvariants(`layout of ${n} islands on rings of ${capacity}`, sizes(n), capacity)

describe('ring capacity', () => {
  it('holds twice the capacity less one pillar, the airport taking the other place', () => {
    expect(maxPillars(12)).toBe(23)
    expect(maxPillars(18)).toBe(35)
    expect(() => layoutTown(sizes(23), 12, AIRPORT)).not.toThrow()
    expect(() => layoutTown(sizes(24), 12, AIRPORT)).toThrow(/at most 23/)
    expect(() => layoutTown(sizes(36), 18, AIRPORT)).toThrow(/at most 35/)
  })

  it('refuses a capacity outside 6 to 18', () => {
    expect(() => layoutTown(sizes(3), 5, AIRPORT)).toThrow()
    expect(() => layoutTown(sizes(3), 19, AIRPORT)).toThrow()
  })

  it('fills the first ring before it starts the second, whatever the capacity', () => {
    for (const capacity of [6, 12, 18]) {
      const l = layoutTown(sizes(capacity + 3), capacity, AIRPORT)
      expect(l.islands.filter((i) => i.ring === 1)).toHaveLength(capacity)
      expect(l.islands.filter((i) => i.ring === 2)).toHaveLength(3)
    }
  })

  it('needs no airport to lay a town out', () => {
    expect(layoutTown(sizes(5)).airport).toBeNull()
  })
})

describe('layout is deterministic', () => {
  it('gives the same answer twice', () => {
    expect(layoutTown(sizes(15), 12, AIRPORT)).toEqual(layoutTown(sizes(15), 12, AIRPORT))
  })
})
