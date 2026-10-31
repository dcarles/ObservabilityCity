import { describe, expect, it } from 'vitest'
import { isUnmonitored, SIGNALS } from '../../src/signals'
import { checkSnapshot } from '../../src/snapshotGuard'
import { jobReasons, jobRows, overviewRows, reasons } from '../../src/inspectorModel'
import { regionLine, regionOptions, validChoice, withRegion, worstRegion } from '../../src/regions'
import { beaconLevel, plaqueText } from '../../src/visuals'
import type { NodeSnapshot, Snapshot } from '../../src/types'
import { healthyTown } from './wall.testutil'

// Phase 3, slices 3 and 3b: a function building (the old cron) knows whether its app runs and how each scheduled job is doing; a service in two regions
// shows its worst region and lets the viewer look at another.

const town = (): Snapshot => healthyTown()
const first = (s: Snapshot): NodeSnapshot => s.groups.flatMap((g) => g.nodes)[0]!
const fn = (patch: Partial<NodeSnapshot> = {}): NodeSnapshot => ({ ...first(town()), kind: 'Function', app: 'Running', absent: ['requests', 'errors', 'latency', 'instances', 'backlog', 'deadLetters', 'utilisation', 'throttled', 'cpu', 'memory'], ...patch })
const job = (name: string, status: 'Ok' | 'Failed' | 'Overdue', region: string | null = null) => ({ name, region, status, lastRun: '2026-01-01T10:00:00Z', next: '2026-01-01T11:00:00Z' })
const twoRegions = (patch: Partial<NodeSnapshot> = {}): NodeSnapshot => ({
  ...first(town()),
  instancesTotal: 1, instancesHealthy: 1, cpu: 0.64, memory: 0.6,
  regions: [{ region: 'northeurope', label: 'North', instances: 2, cpu: 0.4, memory: 0.58 }, { region: 'westeurope', label: 'West', instances: 1, cpu: 0.64, memory: 0.6 }],
  ...patch,
})

describe('a function building', () => {
  it('is monitored by its jobs alone, and unmonitored when nothing reads them', () => {
    const only = fn({ jobs: [job('daily', 'Ok')] })
    expect(isUnmonitored(only)).toBe(false) // every ordinary signal is absent, but the jobs are read
    expect(isUnmonitored({ ...only, kind: 'Function', absent: [...SIGNALS, 'jobs'] })).toBe(true)
    expect(isUnmonitored({ kind: 'Api', absent: [...SIGNALS] })).toBe(true)
  })

  it('lists each job in each region with its state, and says in words what is wrong', () => {
    const n = fn({ state: 'Down', jobs: [job('daily', 'Ok', 'North'), job('hourly', 'Overdue', 'West'), job('purge', 'Failed', 'West')] })

    expect(jobRows(n).map((r) => [r.label, r.tone])).toEqual([['daily (North)', ''], ['hourly (West)', 'warn'], ['purge (West)', 'bad']])
    expect(jobRows(n)[2]!.value).toMatch(/^failed · ran .+ · next .+$/)
    expect(jobReasons(n)).toHaveLength(2)
    expect(reasons(n)[0]).toMatch(/^Job hourly \(West\) should have run at .+ and has not\.$/)
    expect(reasons(n)[1]).toMatch(/^Job purge \(West\) failed its last run at /)
  })

  it('is red for a failed job and amber for a late one, whatever else is quiet', () => {
    expect(beaconLevel({ ...fn({ state: 'Down', jobs: [job('a', 'Failed')] }) })).toBe('red')
    expect(beaconLevel({ ...fn({ state: 'Degraded', jobs: [job('a', 'Overdue')] }) })).toBe('amber')
    expect(beaconLevel({ ...fn({ state: 'Healthy', jobs: [job('a', 'Ok')] }) })).toBe('green')
    expect(beaconLevel({ ...fn({ state: 'Healthy', jobs: null }) })).toBe('off') // nothing here is measured
  })

  it('stands as a half-built shell while its app is stopped, and says so', () => {
    const stopped = fn({ app: 'Stopped' })
    expect(plaqueText(stopped)).toBe('stopped')
    expect(overviewRows(stopped)[0]).toEqual({ label: 'App', value: 'stopped (under construction)', tone: 'warn' })
    expect(reasons(stopped).join(' ')).toContain('under construction')
  })

  it('is grey and says not found when the inventory does not have its app', () => {
    const missing = fn({ app: 'Missing', state: 'Stale' })
    expect(plaqueText(missing)).toBe('not found')
    expect(overviewRows(missing)).toEqual([{ label: 'App', value: 'not found in the inventory', tone: 'stale' }])
    expect(reasons(missing)[0]).toContain('not found in the inventory')
  })

  it('never shows 0 of 0 instances: a building whose instances are absent says nothing of them', () => {
    expect(plaqueText({ ...fn({ app: 'Running' }), instancesTotal: 0, instancesHealthy: 0, absent: ['instances'] })).toBe('')
  })

  it('survives the snapshot check with its app, jobs and regions, and drops what is not usable', () => {
    const s = town()
    const n = first(s)
    const raw = { ...s, groups: s.groups.map((g, i) => (i === 0 ? { ...g, nodes: g.nodes.map((x, j) => (j === 0 ? { ...x, kind: 'Function', app: 'Running', absent: ['jobs'],
      jobs: [job('daily', 'Failed', 'West'), { name: '', status: 'Ok' }, { name: 'odd', status: 'Strange', lastRun: 7 }],
      regions: [{ region: 'a', label: '', instances: 2, cpu: 'x', memory: 0.1 }, { region: '' }] } : x)) } : g)) }

    const checked = checkSnapshot(raw).snapshot!.groups[0]!.nodes[0]!

    expect(checked.id).toBe(n.id)
    expect(checked.app).toBe('Running')
    expect(checked.absent).toEqual(['jobs'])
    expect(checked.jobs).toEqual([{ name: 'daily', region: 'West', status: 'Failed', lastRun: '2026-01-01T10:00:00Z', next: '2026-01-01T11:00:00Z' }, { name: 'odd', region: null, status: 'Ok', lastRun: null, next: null }])
    expect(checked.regions).toEqual([{ region: 'a', label: 'a', instances: 2, cpu: null, memory: 0.1 }])
    expect(checkSnapshot({ ...raw, groups: raw.groups.map((g) => ({ ...g, nodes: g.nodes.map((x) => ({ ...x, app: 'Weird', jobs: 'no', regions: 3 })) })) }).snapshot!.groups[0]!.nodes[0]).toMatchObject({ app: null, jobs: null, regions: null })
  })
})

describe('the per-region view', () => {
  it('offers a choice only to a service in two or more regions', () => {
    expect(regionOptions(first(town()))).toEqual([])
    expect(regionOptions(twoRegions())).toEqual([{ id: 'worst', label: 'Worst' }, { id: 'all', label: 'All' }, { id: 'northeurope', label: 'North' }, { id: 'westeurope', label: 'West' }])
    expect(regionOptions({ regions: [{ region: 'a', label: 'A', instances: 1, cpu: null, memory: null }] })).toEqual([])
  })

  it('shows the worst region by default, and says which region the numbers are', () => {
    const n = twoRegions()
    expect(withRegion(n, 'worst')).toBe(n)
    expect(worstRegion(n)).toBe('West')
    expect(regionLine(n, 'worst')).toBe('West (worst of 2)')
    expect(regionLine(first(town()), 'worst')).toBe('')
  })

  it('shows one region by itself', () => {
    const n = withRegion(twoRegions(), 'northeurope')
    expect([n.instancesTotal, n.instancesHealthy, n.cpu, n.memory]).toEqual([2, 2, 0.4, 0.58])
    expect(regionLine(twoRegions(), 'northeurope')).toBe('North')
  })

  it('shows all regions together: the instances add up, the busiest CPU and memory stand', () => {
    const n = withRegion(twoRegions(), 'all')
    expect([n.instancesTotal, n.instancesHealthy, n.cpu, n.memory]).toEqual([3, 3, 0.64, 0.6])
    expect(regionLine(twoRegions(), 'all')).toBe('all 2 regions')
  })

  it('keeps the instances it has when a region does not count its own, and the building\'s health is not recomputed', () => {
    const n = twoRegions({ state: 'Degraded', regions: [{ region: 'a', label: 'A', instances: null, cpu: 0.2, memory: null }, { region: 'b', label: 'B', instances: 2, cpu: 0.9, memory: null }] })
    expect(withRegion(n, 'all').instancesTotal).toBe(1)
    expect(withRegion(n, 'a').instancesTotal).toBe(1)
    expect(withRegion(n, 'a').state).toBe('Degraded')
  })

  it('falls back to the worst region when the chosen one has left the snapshot', () => {
    expect(validChoice(twoRegions(), 'eastus')).toBe('worst')
    expect(validChoice(twoRegions(), 'all')).toBe('all')
    expect(validChoice(first(town()), 'all')).toBe('worst')
  })
})
