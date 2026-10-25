import { describe, expect, it } from 'vitest'
import { hubGeometry, layoutTown, type IslandSize } from './layout'
import { layoutInvariants } from './layout.testutil'

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

for (const n of [1, 2, 5, 11, 12, 13, 15, 20, 24]) layoutInvariants(`layout of ${n} islands`, sizes(n))

describe('layout is deterministic', () => {
  it('gives the same answer twice', () => {
    expect(layoutTown(sizes(15))).toEqual(layoutTown(sizes(15)))
  })
})
