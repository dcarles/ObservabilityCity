import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ago, clockTime, configOrder, filterLogs, incidentSummary, linkSections, overviewRows, reasons, stateTone } from '../../src/inspectorModel'
import type { ConfigValue, LogLine, SystemDetail, NodeSnapshot, Snapshot } from '../../src/types'

const bad = JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/bad-day.json'), 'utf8')) as Snapshot
const all = bad.groups.flatMap((g) => g.nodes)
const healthy = (): NodeSnapshot => ({ ...all.find((n) => n.state === 'Healthy' && n.kind === 'Api')! })
const node = (patch: Partial<NodeSnapshot>): NodeSnapshot => ({ ...healthy(), ...patch })

describe('why a system is not healthy', () => {
  it('says nothing about a healthy one', () => {
    expect(reasons(node({ errorRate: 0, p99Ms: 1, instancesHealthy: 3, instancesTotal: 3, cpu: 0.1, memory: 0.1, utilisation: null, throttled: null }))).toEqual([])
  })

  it('names the number and the line it crossed', () => {
    const n = node({ errorRate: 0.03, errorAmber: 0.01, errorRed: 0.05, p99Ms: 900, slaP99Ms: 300, instancesTotal: 5, instancesHealthy: 3 })

    expect(reasons(n)).toEqual([
      'Errors are at 3.0%, past the amber line of 1.0%.',
      'p99 is 900 ms, over the SLA of 300 ms.',
      '2 of 5 instances are unhealthy.',
    ])
  })

  it('says red when errors are past the red line', () => {
    expect(reasons(node({ errorRate: 0.07, errorAmber: 0.01, errorRed: 0.05 }))[0]).toBe('Errors are at 7.0%, past the red line of 5.0%.')
  })

  it('names resources, throttling, a late consumer and dead letters', () => {
    const n = node({ errorRate: 0, cpu: 0.9, resourceAmber: 0.8, resourceRed: 0.95, throttled: 0.05, throttleAmber: 0.001, oldestMessageSeconds: 120, backlogAmber: 60, deadLetters: 3 })

    const text = reasons(n).join(' ')
    expect(text).toContain('Resources are at 90%, past the amber line of 80%')
    expect(text).toContain('Turning away 5.0% of requests')
    expect(text).toContain('oldest message has waited 2m')
    expect(text).toContain('3.0 messages are in the dead-letter queue')
  })

  it('explains a system that is down, and one with no data', () => {
    expect(reasons(node({ state: 'Down' }))).toEqual(['Down: the system is not answering.'])
    expect(reasons(node({ state: 'Stale' }))[0]).toMatch(/No fresh data/)
  })
})

describe('the overview rows', () => {
  it('lists the numbers every system has, and colours the ones past a line', () => {
    const rows = overviewRows(node({ errorRate: 0.06, errorRed: 0.05, errorAmber: 0.01, p99Ms: 100, slaP99Ms: 300, cpu: null, memory: null, utilisation: null, throttled: null, queueDepth: null, oldestMessageSeconds: null, deadLetters: null }))

    expect(rows.map((r) => r.label)).toEqual(['Instances', 'Requests', 'Errors', 'p99 / SLA', 'Load'])
    expect(rows.find((r) => r.label === 'Errors')).toMatchObject({ value: '6.00%', tone: 'bad' })
    expect(rows.find((r) => r.label === 'p99 / SLA')).toMatchObject({ value: '100 ms / 300 ms', tone: '' })
  })

  it('adds what a source reports, and leaves out what it does not', () => {
    const rows = overviewRows(node({ cpu: 0.5, memory: 0.9, utilisation: 0.4, throttled: 0.02, throttleRed: 0.02, queueDepth: 12, oldestMessageSeconds: 30, deadLetters: 4 }))
    const labels = rows.map((r) => r.label)

    expect(labels).toEqual(expect.arrayContaining(['CPU', 'Memory', 'Capacity used', 'Throttled', 'Waiting', 'Oldest message', 'Dead letters']))
    expect(rows.find((r) => r.label === 'Memory')!.tone).toBe('warn')
    expect(rows.find((r) => r.label === 'Throttled')!.tone).toBe('bad')
    expect(rows.find((r) => r.label === 'Dead letters')!.tone).toBe('bad')
    expect(overviewRows(node({ cpu: null })).map((r) => r.label)).not.toContain('CPU')
  })

  it('shows only that there is no data for a stale system', () => {
    expect(overviewRows(node({ state: 'Stale' }))).toEqual([{ label: 'Data', value: 'none fresh', tone: 'stale' }])
  })
})

describe('words for states and incidents', () => {
  it('has a tone for every state', () => {
    expect(['Healthy', 'Degraded', 'Down', 'Stale'].map((s) => stateTone(s as never))).toEqual(['ok', 'warn', 'bad', 'stale'])
  })

  it('sums an islands incidents up by the worst', () => {
    const at = '2026-10-26T00:00:00Z'
    expect(incidentSummary([])).toBe('')
    expect(incidentSummary([{ id: 'a', title: 'x', severity: 3, startedAt: at }, { id: 'b', title: 'y', severity: 2, startedAt: at }, { id: 'c', title: 'z', severity: 4, startedAt: at }])).toBe('sev 2, 3 open')
  })

  it('says how long ago', () => {
    const now = new Date('2026-10-26T12:00:00Z').getTime()
    expect(ago('2026-10-26T11:59:56Z', now)).toBe('4 s ago')
    expect(ago('2026-10-26T11:55:00Z', now)).toBe('5 min ago')
    expect(ago(null, now)).toBe('never')
    expect(ago('2026-10-26T12:00:05Z', now)).toBe('0 s ago')
  })

  it('writes a clock time, and nothing for a bad one', () => {
    expect(clockTime('2026-10-26T12:04:09Z')).toMatch(/^\d\d:\d\d:\d\d$/)
    expect(clockTime('not a time')).toBe('')
  })
})

describe('log lines', () => {
  const at = '2026-10-26T12:00:00Z'
  const lines: LogLine[] = [
    { at, level: 'Info', message: 'a' }, { at, level: 'Warn', message: 'b' }, { at, level: 'Error', message: 'c' }, { at, level: 'Info', message: 'd' },
  ]

  it('can be narrowed to warnings and errors, or errors only', () => {
    expect(filterLogs(lines, 'all').map((l) => l.message)).toEqual(['a', 'b', 'c', 'd'])
    expect(filterLogs(lines, 'warn').map((l) => l.message)).toEqual(['b', 'c'])
    expect(filterLogs(lines, 'error').map((l) => l.message)).toEqual(['c'])
  })
})

describe('the config rows', () => {
  const row = (key: string, layer: ConfigValue['layer']): ConfigValue => ({ key, value: '1', layer, source: '' })

  it('put what the system sets itself first, then its pillar, then the defaults, keeping the order inside a layer', () => {
    const sorted = configOrder([row('a', 'BuiltIn'), row('b', 'App'), row('c', 'System'), row('d', 'Pillar'), row('e', 'System'), row('f', 'App')])

    expect(sorted.map((r) => r.key)).toEqual(['c', 'e', 'd', 'b', 'f', 'a'])
  })
})

describe('the links tab', () => {
  const detail: SystemDetail = {
    id: 'aa.api', name: 'Aa API', kind: 'Api', islandId: 'aa', islandName: 'Alpha', file: 'pillars/aa.yaml', config: [],
    calls: [{ id: 'hub.db', name: 'Hub DB', kind: 'System', islandId: 'hub', islandName: 'Platform hub' }, { id: 'ext.bureau', name: 'Bureau', kind: 'Vendor', islandId: '', islandName: '' }],
    calledBy: [], gatewayCalls: [], gatewayCalledBy: [{ id: 'bb.api', name: 'Bb API', kind: 'System', islandId: 'bb', islandName: 'Beta' }],
    outsideCallers: ['mobile-app'], serviceTopics: ['aa.events'], subscriptions: [{ topic: 'aa.events', publisher: 'aa.api', consumer: 'bb.worker', legacy: true }],
  }

  it('lists only the sections that have something, in reading order', () => {
    expect(linkSections(detail).map((s) => s.id)).toEqual(['calls', 'gatewayCalledBy', 'outside', 'topics', 'subscriptions'])
  })

  it('opens systems but not words, and names third parties as such', () => {
    const [calls, , outside] = linkSections(detail)
    expect(calls.items.map((i) => [i.id, i.where])).toEqual([['hub.db', 'Platform hub'], ['ext.bureau', 'Third party']])
    expect(outside.items).toEqual([{ id: null, name: 'mobile-app', where: 'Outside caller' }])
  })

  it('says which subscriptions are legacy', () => {
    const subs = linkSections(detail).find((s) => s.id === 'subscriptions')!
    expect(subs.items[0]).toEqual({ id: null, name: 'aa.events (legacy)', where: 'aa.api → bb.worker' })
  })

  it('has nothing for a system with no links at all', () => {
    expect(linkSections({ ...detail, calls: [], gatewayCalledBy: [], outsideCallers: [], serviceTopics: [], subscriptions: [] })).toEqual([])
  })
})
