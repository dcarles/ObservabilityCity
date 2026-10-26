import { describe, expect, it } from 'vitest'
import { attentionOf } from '../../src/wall/attention'
import { healthyTown, withIncident, withState } from './wall.testutil'

describe('what needs looking at', () => {
  it('is nothing in a healthy town', () => {
    expect(attentionOf(healthyTown())).toEqual([])
  })

  it('puts incidents first, then systems that are down, then degraded, then no data', () => {
    let s = healthyTown()
    s = withState(s, 'cl.ledger-db', 'Degraded', { errorRate: 0.03 })
    s = withState(s, 'ext.card-network', 'Stale')
    s = withState(s, 'pay.payments-api', 'Down')
    s = withIncident(s, 'frd', { id: 'inc-1', severity: 2, title: 'Screening is slow' })

    expect(attentionOf(s).map((a) => a.kind)).toEqual(['incident', 'down', 'degraded', 'stale'])
  })

  it('puts the worse incident first, then the older, and the busier system first among those down', () => {
    let s = healthyTown()
    s = withIncident(s, 'cl', { id: 'minor', severity: 4, title: 'Cloudy' })
    s = withIncident(s, 'pay', { id: 'major', severity: 1, title: 'Storm' })
    s = withState(s, 'cl.statements-api', 'Down')
    s = withState(s, 'cl.ledger-api', 'Down')

    expect(attentionOf(s).map((a) => a.subject)).toEqual(['major', 'minor', 'cl.ledger-api', 'cl.statements-api'])
  })

  it('sends the camera to the island for an incident and to the building for a system', () => {
    let s = withIncident(healthyTown(), 'pay', { id: 'i', severity: 2, title: 'Card network slow' })
    s = withState(s, 'cl.ledger-api', 'Down')

    const [incident, down] = attentionOf(s)
    expect(incident.focus).toEqual({ kind: 'island', id: 'pay' })
    expect(down.focus).toEqual({ kind: 'building', id: 'cl.ledger-api' })
  })

  it('says it in words: the severity, the island and the title; the system and why', () => {
    let s = withIncident(healthyTown(), 'pay', { id: 'i', severity: 2, title: 'Card network slow' })
    s = withState(s, 'cl.ledger-api', 'Down')
    s = withState(s, 'cl.ledger-db', 'Degraded', { errorRate: 0.03, errorAmber: 0.01, errorRed: 0.05 })

    const captions = attentionOf(s).map((a) => a.caption)
    expect(captions[0]).toBe('Sev 2 incident on Payments: Card network slow')
    expect(captions[1]).toBe('Ledger API (Core Ledger) is down')
    expect(captions[2]).toContain('Ledger DB (Core Ledger) is degraded: Errors are at 3.0%')
  })

  it('counts a third party that is down, and says where it stands', () => {
    const s = withState(healthyTown(), 'ext.card-network', 'Down')

    const [a] = attentionOf(s)
    expect(a.focus).toEqual({ kind: 'building', id: 'ext.card-network' })
    expect(a.caption).toBe('Card network (third party) is down')
  })

  it('never calls a system with no data healthy', () => {
    const [a] = attentionOf(withState(healthyTown(), 'dat.ingest-db', 'Stale'))

    expect(a.kind).toBe('stale')
    expect(a.caption).toContain('has no fresh data')
  })

  it('keeps one key for one piece of trouble, and gives a system that gets worse a new one', () => {
    const degraded = attentionOf(withState(healthyTown(), 'cl.ledger-api', 'Degraded'))[0]
    const down = attentionOf(withState(healthyTown(), 'cl.ledger-api', 'Down'))[0]

    expect(degraded.subject).toBe(down.subject)
    expect(degraded.key).not.toBe(down.key)
    expect(attentionOf(withState(healthyTown(), 'cl.ledger-api', 'Degraded'))[0].key).toBe(degraded.key)
  })
})
