import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beaconLevel, darkFloorsFor, floorsFor, formatAge, litFraction, speedFactor, spawnRate } from '../../src/visuals'
import type { Snapshot } from '../../src/types'

describe('floors', () => {
  it('follows the doubling scale', () => {
    const expected: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 3, 5: 4, 8: 4, 9: 5, 16: 5, 17: 6, 32: 6, 33: 7, 64: 7, 65: 8, 500: 8 }
    for (const [instances, floors] of Object.entries(expected)) expect(floorsFor(Number(instances))).toBe(floors)
  })

  it('darkens the share of unhealthy instances, at least one floor', () => {
    expect(darkFloorsFor(10, 10, 5)).toBe(0)
    expect(darkFloorsFor(10, 5, 4)).toBe(2)
    expect(darkFloorsFor(10, 9, 5)).toBe(1)
    expect(darkFloorsFor(10, 0, 5)).toBe(5)
    expect(darkFloorsFor(4, 3, 3)).toBe(1)
  })
})

describe('signals', () => {
  const base = { state: 'Healthy' as const, errorAmber: 0.01, errorRed: 0.05 }
  it('uses the system thresholds for the beacon', () => {
    expect(beaconLevel({ ...base, errorRate: 0.002 })).toBe('green')
    expect(beaconLevel({ ...base, errorRate: 0.02 })).toBe('amber')
    expect(beaconLevel({ ...base, errorRate: 0.2 })).toBe('red')
    expect(beaconLevel({ ...base, errorRate: 0, state: 'Stale' })).toBe('grey')
    expect(beaconLevel({ ...base, errorRate: 0, state: 'Down' })).toBe('off')
  })

  it('slows walkers as p99 nears the SLA', () => {
    expect(speedFactor(100, 1000)).toBeGreaterThan(speedFactor(900, 1000))
    expect(speedFactor(5000, 1000)).toBe(0.25)
  })

  it('keeps lit windows between 10% and 100%', () => {
    expect(litFraction(0)).toBe(0.1)
    expect(litFraction(2)).toBe(1)
  })

  it('sends no cars to an idle building and grows slowly with traffic', () => {
    expect(spawnRate(0)).toBe(0)
    expect(spawnRate(1000)).toBeLessThan(spawnRate(100) * 4)
  })
})

describe('queue age', () => {
  it('reads as seconds, minutes or hours', () => {
    expect(formatAge(45)).toBe('45s')
    expect(formatAge(240)).toBe('4m')
    expect(formatAge(7200)).toBe('2.0h')
  })

  it('the calm fixture shows no dead letters and no late consumers', () => {
    const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/calm.json'), 'utf8')) as Snapshot
    for (const n of fx.groups.flatMap((g) => g.nodes).filter((x) => x.kind === 'Worker')) {
      expect(n.deadLetters).toBe(0)
      expect(n.oldestMessageSeconds ?? 0).toBeLessThan(n.backlogAmber)
    }
  })
})

describe('golden snapshot from the backend', () => {
  const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/calm.json'), 'utf8')) as Snapshot

  it('has the shape the renderer expects', () => {
    expect(fixture.groups[0].isHub).toBe(true)
    for (const n of fixture.groups.flatMap((g) => g.nodes)) {
      expect(floorsFor(n.instancesTotal)).toBeGreaterThanOrEqual(1)
      expect(beaconLevel(n)).toBe('green')
      expect(litFraction(n.load)).toBeGreaterThan(0)
    }
  })
})
