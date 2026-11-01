import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ago, clockTime, configOrder, groupDetail, incidentSummary, linkSections, logSectionEmpty, logSectionTitle, originLabel, isWebAddress, overviewLinks, overviewRows, reasons, repeatLabel, resourceLinks, scopeView, logLinkLabel, logTabLabel, pickLogSection, sectionLinks, stateTone } from '../../src/inspectorModel'
import type { ConfigValue, LogGroup, LogSection, ScopeInfo, ScopeResource, SystemDetail, NodeSnapshot, Snapshot } from '../../src/types'

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

  it('names the worst throttled tenant on the Throttled row', () => {
    const t = (name: string, throttled: number) => ({ id: name, name, kind: 'Customer' as const, database: 'd', state: 'Healthy' as const, utilisation: 0.5, throttled, requestsPerSecond: 1 })
    const row = (tenants: ReturnType<typeof t>[]) => overviewRows(node({ throttled: 0.032, throttleAmber: 0.01, throttleRed: 0.1, tenants })).find((r) => r.label === 'Throttled')!.value
    expect(row([t('Boohoo', 0.032), t('Lloyds', 0)])).toBe('3.2% · Boohoo')
    expect(row([t('Boohoo', 0.032), t('Lloyds', 0.02)])).toBe('3.2% · Boohoo +1 more')
    expect(overviewRows(node({ throttled: 0.032 })).find((r) => r.label === 'Throttled')!.value).toBe('3.2%')
  })

  it('shows what the tenant databases are provisioned at, one size or the range', () => {
    const t = (limit: number | null) => ({ id: String(limit), name: 'T', kind: 'Customer' as const, database: 'd', state: 'Healthy' as const, utilisation: 0.5, throttled: 0, requestsPerSecond: 1, limit })
    const row = (limits: (number | null)[]) => overviewRows(node({ tenants: limits.map(t) })).find((r) => r.label === 'Provisioned')?.value
    expect(row([20000, 20000])).toBe('20,000 RU/s')
    expect(row([4000, 20000])).toBe('4,000 to 20,000 RU/s')
    expect(row([null])).toBeUndefined()
    expect(overviewRows(node({})).map((r) => r.label)).not.toContain('Provisioned')
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

describe('the Logs tab', () => {
  const group = (over: Partial<LogGroup> = {}): LogGroup => ({ at: '2026-11-01T12:00:00Z', text: 'GET /a', count: 1, ...over })
  const section = (id: string, groups: LogGroup[] = []): LogSection => ({ id, groups })

  it('names its four sections, and the slow one names the line it is measured against', () => {
    expect(logSectionTitle(section('failed'), 800)).toBe('5xx requests')
    expect(logSectionTitle(section('logs'), 800)).toBe('Warnings and errors')
    expect(logSectionTitle(section('exceptions'), 800)).toBe('Exceptions')
    expect(logSectionTitle(section('slow'), 800)).toBe('Slow requests (over 800 ms)')
    expect(logSectionTitle(section('other'), 800)).toBe('other')
  })

  it('says what an empty section is empty of, over the window the server used', () => {
    expect(logSectionEmpty(section('failed'), '4h')).toBe('No 5xx requests in the last 4h.')
    expect(logSectionEmpty(section('slow'), '30m')).toBe('No slow requests in the last 30m.')
    expect(logSectionEmpty(section('logs'), '4h')).toBe('No warnings or errors in the last 4h.')
    expect(logSectionEmpty(section('exceptions'), '4h')).toBe('No exceptions in the last 4h.')
  })

  it('shows a repeat as a count and nothing for a single entry', () => {
    expect(repeatLabel(group({ count: 1 }))).toBe('')
    expect(repeatLabel(group({ count: 12 }))).toBe('×12')
  })

  it('adds the status and the time the newest request took, when it has them', () => {
    expect(groupDetail(group())).toBe('')
    expect(groupDetail(group({ result: '500' }))).toBe('500')
    expect(groupDetail(group({ result: '500', durationMs: 812 }))).toContain('500 · ')
    expect(groupDetail(group({ durationMs: 812 }))).not.toContain('·')
  })

  it('draws a header link only when it is a web address, whatever the server sent', () => {
    const links = [{ name: 'Trace', url: 'https://tracing.example.test/trace/1' }, { name: 'Bad', url: 'javascript:alert(1)' }, { name: '', url: 'https://x.example.test' }]
    expect(sectionLinks({ links }).map((l) => l.name)).toEqual(['Trace'])
    expect(sectionLinks({})).toEqual([])
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
    calls: [{ id: 'hub.db', name: 'Hub DB', kind: 'System', islandId: 'hub', islandName: 'Platform hub', found: false, lastSeen: null }, { id: 'ext.bureau', name: 'Bureau', kind: 'Vendor', islandId: '', islandName: '', found: false, lastSeen: null }],
    calledBy: [], gatewayCalls: [], gatewayCalledBy: [{ id: 'bb.api', name: 'Bb API', kind: 'System', islandId: 'bb', islandName: 'Beta', found: true, lastSeen: '2026-10-29' }],
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

  it('tags a link found in the telemetry with the day it was last seen, and a declared link as declared', () => {
    const [calls, gatewayCalledBy] = linkSections(detail)

    expect(calls.items.map((i) => i.origin)).toEqual([{ found: false, lastSeen: null }, { found: false, lastSeen: null }])
    expect(gatewayCalledBy.items[0].origin).toEqual({ found: true, lastSeen: '2026-10-29' })
    expect(originLabel(gatewayCalledBy.items[0].origin!)).toEqual({ text: 'Seen in calls', title: 'Found in the telemetry, last seen 2026-10-29' })
    expect(originLabel(calls.items[0].origin!)).toEqual({ text: 'Declared', title: 'Written in a registry file' })
  })

  it('gives words that are not links no origin', () => {
    const outside = linkSections(detail).find((s) => s.id === 'outside')!
    expect(outside.items[0].origin).toBeUndefined()
  })

  it('has nothing for a system with no links at all', () => {
    expect(linkSections({ ...detail, calls: [], gatewayCalledBy: [], outsideCallers: [], serviceTopics: [], subscriptions: [] })).toEqual([])
  })
})

describe('the scope rows', () => {
  const scope = (patch: Partial<ScopeInfo> = {}): ScopeInfo => ({
    subscription: 'sub-name', subscriptionVia: 'name', workspace: 'ws-prd', serviceCode: 'ord', telemetryRole: 'OrdersApi', telemetryRoleVia: 'telemetry.role',
    resources: [], instances: null, problems: [], inventoryState: 'read', ...patch,
  })

  it('draws nothing for an environment without scope rules', () => {
    expect(scopeView(null)).toBeNull()
    expect(scopeView(undefined)).toBeNull()
  })

  it('lists what the rules give, each with how it was found', () => {
    expect(scopeView(scope())!.rows).toEqual([
      { key: 'subscription', value: 'sub-name', note: 'found by its name' },
      { key: 'workspace', value: 'ws-prd', note: 'from the environment' },
      { key: 'service code', value: 'ord', note: 'matched against resource names' },
      { key: 'telemetry role', value: 'OrdersApi', note: 'set on this system' },
    ])
  })

  it('says how the workspace was settled: by its name, or by an id that is given outright', () => {
    const note = (via: string | null) => scopeView(scope({ workspaceVia: via }))!.rows.find((r) => r.key === 'workspace')!.note

    expect(note('name')).toBe('found by its name')
    expect(note('id')).toBe('its id is given, so nothing is looked up')
    expect(note(null)).toBe('from the environment')
    expect(note('something-new')).toBe('from the environment')
  })

  it('leaves out a value the rules do not give instead of showing it empty', () => {
    const rows = scopeView(scope({ subscription: null, subscriptionVia: null, workspace: null, serviceCode: null, telemetryRole: null, telemetryRoleVia: null }))!.rows

    expect(rows).toEqual([])
  })

  it('adds the instance count as a row when the rules count one, and leaves it out when they do not', () => {
    expect(scopeView(scope({ instances: 3 }))!.rows.at(-1)).toEqual({ key: 'instances', value: '3', note: 'added up over the resources that are counted' })
    expect(scopeView(scope({ instances: 0 }))!.rows.at(-1)!.value).toBe('0') // a plan that runs nothing is a count, not a missing one
    expect(scopeView(scope({ instances: null }))!.rows.map((r) => r.key)).not.toContain('instances')
  })

  it('keeps the count of each resource', () => {
    const v = scopeView(scope({ resources: [{ name: 'a', type: 't', region: 'r', tenant: null, instances: 2 }, { name: 'b', type: 't', region: null, tenant: null, instances: null }] }))!

    expect(v.resources.map((r) => r.instances)).toEqual([2, null])
  })

  it('says where a derived role came from', () => {
    expect(scopeView(scope({ telemetryRoleVia: 'scope.telemetryRole' }))!.rows.at(-1)!.note).toBe('derived from the environment template')
  })

  it('sorts the resources by name and keeps the tenant', () => {
    const v = scopeView(scope({ resources: [{ name: 'b', type: 't', region: 'r', tenant: 'Acme Bank', instances: null }, { name: 'a', type: 't', region: null, tenant: null, instances: null }] }))!

    expect(v.resources.map((r) => r.name)).toEqual(['a', 'b'])
    expect(v.resources[1].tenant).toBe('Acme Bank')
  })

  it('explains an inventory that is not there yet, is missing or failed, and says nothing once read', () => {
    expect(scopeView(scope({ inventoryState: 'read' }))!.status).toBe('')
    expect(scopeView(scope({ inventoryState: 'waiting' }))!.status).toMatch(/first read/)
    expect(scopeView(scope({ inventoryState: 'none' }))!.status).toMatch(/No inventory source/)
    expect(scopeView(scope({ inventoryState: 'failed' }))!.status).toMatch(/failed/)
  })

  it('passes on the problems the rules could not settle', () => {
    expect(scopeView(scope({ problems: ['No resource found for x'] }))!.problems).toEqual(['No resource found for x'])
  })
})

describe('the links to a system\'s resources', () => {
  const res = (name: string, patch: Partial<ScopeResource> = {}): ScopeResource => ({ name, type: 't', ...patch })
  const portal = (name: string) => ({ name: 'Portal', url: `https://portal.example.test/${name}` })
  const scope = (resources: ScopeResource[]): ScopeInfo => ({
    subscription: null, subscriptionVia: null, workspace: null, serviceCode: null, telemetryRole: null, telemetryRoleVia: null,
    resources, instances: null, problems: [], inventoryState: 'read',
  })

  it('accepts only http and https addresses', () => {
    expect(isWebAddress('https://portal.example.test/x')).toBe(true)
    expect(isWebAddress('http://intranet.example.test/x')).toBe(true)
    expect(isWebAddress('javascript:alert(1)')).toBe(false)
    expect(isWebAddress('data:text/html,hi')).toBe(false)
    expect(isWebAddress('/relative')).toBe(false)
    expect(isWebAddress('')).toBe(false)
  })

  it('keeps the safe links of a resource and drops the rest', () => {
    const r = res('a', { links: [portal('a'), { name: 'Bad', url: 'javascript:alert(1)' }, { name: '', url: 'https://x.example.test/' }] })
    expect(resourceLinks(r)).toEqual([portal('a')])
  })

  it('has no links for a resource without link rules', () => {
    expect(resourceLinks(res('a'))).toEqual([])
    expect(resourceLinks(res('a', { links: null }))).toEqual([])
  })

  it('shows nothing on the overview when no resource has a link', () => {
    expect(overviewLinks(null)).toBeNull()
    expect(overviewLinks(scope([res('a'), res('b', { tenant: 'Acme' })]))).toBeNull()
  })

  it('lists the links of resources without a tenant and counts the tenant ones', () => {
    const v = overviewLinks(scope([res('a', { links: [portal('a')] }), res('t1', { tenant: 'Acme', links: [portal('t1')] }), res('t2', { tenant: 'Borealis', links: [portal('t2')] })]))!
    expect(v.items).toEqual([{ resource: 'a', link: portal('a') }])
    expect(v.tenantResources).toBe(2)
    expect(v.more).toBe(0)
  })

  it('lists only the first few and says how many more there are', () => {
    const many = Array.from({ length: 9 }, (_, i) => res(`r${i}`, { links: [portal(`r${i}`)] }))
    const v = overviewLinks(scope(many))!
    expect(v.items).toHaveLength(6)
    expect(v.more).toBe(3)
  })
})

describe('the Logs sub-tabs', () => {
  const sec = (id: string, n: number) => ({ id, groups: Array.from({ length: n }, () => ({ at: '2026-11-01T10:00:00Z', text: 't', count: 1 })) }) as never
  it('writes the short title and the count', () => {
    expect(logTabLabel(sec('failed', 0))).toBe('5xx 0')
    expect(logTabLabel(sec('slow', 9))).toBe('Slow 9')
    expect(logTabLabel(sec('logs', 2))).toBe('Warnings and errors 2')
  })
  it('opens the chosen tab, else the first with entries, else the first', () => {
    const all = [sec('failed', 0), sec('slow', 3), sec('exceptions', 1)]
    expect(pickLogSection(all, 'exceptions')?.id).toBe('exceptions')
    expect(pickLogSection(all, '')?.id).toBe('slow')
    expect(pickLogSection(all, 'logs')?.id).toBe('slow')
    expect(pickLogSection([sec('failed', 0), sec('slow', 0)], '')?.id).toBe('failed')
    expect(pickLogSection([], '')).toBeUndefined()
  })
  it('names a link button after the store in its brackets, and keeps a whole name that has none', () => {
    expect(logLinkLabel('5xx in App Insights (appi-1)')).toEqual({ text: 'appi-1', title: '5xx in App Insights' })
    expect(logLinkLabel('5xx in App Insights')).toEqual({ text: '5xx in App Insights', title: '5xx in App Insights' })
  })
})
