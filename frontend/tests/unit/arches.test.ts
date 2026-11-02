import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import { ARCH_MAX, ARCH_MIN, archCount, archHeight, archPeak, archSlope, clearArches, deckAt, registerArch } from '../../src/scene/arches'
import { findLane, harbourLoop, type SeaMap } from '../../src/scene/sea'

afterEach(() => clearArches())

describe('the arch of a bridge', () => {
  it('rises from the shore at both ends to a crown in the middle', () => {
    expect(archHeight(0, 24)).toBe(0)
    expect(archHeight(1, 24)).toBe(0)
    expect(archHeight(0.5, 24)).toBeCloseTo(archPeak(24), 6)
    expect(archHeight(0.25, 24)).toBeGreaterThan(0)
    expect(archHeight(0.25, 24)).toBeLessThan(archPeak(24))
  })

  it('is always high enough for a boat to pass and never towers over the town', () => {
    for (const len of [4, 10, 20, 36, 120]) {
      expect(archPeak(len)).toBeGreaterThanOrEqual(ARCH_MIN)
      expect(archPeak(len)).toBeLessThanOrEqual(ARCH_MAX)
    }
  })

  it('climbs on the way up, is level at the crown and falls on the way down', () => {
    expect(archSlope(0.1, 24)).toBeGreaterThan(0)
    expect(archSlope(0.5, 24)).toBeCloseTo(0, 6)
    expect(archSlope(0.9, 24)).toBeLessThan(0)
  })
})

describe('what a car feels on a bridge', () => {
  it('has no lift and no slope where no bridge stands', () => {
    expect(deckAt(0, 0, 1, 0)).toEqual({ lift: 0, slope: 0 })
  })

  it('lifts a car along the deck and tilts it by the direction it drives', () => {
    registerArch(new THREE.Vector3(0, 0, 0), new THREE.Vector3(24, 0, 0), 6.2)
    expect(archCount()).toBe(1)
    const mid = deckAt(12, 0, 1, 0)
    expect(mid.lift).toBeCloseTo(archPeak(24), 6)
    expect(mid.slope).toBeCloseTo(0, 6)
    const up = deckAt(6, 0, 1, 0), down = deckAt(6, 0, -1, 0)
    expect(up.slope).toBeGreaterThan(0)
    expect(down.slope).toBeCloseTo(-up.slope, 9) // the same road, driven the other way, is the opposite slope
    expect(deckAt(12, 9, 1, 0).lift).toBe(0) // beside the deck is sea
    expect(deckAt(30, 0, 1, 0).lift).toBe(0) // beyond the far end is the next island
  })

  it('forgets every bridge when the town is built again', () => {
    registerArch(new THREE.Vector3(0, 0, 0), new THREE.Vector3(24, 0, 0), 6.2)
    clearArches()
    expect(archCount()).toBe(0)
    expect(deckAt(12, 0, 1, 0).lift).toBe(0)
  })
})

describe('boats under bridges', () => {
  const box = (x0: number, z0: number, x1: number, z1: number) => [new THREE.Vector2(x0, z0), new THREE.Vector2(x1, z0), new THREE.Vector2(x1, z1), new THREE.Vector2(x0, z1)]
  // two islands with open water between them, as a bridge would span
  const sea: SeaMap = { land: [box(-80, -20, -20, 20), box(20, -20, 80, 20)] }

  it('finds a lane from one island to the other straight across where a bridge stands', () => {
    registerArch(new THREE.Vector3(-20, 0, 0), new THREE.Vector3(20, 0, 0), 6.2)
    const lane = findLane(sea, new THREE.Vector3(-15, 0, 0), new THREE.Vector3(15, 0, 0))
    expect(lane).not.toBeNull()
    const crossing = lane!.some((p, i) => {
      const q = lane![i + 1]
      if (!q || p.x * q.x > 0) return false
      const z = p.z + ((q.z - p.z) * (0 - p.x)) / (q.x - p.x)
      return Math.abs(z) < 4 // it meets the line of the bridge within its width
    })
    expect(crossing).toBe(true) // it sails under the bridge instead of round it
  })

  it('gives messages that stay on one island a short out-and-back lane in open water', () => {
    const loop = harbourLoop(sea, new THREE.Vector3(-15, 0, 0), new THREE.Vector3(-50, 0, 0))
    expect(loop).not.toBeNull()
    expect(loop).toHaveLength(2)
    expect(loop![0].distanceTo(loop![1])).toBeGreaterThan(5)
  })
})
