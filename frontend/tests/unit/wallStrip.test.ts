import { describe, expect, it } from 'vitest'
import { stripModel } from '../../src/wall/stripModel'
import { healthyTown, withIncident, withState } from './wall.testutil'

describe('the status strip', () => {
  it('says ALL SYSTEMS HEALTHY in green for a healthy town, with how long since the last incident', () => {
    const s = healthyTown()
    s.generatedAt = '2026-10-26T12:00:00+00:00'
    s.incidentFreeSince = '2026-10-26T09:00:00+00:00'
    s.incidentsSeen = true

    const m = stripModel(s)

    expect(m.headline).toBe('ALL SYSTEMS HEALTHY')
    expect(m.tone).toBe('ok')
    expect(m.subline).toBe('3 h since last incident')
    expect(m.counts).toEqual({ incidents: 0, down: 0, degraded: 0, stale: 0 })
  })

  it('does not count a system with only dead letters as degraded: the DLQ number says it', () => {
    const s = withState(healthyTown(), 'cl.ledger-api', 'Healthy', { deadLetters: 130 })
    const m = stripModel(s)
    expect(m.counts.degraded).toBe(0)
  })

  it('counts what is wrong, and turns amber for degraded', () => {
    const m = stripModel(withState(withState(healthyTown(), 'cl.ledger-api', 'Degraded'), 'pay.payments-api', 'Degraded'))

    expect(m.headline).toBe('2 DEGRADED')
    expect(m.tone).toBe('warn')
    expect(m.subline).toBe('')
  })

  it('turns red for a system that is down', () => {
    const m = stripModel(withState(withState(healthyTown(), 'cl.ledger-api', 'Down'), 'pay.payments-api', 'Degraded'))

    expect(m.headline).toBe('1 DOWN · 1 DEGRADED')
    expect(m.tone).toBe('bad')
  })

  it('turns red for an incident, and puts it first', () => {
    const m = stripModel(withState(withIncident(healthyTown(), 'pay', { id: 'i', severity: 2, title: 'x' }), 'cl.ledger-api', 'Down'))

    expect(m.headline).toBe('1 INCIDENT · 1 DOWN')
    expect(m.tone).toBe('bad')
  })

  it('never calls a town with a system that has no data healthy', () => {
    const m = stripModel(withState(healthyTown(), 'dat.ingest-db', 'Stale'))

    expect(m.headline).toBe('1 WITH NO DATA')
    expect(m.tone).toBe('warn')
  })

  it('shows the headline numbers, and colours errors and dead letters', () => {
    const s = healthyTown()
    s.totals.errorRate = 0.06
    s.totals.deadLetters = 12

    const m = stripModel(s)

    expect(m.numbers.map((n) => n.label)).toEqual(['req/s', 'errors', 'p99', 'DLQ'])
    expect(m.numbers.find((n) => n.label === 'errors')).toMatchObject({ value: '6.0%', tone: 'bad' })
    expect(m.numbers.find((n) => n.label === 'DLQ')).toMatchObject({ value: '12', tone: 'bad' })
  })

  it('puts the systems with dead letters in red next to the headline', () => {
    let s = withState(withState(healthyTown(), 'cl.ledger-api', 'Degraded'), 'pay.payments-api', 'Healthy', { deadLetters: 5 })
    s = withState(s, 'cl.ledger-db', 'Healthy', { deadLetters: 130 })

    const m = stripModel(s)

    expect(m.headline).toBe('1 DEGRADED')
    expect(m.dlqSystems).toBe(2)
    expect(m.dlqLabel).toBe('/ 2 with DLQ')
  })

  it('counts a degraded system with dead letters too, once', () => {
    const m = stripModel(withState(healthyTown(), 'cl.ledger-api', 'Degraded', { deadLetters: 9 }))

    expect(m.headline).toBe('1 DEGRADED')
    expect(m.dlqLabel).toBe('/ 1 with DLQ')
  })

  it('makes dead letters the headline when nothing else is wrong, never "healthy"', () => {
    const m = stripModel(withState(healthyTown(), 'cl.ledger-api', 'Healthy', { deadLetters: 130 }))

    expect(m.headline).toBe('1 WITH DLQ')
    expect(m.tone).toBe('warn')
    expect(m.dlqLabel).toBe('')
    expect(m.subline).toBe('')
  })

  it('says nothing about dead letters when there are none, or the system has no data', () => {
    expect(stripModel(withState(healthyTown(), 'cl.ledger-api', 'Degraded')).dlqLabel).toBe('')
    expect(stripModel(withState(healthyTown(), 'cl.ledger-api', 'Stale', { deadLetters: 40 })).dlqSystems).toBe(0)
  })
})
