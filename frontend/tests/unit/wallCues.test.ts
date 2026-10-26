import { describe, expect, it } from 'vitest'
import { diffCues } from '../../src/wall/cues'
import { healthyTown, withIncident, withState } from './wall.testutil'

describe('what changed between two snapshots', () => {
  it('is nothing for the first snapshot, which has nothing to compare to', () => {
    expect(diffCues(null, withState(healthyTown(), 'cl.ledger-api', 'Down'))).toEqual([])
  })

  it('is nothing when nothing changed', () => {
    const s = withState(healthyTown(), 'cl.ledger-api', 'Down')
    expect(diffCues(s, structuredClone(s))).toEqual([])
  })

  it('is new trouble when a system goes down, with the stop to cut to', () => {
    const cues = diffCues(healthyTown(), withState(healthyTown(), 'cl.ledger-api', 'Down'))

    expect(cues).toHaveLength(1)
    expect(cues[0]).toMatchObject({ kind: 'trouble', subject: 'cl.ledger-api', text: 'Ledger API (Core Ledger) is down' })
    expect(cues[0].attention?.focus).toEqual({ kind: 'building', id: 'cl.ledger-api' })
  })

  it('is new trouble for a new incident, aimed at its island', () => {
    const cues = diffCues(healthyTown(), withIncident(healthyTown(), 'pay', { id: 'i', severity: 1, title: 'Storm' }))

    expect(cues[0]).toMatchObject({ kind: 'trouble', subject: 'i' })
    expect(cues[0].attention?.focus).toEqual({ kind: 'island', id: 'pay' })
  })

  it('is new trouble when a degraded system goes down, because it got worse', () => {
    const before = withState(healthyTown(), 'cl.ledger-api', 'Degraded')
    const cues = diffCues(before, withState(healthyTown(), 'cl.ledger-api', 'Down'))

    expect(cues.map((c) => c.kind)).toEqual(['trouble'])
  })

  it('is neither trouble nor resolved when a system that was down is only degraded now', () => {
    const before = withState(healthyTown(), 'cl.ledger-api', 'Down')
    expect(diffCues(before, withState(healthyTown(), 'cl.ledger-api', 'Degraded'))).toEqual([])
  })

  it('is resolved when trouble ends, in words', () => {
    const down = withState(healthyTown(), 'cl.ledger-api', 'Down')
    const incident = withIncident(healthyTown(), 'pay', { id: 'i', severity: 2, title: 'Card network slow' })

    expect(diffCues(down, healthyTown())).toEqual([{ kind: 'resolved', subject: 'cl.ledger-api', text: 'Resolved: Ledger API is healthy again' }])
    expect(diffCues(incident, healthyTown())).toEqual([{ kind: 'resolved', subject: 'i', text: 'Resolved: incident on Payments: Card network slow' }])
  })

  it('puts the worst new trouble first, and the resolved last', () => {
    const before = withState(healthyTown(), 'cl.statements-api', 'Down')
    let after = withState(healthyTown(), 'cl.ledger-api', 'Degraded')
    after = withState(after, 'cl.posting-api', 'Down')
    after = withIncident(after, 'frd', { id: 'i', severity: 3, title: 'Slow' })

    expect(diffCues(before, after).map((c) => `${c.kind}:${c.subject}`)).toEqual(['trouble:i', 'trouble:cl.posting-api', 'trouble:cl.ledger-api', 'resolved:cl.statements-api'])
  })

  it('does not call a system new trouble again while it stays in trouble', () => {
    const a = withState(healthyTown(), 'cl.ledger-api', 'Down')
    const b = withState(a, 'cl.ledger-api', 'Down', { errorRate: 0.5 })

    expect(diffCues(a, b)).toEqual([])
  })
})
