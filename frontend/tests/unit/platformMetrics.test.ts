import { describe, expect, it } from 'vitest'
import { overviewRows } from '../../src/inspectorModel'
import { beaconLevel, resourceUse } from '../../src/visuals'
import type { NodeSnapshot, Snapshot } from '../../src/types'
import { healthyTown, withState } from './wall.testutil'

// Phase 2, slice 5: CPU, memory, request-unit use and throttling come from the platform metrics. The browser draws them as it always has; what is new is
// that they are real, so they can be missing, hot while the system is quiet, or past a line on one resource only. None of that may turn into a number
// the metrics did not give.

const nodeOf = (s: Snapshot, id: string): NodeSnapshot => s.groups.flatMap((g) => g.nodes).find((n) => n.id === id)!
const town = (patch: Partial<NodeSnapshot>, id = 'cl.ledger-api'): NodeSnapshot => nodeOf(withState(healthyTown(), id, 'Healthy', patch), id)
const row = (n: NodeSnapshot, label: string) => overviewRows(n).find((r) => r.label === label)

describe('lights from platform metrics', () => {
  it('lists CPU and memory with a tone from the system thresholds', () => {
    const n = town({ cpu: 0.64, memory: 0.71, resourceAmber: 0.8, resourceRed: 0.95 })

    expect(row(n, 'CPU')).toMatchObject({ value: '64%', tone: '' })
    expect(row(n, 'Memory')).toMatchObject({ value: '71%', tone: '' })
    expect(row(town({ cpu: 0.88, resourceAmber: 0.8, resourceRed: 0.95 }), 'CPU')?.tone).toBe('warn')
    expect(row(town({ cpu: 0.97, resourceAmber: 0.8, resourceRed: 0.95 }), 'CPU')?.tone).toBe('bad')
  })

  it('shows a hot plan as an amber beacon even when the system is quiet and healthy', () => {
    const hot = town({ cpu: 0.88, memory: 0.52, quiet: true, errorRate: 0, resourceAmber: 0.8 })
    const calm = town({ cpu: 0.4, memory: 0.52, quiet: true, errorRate: 0, resourceAmber: 0.8 })

    expect(beaconLevel(hot)).toBe('amber')
    expect(beaconLevel(calm)).toBe('green')
  })

  it('takes the busiest of CPU, memory and capacity used for how lit the resources are', () => {
    expect(resourceUse({ cpu: 0.64, memory: 0.71, utilisation: 0.95 })).toBe(0.95)
    expect(resourceUse({ cpu: 0.64, memory: 0.71 })).toBe(0.71)
  })

  it('shows a data store at 95% and throttling 10% of its requests as red, with both rows', () => {
    const db = town({ utilisation: 0.95, throttled: 0.1, resourceAmber: 0.8, resourceRed: 0.95, throttleAmber: 0.001, throttleRed: 0.02 }, 'cl.ledger-db')

    expect(row(db, 'Capacity used')).toMatchObject({ value: '95%', tone: 'bad' })
    expect(row(db, 'Throttled')).toMatchObject({ value: '10.0%', tone: 'bad' })
    expect(beaconLevel(db)).toBe('red')
  })

  it('shows no throttling as a plain 0%, not a missing row: a filter that matches nothing is zero', () => {
    const db = town({ utilisation: 0.5, throttled: 0, throttleAmber: 0.001, throttleRed: 0.02 }, 'cl.ledger-db')

    expect(row(db, 'Throttled')).toMatchObject({ value: '0.0%', tone: '' })
  })

  it('leaves out a signal the metrics did not give instead of drawing zero', () => {
    const n = town({ cpu: null, memory: 0.71 })

    expect(row(n, 'CPU')).toBeUndefined()
    expect(row(n, 'Memory')?.value).toBe('71%')
    expect(resourceUse(n)).toBe(0.71)
  })

  it('shows nothing for a signal no source supplies, whatever number came along', () => {
    const n = town({ cpu: 0.9, memory: null, utilisation: null, absent: ['cpu'] })

    expect(row(n, 'CPU')).toBeUndefined()
    expect(resourceUse(n)).toBe(0)
  })
})
