import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import { ARCH_MAX, ARCH_MIN, archCount, archHeight, archPeak, archSlope, clearArches, deckAt, registerArch } from '../../src/scene/arches'
import { findLane, harbourCircuit, harbourLoop, LOOP_LENGTHS, LOOP_OFFSET, PIER_GAP, type SeaMap } from '../../src/scene/sea'

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

  it('sails as far out as the open water allows, so a busy loop shows several boats at once', () => {
    const open: SeaMap = { land: [box(-80, -20, -20, 20)] }
    const loop = harbourLoop(open, new THREE.Vector3(-15, 0, 0), new THREE.Vector3(-50, 0, 0))
    expect(loop![0].distanceTo(loop![1])).toBeCloseTo(LOOP_LENGTHS[0], 5)
    expect(LOOP_LENGTHS[0]).toBeGreaterThan(16) // longer than the old short hop
  })

  it('starts a loop a little along the coast from the harbour, a lane of its own beside the one to other islands', () => {
    const water = new THREE.Vector3(-15, 0, 0)
    const loop = harbourLoop(sea, water, new THREE.Vector3(-50, 0, 0))
    expect(loop![0].distanceTo(water)).toBeCloseTo(LOOP_OFFSET, 5)
    expect(Math.abs(loop![0].z)).toBeCloseTo(LOOP_OFFSET, 5) // sideways, along the coast
  })

  describe('the circuit round an island', () => {
    const island = (cx: number, r: number) => Array.from({ length: 24 }, (_, k) => new THREE.Vector2(cx + Math.cos((k / 24) * Math.PI * 2) * r, Math.sin((k / 24) * Math.PI * 2) * r))
    const open: SeaMap = { land: [island(0, 20)] }
    const centre = new THREE.Vector3(0, 0, 0)
    // a pier on the east coast: from on the island out to just past the coast
    const pier = { from: new THREE.Vector3(13, 0, 0), to: new THREE.Vector3(24, 0, 0) }
    const lineDist = (p: THREE.Vector3) => Math.abs(p.z) // the pier lies along z = 0

    it('goes once all the way round the coast, off it, from one side of the pier to the other', () => {
      const circuit = harbourCircuit(open, pier, centre)
      expect(circuit).not.toBeNull()
      const first = circuit![0], last = circuit![circuit!.length - 1]
      expect(lineDist(first)).toBeGreaterThanOrEqual(PIER_GAP - 0.01)
      expect(lineDist(last)).toBeGreaterThanOrEqual(PIER_GAP - 0.01)
      expect(Math.sign(first.z)).toBe(-Math.sign(last.z)) // the two ends are on opposite sides of the pier
      for (const p of circuit!) expect(Math.hypot(p.x, p.z)).toBeGreaterThan(20)
      let turned = 0
      for (let i = 1; i < circuit!.length; i++) {
        let d = Math.atan2(circuit![i].z, circuit![i].x) - Math.atan2(circuit![i - 1].z, circuit![i - 1].x)
        d = Math.atan2(Math.sin(d), Math.cos(d))
        turned += d
      }
      expect(Math.abs(turned)).toBeGreaterThan(Math.PI * 1.7)
    })

    it('never comes within the gap of the pier, so no boat on it clashes with the pier', () => {
      const circuit = harbourCircuit(open, pier, centre)!
      for (let i = 1; i < circuit.length; i++) {
        for (let k = 0; k <= 4; k++) {
          const q = circuit[i - 1].clone().lerp(circuit[i], k / 4)
          const crossesPier = q.x >= pier.from.x && q.x <= pier.to.x
          if (crossesPier) expect(lineDist(q)).toBeGreaterThanOrEqual(PIER_GAP - 0.01)
        }
      }
    })

    it('runs on the inside lane, closer to the coast than the water off the pier tip where the boats from other islands dock', () => {
      const circuit = harbourCircuit(open, pier, centre)!
      for (const p of circuit) expect(Math.hypot(p.x, p.z)).toBeLessThan(Math.hypot(pier.to.x + 6, 0))
    })

    it('goes the same way round for an island whatever way its outline was drawn', () => {
      const way = (poly: THREE.Vector2[]) => {
        const c = harbourCircuit({ land: [poly] }, pier, centre)!
        return Math.sign(c[2].x * c[3].z - c[2].z * c[3].x)
      }
      const outline = island(0, 20)
      expect(way(outline)).toBe(way([...outline].reverse()))
    })

    it('is not made where another island leaves no open water round it', () => {
      const crowded: SeaMap = { land: [island(0, 20), island(40, 20)] }
      expect(harbourCircuit(crowded, pier, centre)).toBeNull()
    })
  })
})
