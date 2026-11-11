import { describe, expect, it } from 'vitest'
import { attentionOf } from '../../src/wall/attention'
import type { NodeSnapshot } from '../../src/types'
import { healthyTown, withIncident, withState } from './wall.testutil'

describe('what needs looking at', () => {
  it('is nothing in a healthy town', () => {
    expect(attentionOf(healthyTown())).toEqual([])
  })

  it('puts incidents first, then systems that are down, then degraded, then no data', () => {
    let s = healthyTown()
    s = withState(s, 'ldg.ledger-db', 'Degraded', { errorRate: 0.03 })
    s = withState(s, 'ext.card-network', 'Stale')
    s = withState(s, 'pay.payments-api', 'Down')
    s = withIncident(s, 'fra', { id: 'inc-1', severity: 2, title: 'Screening is slow' })

    expect(attentionOf(s).map((a) => a.kind)).toEqual(['incident', 'down', 'degraded', 'stale'])
  })

  it('puts the worse incident first, then the older, and the busier system first among those down', () => {
    let s = healthyTown()
    s = withIncident(s, 'ldg', { id: 'minor', severity: 4, title: 'Cloudy' })
    s = withIncident(s, 'pay', { id: 'major', severity: 1, title: 'Storm' })
    s = withState(s, 'ldg.statements-api', 'Down')
    s = withState(s, 'ldg.ledger-api', 'Down')

    expect(attentionOf(s).map((a) => a.subject)).toEqual(['major', 'minor', 'ldg.ledger-api', 'ldg.statements-api'])
  })

  it('sends the camera to the island for an incident and to the building for a system', () => {
    let s = withIncident(healthyTown(), 'pay', { id: 'i', severity: 2, title: 'Card network slow' })
    s = withState(s, 'ldg.ledger-api', 'Down')

    const [incident, down] = attentionOf(s)
    expect(incident.focus).toEqual({ kind: 'island', id: 'pay' })
    expect(down.focus).toEqual({ kind: 'building', id: 'ldg.ledger-api' })
  })

  it('says it in words: the severity, the island and the title; the system and why', () => {
    let s = withIncident(healthyTown(), 'pay', { id: 'i', severity: 2, title: 'Card network slow' })
    s = withState(s, 'ldg.ledger-api', 'Down')
    s = withState(s, 'ldg.ledger-db', 'Degraded', { errorRate: 0.03, errorAmber: 0.01, errorRed: 0.05 })

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
    const degraded = attentionOf(withState(healthyTown(), 'ldg.ledger-api', 'Degraded'))[0]
    const down = attentionOf(withState(healthyTown(), 'ldg.ledger-api', 'Down'))[0]

    expect(degraded.subject).toBe(down.subject)
    expect(degraded.key).not.toBe(down.key)
    expect(attentionOf(withState(healthyTown(), 'ldg.ledger-api', 'Degraded'))[0].key).toBe(degraded.key)
  })

  describe('dead letters', () => {
    const dead = (count: number, queues: { name: string; deadLetters: number }[] = [{ name: 'q-orders', deadLetters: count }]) =>
      ({ deadLetters: count, queues: queues.map((q) => ({ name: q.name, backlog: 0, deadLetters: q.deadLetters })) }) as Partial<NodeSnapshot>

    it('is a stop for a healthy system with dead letters, after what is down and before what is degraded', () => {
      let s = healthyTown()
      s = withState(s, 'ldg.ledger-db', 'Degraded', { errorRate: 0.03 })
      s = withState(s, 'ldg.ledger-api', 'Healthy', dead(130))
      s = withState(s, 'pay.payments-api', 'Down')

      expect(attentionOf(s).map((a) => [a.kind, a.subject])).toEqual([['down', 'pay.payments-api'], ['deadLetters', 'ldg.ledger-api'], ['degraded', 'ldg.ledger-db']])
    })

    it('names the count and the queue with the most, and how many more queues have some', () => {
      let s = withState(healthyTown(), 'ldg.ledger-api', 'Healthy', dead(130, [{ name: 'q-small', deadLetters: 30 }, { name: 'q-orders', deadLetters: 100 }]))
      expect(attentionOf(s)[0].caption).toMatch(/has 130 dead letters in q-orders and 1 more queue$/)

      s = withState(healthyTown(), 'ldg.ledger-api', 'Healthy', dead(1))
      expect(attentionOf(s)[0].caption).toMatch(/has 1 dead letter in q-orders$/)
    })

    it('says the count even when the queues are not known', () => {
      const s = withState(healthyTown(), 'ldg.ledger-api', 'Healthy', { deadLetters: 7 })
      expect(attentionOf(s)[0].caption).toMatch(/has 7 dead letters$/)
    })

    it('goes worst first, and sends the camera to the building', () => {
      let s = withState(healthyTown(), 'ldg.ledger-api', 'Healthy', dead(5))
      s = withState(s, 'ldg.statements-api', 'Healthy', dead(50))
      const list = attentionOf(s)
      expect(list.map((a) => a.subject)).toEqual(['ldg.statements-api', 'ldg.ledger-api'])
      expect(list[0].focus).toEqual({ kind: 'building', id: 'ldg.statements-api' })
    })

    it('is also said on a degraded system, so the queues are not lost behind another reason', () => {
      const s = withState(healthyTown(), 'ldg.ledger-api', 'Degraded', { errorRate: 0.03, ...dead(130) })
      const [a] = attentionOf(s)
      expect(a.kind).toBe('degraded')
      expect(a.caption).toMatch(/130 dead letters in q-orders/)
    })

    it('leaves out a system whose dead letters nothing measures, and one with no fresh data', () => {
      let s = withState(healthyTown(), 'ldg.ledger-api', 'Healthy', { ...dead(9), absent: ['deadLetters'] } as never)
      expect(attentionOf(s)).toEqual([])
      s = withState(healthyTown(), 'ldg.ledger-api', 'Stale', dead(9))
      expect(attentionOf(s).map((a) => a.kind)).toEqual(['stale'])
    })
  })
})
