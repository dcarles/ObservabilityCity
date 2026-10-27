import { describe, expect, it } from 'vitest'
import { QUIET_TEXT } from '../../src/signals'
import { checkSnapshot } from '../../src/snapshotGuard'
import { overviewRows } from '../../src/inspectorModel'
import { summariseService, systemNumbers } from '../../src/scene/service'
import type { NodeSnapshot, Snapshot } from '../../src/types'
import { healthyTown, withState } from './wall.testutil'

// A system with too few calls in the source's window to judge is quiet: the server leaves its error share and latency out (0), keeps its rate, and
// says so. The browser must not turn those zeros into a proud "0.00% errors, 0 ms".

const nodeOf = (s: Snapshot, id: string): NodeSnapshot => s.groups.flatMap((g) => g.nodes).find((n) => n.id === id)!
const quietTown = (id = 'cl.ledger-api'): Snapshot => withState(healthyTown(), id, 'Healthy', { quiet: true, requestsPerSecond: 0.013, errorRate: 0, p99Ms: 0 })
const label = (rows: { label: string; value: string }[], name: string) => rows.find((r) => r.label === name)?.value

describe('a quiet system', () => {
  it('is read from the snapshot, and an older server that does not say has none', () => {
    expect(nodeOf(checkSnapshot(quietTown()).snapshot!, 'cl.ledger-api').quiet).toBe(true)
    const old = healthyTown()
    delete (nodeOf(old, 'cl.ledger-api') as Partial<NodeSnapshot>).quiet
    expect(nodeOf(checkSnapshot(old).snapshot!, 'cl.ledger-api').quiet).toBe(false)
  })

  it('shows its rate in the inspector and says quiet where the error share and latency would be', () => {
    const rows = overviewRows(nodeOf(quietTown(), 'cl.ledger-api'))

    expect(label(rows, 'Requests')).toBe('0.0/s')
    expect(label(rows, 'Errors')).toBe(QUIET_TEXT)
    expect(label(rows, 'p99 / SLA')).toBe(QUIET_TEXT)
    expect(rows.find((r) => r.label === 'Errors')?.tone).toBe('')
  })

  it('shows real numbers for a system that is not quiet', () => {
    const rows = overviewRows(nodeOf(withState(healthyTown(), 'cl.ledger-api', 'Healthy', { requestsPerSecond: 12, errorRate: 0.004, p99Ms: 90 }), 'cl.ledger-api'))

    expect(label(rows, 'Errors')).toBe('0.40%')
    expect(label(rows, 'p99 / SLA')).toContain('90 ms')
  })

  it('says quiet on the service card instead of printing zero errors and latency', () => {
    const base = { kind: 'Api' as const, unmonitored: false, absent: [], requestsPerSecond: 0.5, errorRate: 0, p99Ms: 0, tenants: null }

    expect(systemNumbers({ ...base, quiet: true })).toBe('Api · 0.5/s · quiet')
    expect(systemNumbers({ ...base, quiet: false })).toBe('Api · 0.5/s · 0.00% errors · p99 0 ms')
    expect(systemNumbers(base)).toBe('Api · 0.5/s · 0.00% errors · p99 0 ms') // a card made before the field existed
  })

  it('carries quiet into the service summary and stays healthy', () => {
    const town = quietTown()
    const group = town.groups.find((g) => g.nodes.some((n) => n.id === 'cl.ledger-api'))!
    const nodes = new Map(group.nodes.map((n) => [n.id, n]))

    const summary = summariseService({ key: 'ledger', name: 'Ledger', nodes: [{ id: 'cl.ledger-api' }] } as never, group.id, group.displayName, nodes)

    expect(summary.systems[0].quiet).toBe(true)
    expect(summary.state).toBe('Healthy')
  })
})
