import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chosenTenants, staleCount, stateFor, tenantShare, viewTotals } from '../../src/viewTotals'
import { ALL_TENANTS, type TenantView } from '../../src/tenants'
import type { Snapshot } from '../../src/types'

// tenants-town.json is the backend's staging snapshot: acme and borealis (customers), qa and smoke (test), ghost-co (not on the list).
// Shares: acme .314, borealis .482, qa .025, smoke .025, ghost-co .154. aa.orders-db: acme is Down, qa is Degraded, the store itself Degraded.
const staging = JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/tenants-town.json'), 'utf8')) as Snapshot
const view = (tenants: string[], hideTest = false): TenantView => ({ tenants, hideTest })
const store = () => staging.groups.flatMap((g) => g.nodes).find((n) => n.id === 'aa.orders-db')!

describe('the totals with every tenant', () => {
  it('are exactly the ones the backend worked out', () => {
    const t = viewTotals(staging, ALL_TENANTS)

    expect(t).toMatchObject(staging.totals)
    expect(t.tenantShare).toBe(1)
    expect(t.stale).toBe(0)
  })
})

describe('the share of the traffic', () => {
  it('is the share of the tenants chosen', () => {
    expect(tenantShare(staging.tenants, view(['acme']))).toBeCloseTo(0.314, 2)
    expect(tenantShare(staging.tenants, view(['acme', 'borealis']))).toBeCloseTo(0.796, 2)
  })

  it('leaves out the test tenants when they are hidden', () => {
    expect(tenantShare(staging.tenants, view([], true))).toBeCloseTo(1 - 0.05, 2)
    expect(tenantShare(staging.tenants, view(['qa', 'acme'], true))).toBeCloseTo(0.314, 2)
  })

  it('is 1 where there are no tenants to split it between', () => {
    expect(tenantShare([], view(['acme']))).toBe(1)
  })

  it('lists the tenants the choice leaves in', () => {
    expect(chosenTenants(staging.tenants, view([])).length).toBe(5)
    expect(chosenTenants(staging.tenants, view([], true)).map((t) => t.id)).toEqual(['acme', 'borealis', 'ghost-co'])
    expect(chosenTenants(staging.tenants, view(['qa'])).map((t) => t.id)).toEqual(['qa'])
  })
})

describe('the totals when some tenants are followed', () => {
  it('show their share of the requests and leave errors, p99, dead letters and incidents as they are', () => {
    const t = viewTotals(staging, view(['borealis']))

    expect(t.requestsPerSecond).toBeCloseTo(staging.totals.requestsPerSecond * 0.482, 0)
    expect(t.errorRate).toBe(staging.totals.errorRate)
    expect(t.p99Ms).toBe(staging.totals.p99Ms)
    expect(t.deadLetters).toBe(staging.totals.deadLetters)
    expect(t.incidents).toBe(staging.totals.incidents)
  })

  it('count the degraded and down systems from the followed tenants databases', () => {
    // acme is past the red line on the orders store, so following acme shows it down
    expect(viewTotals(staging, view(['acme']))).toMatchObject({ degraded: 0, down: 1 })
    // borealis is fine there: nothing is degraded, nothing down
    expect(viewTotals(staging, view(['borealis']))).toMatchObject({ degraded: 0, down: 0 })
    // a test tenant in trouble is amber
    expect(viewTotals(staging, view(['qa']))).toMatchObject({ degraded: 1, down: 0 })
  })

  it('hide the trouble of test tenants when they are hidden', () => {
    expect(viewTotals(staging, view(['qa', 'borealis'], true))).toMatchObject({ degraded: 0, down: 0 })
  })
})

describe('the state a system counts as', () => {
  it('is the snapshots own for a system without tenant databases', () => {
    const api = staging.groups.flatMap((g) => g.nodes).find((n) => n.id === 'aa.orders-api')!
    expect(stateFor(api, staging.tenants, view(['acme']))).toBe(api.state)
  })

  it('is the snapshots own when every tenant is shown', () => {
    expect(stateFor(store(), staging.tenants, ALL_TENANTS)).toBe('Degraded')
  })

  it('is the worst of the chosen tenants databases for a tenant store', () => {
    expect(stateFor(store(), staging.tenants, view(['acme', 'borealis']))).toBe('Down')
    expect(stateFor(store(), staging.tenants, view(['borealis']))).toBe('Healthy')
  })

  it('stays down when the store itself is down, whoever is followed', () => {
    expect(stateFor({ ...store(), state: 'Down' }, staging.tenants, view(['borealis']))).toBe('Down')
  })

  it('is grey when the chosen tenants databases have no data, never healthy', () => {
    const grey = { ...store(), tenants: store().tenants!.map((u) => (u.id === 'borealis' ? { ...u, state: 'Stale' as const } : u)) }
    expect(stateFor(grey, staging.tenants, view(['borealis']))).toBe('Stale')
  })
})

describe('systems with no data', () => {
  it('are counted, third parties too', () => {
    const quiet = structuredClone(staging)
    quiet.groups[1].nodes[0].state = 'Stale'
    quiet.vendors = [{ node: { ...quiet.groups[1].nodes[0], id: 'ext.x', state: 'Stale' }, calledBy: [] }]

    expect(staleCount(quiet)).toBe(2)
    expect(viewTotals(quiet, ALL_TENANTS).stale).toBe(2)
  })
})
