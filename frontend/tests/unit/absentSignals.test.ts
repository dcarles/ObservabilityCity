import { describe, expect, it } from 'vitest'
import { absentEverywhere, isAbsent, isUnmonitored, SIGNALS } from '../../src/signals'
import { checkSnapshot } from '../../src/snapshotGuard'
import { overviewRows, reasons } from '../../src/inspectorModel'
import { beaconLevel, plaqueText } from '../../src/visuals'
import { staleCount } from '../../src/viewTotals'
import { summariseService, systemNumbers } from '../../src/scene/service'
import { attentionOf } from '../../src/wall/attention'
import type { NodeSnapshot, Snapshot } from '../../src/types'
import { healthyTown, withState } from './wall.testutil'

// A signal with no source is absent: not zero and not grey. Grey is a source that is configured and has nothing fresh to say.

const ALL = [...SIGNALS]
const town = (): Snapshot => healthyTown()
const nodeOf = (s: Snapshot, id: string): NodeSnapshot => s.groups.flatMap((g) => g.nodes).find((n) => n.id === id)!
/** The system with nothing configured: Stale in the contract, every signal absent. */
const unmonitored = (s: Snapshot, id: string): Snapshot => withState(s, id, 'Stale', { absent: ALL, requestsPerSecond: 0, errorRate: 0, p99Ms: 0, instancesTotal: 0, instancesHealthy: 0 })
/** A system whose source supplies requests, errors and latency only. */
const partly = (s: Snapshot, id: string, patch: Partial<NodeSnapshot> = {}): Snapshot =>
  withState(s, id, 'Healthy', { absent: ['instances', 'cpu', 'memory', 'utilisation', 'throttled', 'backlog', 'deadLetters'], instancesTotal: 0, instancesHealthy: 0, cpu: null, memory: null, ...patch })

describe('which signals a system has', () => {
  it('knows a signal is absent from the list the server sends', () => {
    expect(isAbsent({ absent: ['cpu'] }, 'cpu')).toBe(true)
    expect(isAbsent({ absent: ['cpu'] }, 'memory')).toBe(false)
  })

  it('treats a system as unmonitored only when every signal is absent', () => {
    expect(isUnmonitored({ absent: ALL })).toBe(true)
    expect(isUnmonitored({ absent: ALL.slice(1) })).toBe(false)
    expect(isUnmonitored({ absent: [] })).toBe(false)
  })

  it('tolerates a server that does not say (everything is present)', () => {
    expect(isAbsent({}, 'errors')).toBe(false)
    expect(isUnmonitored({})).toBe(false)
  })

  it('says a signal is absent everywhere only when no system has it', () => {
    let s = town()
    expect(absentEverywhere(s, 'errors')).toBe(false)
    for (const g of s.groups) for (const n of g.nodes) n.absent = ['errors']
    expect(absentEverywhere(s, 'errors')).toBe(true)
    expect(absentEverywhere(s, 'requests')).toBe(false)
    s = town()
    s.groups[1].nodes[0].absent = ['errors']
    expect(absentEverywhere(s, 'errors')).toBe(false)
  })
})

describe('reading the list from the server', () => {
  it('keeps the signals it knows and drops the ones it does not', () => {
    const raw = town()
    ;(nodeOf(raw, 'cl.ledger-api') as unknown as Record<string, unknown>).absent = ['cpu', 'telepathy', 7]

    const { snapshot } = checkSnapshot(raw)

    expect(nodeOf(snapshot!, 'cl.ledger-api').absent).toEqual(['cpu'])
  })

  it('gives a server that sends none an empty list, so everything shows', () => {
    const raw = town()
    delete (nodeOf(raw, 'cl.ledger-api') as unknown as Record<string, unknown>).absent

    expect(nodeOf(checkSnapshot(raw).snapshot!, 'cl.ledger-api').absent).toEqual([])
  })
})

describe('the beacon', () => {
  const n = nodeOf(town(), 'cl.ledger-api')

  it('is dark when nothing that would colour it is measured: not grey, not green', () => {
    expect(beaconLevel({ ...n, state: 'Stale', absent: ALL })).toBe('off')
    expect(beaconLevel({ ...n, absent: ['errors', 'cpu', 'memory', 'utilisation', 'throttled'] })).toBe('off')
  })

  it('still lights from what is measured', () => {
    expect(beaconLevel({ ...n, errorRate: 0.5, absent: ['cpu', 'memory', 'utilisation', 'throttled'] })).toBe('red')
    expect(beaconLevel({ ...n, errorRate: 0, cpu: 0.9, resourceAmber: 0.8, absent: ['errors', 'memory', 'utilisation', 'throttled'] })).toBe('amber')
  })

  it('is still grey for a source that is configured and silent', () => {
    expect(beaconLevel({ ...n, state: 'Stale', absent: ['cpu'] })).toBe('grey')
  })
})

describe('the plaque', () => {
  const n = nodeOf(town(), 'cl.ledger-api')

  it('says not monitored for a system with no source, and not "no data"', () => {
    expect(plaqueText({ ...n, state: 'Stale', absent: ALL })).toBe('not monitored')
  })

  it('says nothing about instances nobody counts', () => {
    expect(plaqueText({ ...n, instancesTotal: 0, instancesHealthy: 0, absent: ['instances'] })).toBe('')
  })

  it('says the instances are unknown when they were asked for and not counted, not 0/0 healthy', () => {
    expect(plaqueText({ ...n, state: 'Healthy', instancesTotal: 0, instancesHealthy: 0, absent: [] })).toBe('instances unknown')
    expect(plaqueText({ ...n, state: 'Healthy', instancesTotal: 3, instancesHealthy: 3, absent: [] })).toBe('3/3 healthy')
  })

  it('still says no data when a configured source is silent', () => {
    expect(plaqueText({ ...n, state: 'Stale', absent: ['cpu'] })).toBe('no data')
  })
})

describe('the inspector', () => {
  it('says there is no source for a system with none, and gives no reason to worry', () => {
    const n = nodeOf(unmonitored(town(), 'cl.ledger-api'), 'cl.ledger-api')

    expect(overviewRows(n)).toEqual([{ label: 'Data', value: 'no source configured', tone: '' }])
    expect(reasons(n)).toEqual([])
  })

  it('leaves out a row for each absent signal and shows the rest', () => {
    const n = nodeOf(partly(town(), 'cl.ledger-api'), 'cl.ledger-api')

    expect(overviewRows(n).map((r) => r.label)).toEqual(['Requests', 'Errors', 'p99 / SLA'])
  })

  it('shows no errors row and no error reason when errors are not measured, whatever the number says', () => {
    const n = nodeOf(partly(town(), 'cl.ledger-api', { absent: ['errors', 'instances'], errorRate: 0.9, instancesTotal: 0, instancesHealthy: 0 }), 'cl.ledger-api')

    expect(overviewRows(n).map((r) => r.label)).not.toContain('Errors')
    expect(reasons(n).join(' ')).not.toContain('Errors are at')
  })

  it('ignores a stray number for a signal that is absent', () => {
    const n = nodeOf(partly(town(), 'cl.ledger-api', { cpu: 0.99, resourceAmber: 0.8, resourceRed: 0.95, errorRate: 0 }), 'cl.ledger-api')

    expect(reasons(n)).toEqual([])
    expect(overviewRows(n).map((r) => r.label)).not.toContain('CPU')
  })

  it('shows every row for a system with every signal, as before', () => {
    const n = nodeOf(town(), 'cl.ledger-api')

    expect(overviewRows(n).map((r) => r.label)).toEqual(expect.arrayContaining(['Instances', 'Requests', 'Errors', 'p99 / SLA', 'Load']))
  })
})

describe('what counts as missing data', () => {
  it('does not count a system with no source, but counts one whose source is silent', () => {
    let s = unmonitored(town(), 'cl.ledger-api')
    expect(staleCount(s)).toBe(0)
    s = withState(s, 'cl.statements-api', 'Stale', { absent: ['cpu'] })
    expect(staleCount(s)).toBe(1)
  })

  it('does not ask the wall to look at a system with no source', () => {
    const s = unmonitored(town(), 'cl.ledger-api')

    expect(attentionOf(s)).toEqual([])
  })

  it('still asks it to look at a silent source', () => {
    const s = withState(town(), 'cl.ledger-api', 'Stale', { absent: [] })

    expect(attentionOf(s).map((a) => a.kind)).toEqual(['stale'])
  })
})

describe('a service', () => {
  const pad = () => ({ key: 'cl.ledger', name: 'Ledger', nodes: [{ id: 'cl.ledger-api' }, { id: 'cl.ledger-db' }] as never })
  const byId = (s: Snapshot) => new Map(s.groups.flatMap((g) => g.nodes).map((n) => [n.id, n]))

  it('takes its state from the systems that have a source', () => {
    let s = unmonitored(town(), 'cl.ledger-api')
    s = withState(s, 'cl.ledger-db', 'Degraded')

    const sv = summariseService(pad(), 'cl', 'Core Ledger', byId(s))

    expect(sv.state).toBe('Degraded')
    expect(sv.monitored).toBe(true)
  })

  it('is not monitored when none of its systems has a source, and is not stale either', () => {
    let s = unmonitored(town(), 'cl.ledger-api')
    s = unmonitored(s, 'cl.ledger-db')

    const sv = summariseService(pad(), 'cl', 'Core Ledger', byId(s))

    expect(sv.monitored).toBe(false)
    expect(sv.systems.every((x) => x.unmonitored)).toBe(true)
  })

  it('prints only the numbers a source supplies', () => {
    const base = { kind: 'Api' as const, unmonitored: false, requestsPerSecond: 12, errorRate: 0.01, p99Ms: 300, tenants: null }

    expect(systemNumbers({ ...base, absent: [] })).toBe('Api · 12/s · 1.00% errors · p99 300 ms')
    expect(systemNumbers({ ...base, absent: ['errors', 'latency'] })).toBe('Api · 12/s')
    expect(systemNumbers({ ...base, unmonitored: true, absent: ALL })).toBe('Api · no source configured')
  })
})
