// What the dashboard shows, worked out from a snapshot as plain data. Nothing here touches the page, so every rule is unit tested.
// The numbers are the snapshot's own; the dashboard invents nothing, and a signal nobody measures is null (shown as a dash), never a zero.

import { dayTime, messagesPerSecond } from '../inspectorModel'
import { eventOfNode, healthEventsOf, isResolved } from '../healthEvents'
import { absentEverywhere, isAbsent, isUnmonitored } from '../signals'
import { isFollowed, isFollowing, isShown, isThrottled, tenantLevel, type TenantView } from '../tenants'
import { islandChoices } from '../islands'
import { deadLetterItems, dlqCount, type DeadLetterItem } from '../deadLetters'
import { stateFor, viewTotals } from '../viewTotals'
import { trafficSplit } from '../trafficSplit'
import { pillarTraffic } from '../trafficFlow'
import { flowsOf, flowTile, pillarFlow, trafficByPillar, type Flow, type FlowTile, type TrafficRow } from './flows'
import type { GroupSnapshot, HealthState, JobSnapshot, NodeSnapshot, Snapshot } from '../types'

/** ok / warn / bad are the three colours; none is grey: no fresh data, or no source at all. */
export type Level = 'ok' | 'warn' | 'bad' | 'none'

const RANK: Record<Level, number> = { none: 0, ok: 1, warn: 2, bad: 3 }
export const worse = (a: Level, b: Level): Level => (RANK[b] > RANK[a] ? b : a)
/** The worst of the levels; grey only counts when nothing else is known. */
export const worstOf = (levels: readonly Level[]): Level => levels.reduce<Level>((w, l) => (l === 'none' ? w : w === 'none' ? l : worse(w, l)), 'none')

export function levelOf(n: Pick<NodeSnapshot, 'absent' | 'kind' | 'jobs'>, state: HealthState): Level {
  if (isUnmonitored(n) || state === 'Stale') return 'none'
  return state === 'Down' ? 'bad' : state === 'Degraded' ? 'warn' : 'ok'
}

export { dlqCount }
/** Dead letters make a service at least amber (never red): a message nobody could handle is waiting. */
export function levelWithDlq(n: NodeSnapshot, level: Level): Level {
  return level === 'ok' && dlqCount(n) > 0 ? 'warn' : level
}
const dlqReason = (n: NodeSnapshot): string => `${dlqCount(n).toLocaleString('en-GB')} dead letter${dlqCount(n) === 1 ? '' : 's'}`

export interface Chip { id: string; name: string; rps: number | null }

export interface TenantRow {
  id: string
  name: string
  test: boolean
  unknown: boolean
  /** Share of the database's capacity in use, in percent. */
  ru: number | null
  /** Share of requests turned away, in percent. */
  throttled: number | null
  /** Capacity provisioned for it (request units per second for Cosmos), when the source reads one. */
  limit: number | null
  level: Level
  /** Past its amber line or throttling. */
  hot: boolean
}

/** One region of a service that runs in two or more: its own instances, CPU, memory (percent) and share of the requests (percent). */
export interface RegionRow {
  label: string
  /** A short tag for tight places: "N" for North, with a second letter when two regions start the same. */
  tag: string
  instances: number | null
  cpu: number | null
  memory: number | null
  share: number | null
}

/** How a p99 stands against its target: green under it, amber from 90% of it, red over it; none when there is no target or no number. */
export type LatencyLevel = 'ok' | 'warn' | 'bad' | 'none'

export interface Row {
  id: string
  name: string
  type: string
  /** What a database runs on: its name and type as the town gives them. Null for anything else. */
  engine: { name: string; type: string } | null
  level: Level
  reason: string | null
  rps: number | null
  errorPct: number | null
  p99: number | null
  /** The latency target in ms (the service's SLA), null when none is set. */
  sla: number | null
  latency: LatencyLevel
  instances: string | null
  /** Under the name: "3 North · 3 West" for a service in two or more regions, "6 instances" otherwise; null when nobody counts them. */
  instancesText: string | null
  /** Each region of a service in two or more; null for any other. */
  regions: RegionRow[] | null
  cpu: number | null
  memory: number | null
  /** The largest provisioned throughput of the tenant whose capacity share the row shows (the worst tenant), with its name; null when no limit is read. */
  ruMax: { limit: number; tenant: string } | null
  ru: number | null
  backlog: number | null
  dlq: number | null
  calledBy: Chip[]
  calls: Chip[]
  /** The tenant lines of a database with one database for each tenant; null for everything else. */
  tenants: TenantRow[] | null
  /** The tenant lines show by themselves: a tenant is at its amber line or throttling. */
  tenantsOpenByDefault: boolean
  /** The cloud's open health report for this system's resource ("Degraded", "Unavailable"), with since when and the cloud's name; null when the cloud reports nothing. */
  cloudHealth: { state: string; since: string; cloud: string } | null
}

export interface Group {
  key: string
  name: string
  level: Level
  rows: Row[]
  rps: number | null
  dlq: number | null
}

export interface Issue { id: string; name: string; where: string; level: Exclude<Level, 'ok' | 'none'>; reason: string | null }

export interface JobRow { name: string; where: string; region: string | null; status: JobSnapshot['status']; lastRun: string | null }

export interface Pillar {
  id: string
  name: string
  level: Level
  down: number
  degraded: number
  dlq: number
  issues: Issue[]
  groups: Group[]
  jobs: JobRow[]
  configError: string | null
  /** The messages a second this pillar sends to other pillars and receives from them; null when the environment does not measure it. */
  flow: Flow | null
  /** The requests a second all the pillar's services take in. */
  traffic: number
  /** Of those, what comes from outside, what the pillar sends to other pillars and what stays inside; null when no service knows its callers. */
  trafficSplit: { in: number; out: number; internal: number } | null
}

/** A line of the Hub, Vendors and internal-services lists. Health is null where nothing says (a monitoring resource, a vendor we see no calls to). */
export interface SideRow {
  id: string | null
  name: string
  level: Level
  health: string | null
  detail: string
  calledBy: Chip[]
  calls: Chip[]
  links: { name: string; url: string }[]
  /** Has a drawer to open (a system or a vendor); a resource that is only links has none. */
  drawer: boolean
}

export type SectionId = 'hub' | 'vendors' | 'digital'

export interface Section {
  id: SectionId
  title: string
  /** One line for the closed section; empty when there is nothing to say. */
  summary: string
  rows: SideRow[]
}

/** One line of the Incidents card: an cloud health report or an incident of the incident tool, with what it is about and its status. */
export interface IncidentRow {
  source: string
  what: string
  status: string
  /** Red while unresolved, green once resolved. */
  tone: 'bad' | 'ok'
  /** The system to open on a click; null when the report belongs to no system of the town. */
  nodeId: string | null
  /** When it was declared and, once resolved, when it ended ("declared 16:21 · resolved 18:17"); empty when the source gives no times. */
  times: string
  /** The id of the cloud report, for its Dismiss button; null for an incident of the incident tool. */
  dismiss: string | null
  /** Why, as the cloud said it; null when it gave none or the line is not a cloud report. */
  cause: string | null
}

export interface Dashboard {
  townName: string
  /** What the town calls an island (town.yaml groupLabel), for the words of the page. */
  groupLabel: string
  summary: {
    down: number
    degraded: number
    affected: Issue[]
    traffic: { total: number; external: number; internal: number } | null
    /** The requests a second of each pillar, busiest first, for the Traffic card. Empty when nothing reports requests. */
    trafficPillars: TrafficRow[]
    deadLetters: number | null
    backlog: number | null
    /** The queues with dead letters, worst first, for the Dead letters card. */
    deadQueues: DeadLetterItem[]
    /** The Message flow tile: the busiest pillars by what they send and receive. Null when no pillar moves any message. */
    flows: FlowTile | null
    /** The Incidents card: how many are open, and every line, open ones first. Null when nothing reports incidents (no health source, no incident tool with an incident). */
    incidents: { open: number; rows: IncidentRow[] } | null
  }
  pillars: Pillar[]
  sections: Section[]
  /** Pillars the viewer has hidden, to show again. */
  hidden: { id: string; name: string }[]
  /** Every pillar, shown or not, for the show/hide list. */
  choices: { id: string; name: string; shown: boolean }[]
}

const TYPE: Record<string, string> = { Api: 'API', Worker: 'Worker', Database: 'DB', Cache: 'Cache', Function: 'Function', Gateway: 'Gateway', Broker: 'Broker', Egress: 'Egress' }
const KIND_ORDER = ['Api', 'Function', 'Worker', 'Database', 'Cache', 'Gateway', 'Broker', 'Egress']
const pct = (v: number | null | undefined): number | null => (v == null ? null : v * 100)

/** p99 against its target: over is red, from 90% of it amber, under is green. No target or no number: none. */
export function latencyLevel(p99: number | null, sla: number | null): LatencyLevel {
  if (p99 == null || sla == null || sla <= 0) return 'none'
  const ratio = p99 / sla
  return ratio > 1 ? 'bad' : ratio >= 0.9 ? 'warn' : 'ok'
}

/** Short tags for region labels: the first letter, and two letters where the first letters of two regions are the same. */
export function regionTags(labels: readonly string[]): string[] {
  const first = labels.map((l) => (l.trim()[0] ?? '?').toUpperCase())
  return labels.map((l, i) => (first.filter((f) => f === first[i]).length > 1 ? l.trim().slice(0, 2) : first[i]))
}

/** The busiest first, then by name; a chip with no measured rate goes last. */
export const byRate = (list: readonly Chip[]): Chip[] => [...list].sort((a, b) => (b.rps ?? -1) - (a.rps ?? -1) || a.name.localeCompare(b.name))

/** A group's id turned into words for the header: "merchant-gateway" is "Merchant Gateway". Words that are already capitals are left alone. */
export function groupTitle(id: string): string {
  const words = id.split(/[-_.\s]+/).filter(Boolean)
  return words.length === 0 ? id : words.map((w) => (w === w.toUpperCase() ? w : w[0]!.toUpperCase() + w.slice(1))).join(' ')
}

/** What calls what, from the links the registry declares, with the rate each caller sends when the snapshot measures it. */
function linkIndex(s: Snapshot): { calledBy: Map<string, Chip[]>; calls: Map<string, Chip[]> } {
  const nodes = new Map<string, NodeSnapshot>()
  for (const g of s.groups) for (const n of g.nodes) nodes.set(n.id, n)
  for (const v of s.vendors) nodes.set(v.node.id, v.node)
  const rateTo = (callee: string, caller: string): number | null => nodes.get(callee)?.inbound?.find((l) => l.from === caller)?.requestsPerSecond ?? null
  const nameOf = (id: string): string => nodes.get(id)?.name ?? id
  const edges = new Map<string, Chip>()
  const add = (from: string, to: string): void => { if (!edges.has(`${from}>${to}`)) edges.set(`${from}>${to}`, { id: '', name: '', rps: rateTo(to, from) }) }
  for (const n of nodes.values()) for (const c of [...n.calls, ...n.gatewayCalls]) add(n.id, c)
  for (const v of s.vendors) {
    for (const caller of v.calledBy) add(caller, v.node.id)
    for (const callee of v.calls ?? []) add(v.node.id, callee)
  }
  const calledBy = new Map<string, Chip[]>()
  const calls = new Map<string, Chip[]>()
  const push = (m: Map<string, Chip[]>, key: string, chip: Chip): void => { (m.get(key) ?? m.set(key, []).get(key)!).push(chip) }
  for (const [key, e] of edges) {
    const [from, to] = key.split('>')
    push(calls, from, { id: to, name: nameOf(to), rps: e.rps })
    push(calledBy, to, { id: from, name: nameOf(from), rps: e.rps })
  }
  return { calledBy, calls }
}

function tenantRows(n: NodeSnapshot, view: TenantView): TenantRow[] | null {
  if (!n.tenants) return null
  return n.tenants
    .filter((u) => isShown(u, view) && (!isFollowing(view) || isFollowed(view, u.id)))
    .map((u) => ({
      id: u.id,
      name: u.name,
      test: u.kind === 'Test',
      unknown: u.kind === 'Unknown',
      ru: pct(u.utilisation),
      throttled: pct(u.throttled),
      limit: u.limit != null && u.limit > 0 ? u.limit : null,
      level: ({ green: 'ok', amber: 'warn', red: 'bad', grey: 'none' } as const)[tenantLevel(u)],
      hot: (u.utilisation ?? 0) >= n.resourceAmber || isThrottled(u, n.throttleAmber),
    }))
    .sort((a, b) => (b.ru ?? 0) - (a.ru ?? 0))
}

function rowOf(n: NodeSnapshot, s: Snapshot, view: TenantView, links: ReturnType<typeof linkIndex>): Row {
  const level = levelWithDlq(n, levelOf(n, stateFor(n, s.tenants ?? [], view)))
  const db = n.kind === 'Database'
  const tenants = tenantRows(n, view)
  const outside = n.outsideRequestsPerSecond ?? 0
  const calledBy = [...(links.calledBy.get(n.id) ?? [])]
  if (outside > 0) calledBy.push({ id: 'outside', name: 'Outside callers', rps: outside })
  const measured = level !== 'none'
  const absent = (sig: Parameters<typeof isAbsent>[1]): boolean => !measured || isAbsent(n, sig)
  const worstRu = tenants && tenants.length > 0 ? Math.max(...tenants.map((t) => t.ru ?? 0)) : null
  const worstTenant = tenants && tenants.length > 0 ? tenants.reduce((a, t) => ((t.ru ?? 0) > (a.ru ?? 0) ? t : a), tenants[0]!) : null
  const listed = (n.regions ?? []).length >= 2 ? n.regions! : null
  const tags = listed ? regionTags(listed.map((r) => r.label)) : []
  const regions: RegionRow[] | null = listed
    ? listed.map((r, i) => ({ label: r.label, tag: tags[i]!, instances: r.instances ?? null, cpu: absent('cpu') ? null : pct(r.cpu), memory: absent('memory') ? null : pct(r.memory), share: pct(r.share) }))
    : null
  const counted = regions?.filter((r) => r.instances != null) ?? []
  const instancesText = absent('instances') || n.instancesTotal === 0 ? null
    : counted.length >= 2 ? counted.map((r) => `${r.instances} ${r.label}`).join(' · ')
    : `${n.instancesTotal} instance${n.instancesTotal === 1 ? '' : 's'}`
  const sla = n.slaP99Ms > 0 ? n.slaP99Ms : null
  const p99 = db || absent('latency') || n.quiet ? null : n.p99Ms
  return {
    id: n.id,
    name: n.name,
    type: TYPE[n.kind] ?? n.kind,
    engine: n.engine ? { name: n.engine.name, type: n.engine.typeName } : null,
    level,
    reason: level === 'warn' || level === 'bad' ? n.reason ?? (dlqCount(n) > 0 ? dlqReason(n) : null) : null,
    rps: db || absent('requests') ? null : n.requestsPerSecond,
    errorPct: db || absent('errors') || n.quiet ? null : n.errorRate * 100,
    p99,
    sla: p99 == null ? null : sla,
    latency: latencyLevel(p99, sla),
    instances: absent('instances') || n.instancesTotal === 0 ? null : `${n.instancesHealthy}/${n.instancesTotal}`,
    instancesText,
    regions,
    cpu: absent('cpu') ? null : pct(n.cpu),
    memory: absent('memory') ? null : pct(n.memory),
    ruMax: worstTenant?.limit != null ? { limit: worstTenant.limit, tenant: worstTenant.name } : null,
    ru: absent('utilisation') ? null : worstRu ?? pct(n.utilisation),
    backlog: absent('backlog') ? null : n.queueDepth ?? null,
    dlq: absent('deadLetters') ? null : n.deadLetters ?? null,
    calledBy: byRate(calledBy),
    calls: byRate(links.calls.get(n.id) ?? []),
    tenants,
    tenantsOpenByDefault: tenants?.some((t) => t.hot) ?? false,
    cloudHealth: cloudHealthOf(n.id, s),
  }
}

function incidentsOf(s: Snapshot): Dashboard['summary']['incidents'] {
  const tool: IncidentRow[] = s.groups.flatMap((g) => g.incidents.map<IncidentRow>((i) => ({ source: 'Incident', what: `${i.title} · ${g.displayName}`, status: `sev ${i.severity}`, tone: 'bad', nodeId: null, times: i.startedAt ? `declared ${dayTime(i.startedAt, Date.now())}` : '', dismiss: null, cause: null })))
  const nameOf = new Map(s.groups.flatMap((g) => g.nodes.map((n) => [n.id, n.name] as const)))
  const cloudReports = healthEventsOf(s.healthEvents).map<IncidentRow>((e) => ({ source: s.cloud ?? 'Cloud', what: incidentName(e, nameOf), status: e.state, tone: isResolved(e) ? 'ok' : 'bad', nodeId: e.nodeId ?? null, times: [`declared ${dayTime(e.since, Date.now())}`, isResolved(e) && e.resolvedAt ? `resolved ${dayTime(e.resolvedAt, Date.now())}` : null].filter(Boolean).join(' · '), dismiss: e.id, cause: e.cause ?? null }))
  if (s.healthEvents == null && tool.length === 0) return null
  const rows = [...tool, ...cloudReports].sort((a, b) => Number(a.tone === 'ok') - Number(b.tone === 'ok'))
  return { open: rows.filter((r) => r.tone === 'bad').length, rows }
}

/** The name a report goes by in the card: the system's own name, as the service table shows it, and for a resource kept per tenant (a database) the tenant too; a resource no system owns keeps the cloud's name. */
export function incidentName(e: { resource: string; nodeId?: string | null; tenant?: string | null }, nameOf: ReadonlyMap<string, string>): string {
  const own = e.nodeId ? nameOf.get(e.nodeId) : undefined
  return own ? (e.tenant ? `${own} · ${e.tenant}` : own) : e.resource
}

/** Only an open report marks a row: once resolved it is left to the Incidents card. */
function cloudHealthOf(id: string, s: Snapshot): Row['cloudHealth'] {
  const e = eventOfNode(s.healthEvents, id)
  return e && !isResolved(e) ? { state: e.state, since: e.since, cloud: s.cloud ?? 'Cloud' } : null
}

function groupsOf(g: GroupSnapshot, rows: Row[], nodes: NodeSnapshot[]): Group[] {
  const byKey = new Map<string, { name: string; rows: Row[] }>()
  nodes.forEach((n, i) => {
    const name = n.service ?? n.name
    const key = `${g.id}/${name}`
    // a service id is turned into words; a system with no service keeps its own name
    const entry = byKey.get(key) ?? byKey.set(key, { name: n.service ? groupTitle(n.service) : n.name, rows: [] }).get(key)!
    entry.rows.push(rows[i])
  })
  const kindIndex = new Map(nodes.map((n, i) => [rows[i].id, KIND_ORDER.indexOf(n.kind)]))
  return [...byKey].map(([key, e]) => {
    const sorted = e.rows.sort((a, b) => (kindIndex.get(a.id) ?? 99) - (kindIndex.get(b.id) ?? 99) || a.name.localeCompare(b.name))
    const sum = (f: (r: Row) => number | null): number | null => { const v = sorted.map(f).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null }
    return { key, name: e.name, level: worstOf(sorted.map((r) => r.level)), rows: sorted, rps: sum((r) => r.rps), dlq: sum((r) => r.dlq) }
  }).sort((a, b) => RANK[b.level] - RANK[a.level] || a.name.localeCompare(b.name))
}

const num = (v: number, digits = 0): string => v.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })

/** The few numbers a row already has, in words: "12 rps · errors 0.4% · backlog 3". Only what is measured and worth saying. */
export function detailText(r: Row): string {
  const parts: string[] = []
  if (r.rps != null && r.rps > 0) parts.push(`${num(r.rps, r.rps < 10 ? 1 : 0)} rps`)
  if (r.errorPct != null && r.rps != null && r.rps > 0) parts.push(`errors ${num(r.errorPct, 1)}%`)
  if (r.p99 != null && r.rps != null && r.rps > 0) parts.push(`p99 ${num(r.p99)} ms`)
  if (r.cpu != null) parts.push(`CPU ${num(r.cpu)}%`)
  if (r.ru != null) parts.push(`capacity ${num(r.ru)}%`)
  if (r.backlog != null) parts.push(`backlog ${num(r.backlog)}`)
  if (r.dlq != null) parts.push(`DLQ ${num(r.dlq)}`)
  return parts.join(' · ')
}

const healthText = (level: Level, reason: string | null): string | null => (level === 'none' ? null : level === 'ok' ? 'Healthy' : `${level === 'bad' ? 'Down' : 'Degraded'}${reason ? ` · ${reason}` : ''}`)

/** The one line on a closed section: how many, what is wrong, what is not known. Empty when there is nothing to list. */
export function sectionSummary(noun: string, rows: readonly SideRow[], extra: readonly string[] = []): string {
  if (rows.length === 0) return ''
  const down = rows.filter((r) => r.level === 'bad').length
  const degraded = rows.filter((r) => r.level === 'warn').length
  const unknown = rows.filter((r) => r.level === 'none').length
  const known = rows.length - unknown
  const parts = [`${rows.length} ${noun}${rows.length === 1 ? '' : 's'}`, ...extra]
  if (down) parts.push(`${down} down`)
  if (degraded) parts.push(`${degraded} degraded`)
  if (!down && !degraded && known > 0) parts.push(unknown === 0 ? 'all healthy' : 'none affected')
  if (unknown > 0 && known > 0) parts.push(`${unknown} without health`)
  return parts.join(' · ')
}

function sectionsOf(s: Snapshot, view: TenantView, links: ReturnType<typeof linkIndex>): Section[] {
  const side = (n: NodeSnapshot, over: Partial<SideRow> = {}): SideRow => {
    const r = rowOf(n, s, view, links)
    return { id: n.id, name: n.name, level: r.level, health: healthText(r.level, r.reason), detail: detailText(r), calledBy: r.calledBy, calls: r.calls, links: [], drawer: true, ...over }
  }
  const hub = s.groups.find((g) => g.isHub)
  const hubRows = hub
    ? [
        ...hub.nodes.map((n) => side(n)),
        ...(hub.assets ?? []).map((a) => side({ id: a.id, name: a.name } as NodeSnapshot, { id: null, level: 'none', health: null, detail: a.group ? `${a.label} · ${a.group} · links only` : `${a.label} · links only`, calledBy: [], calls: [], links: a.links ?? [], drawer: false })),
      ]
    : []
  const backlog = hub?.nodes.filter((n) => n.state !== 'Stale' && !isAbsent(n, 'backlog')) ?? []
  const dlq = hub?.nodes.filter((n) => n.state !== 'Stale' && !isAbsent(n, 'deadLetters')) ?? []
  const hubExtra = [
    ...(backlog.length ? [`backlog ${num(backlog.reduce((a, n) => a + (n.queueDepth ?? 0), 0))}`] : []),
    ...(dlq.length ? [`DLQ ${num(dlq.reduce((a, n) => a + (n.deadLetters ?? 0), 0))}`] : []),
  ]
  const vendors = s.vendors.filter((v) => !v.internal).map((v) => side(v.node))
  const digital = s.vendors.filter((v) => v.internal).map((v) => side(v.node))
  return [
    { id: 'hub' as const, title: 'Hub', summary: sectionSummary('resource', hubRows, hubExtra), rows: hubRows },
    { id: 'vendors' as const, title: 'Vendors', summary: sectionSummary('vendor', vendors), rows: vendors },
    { id: 'digital' as const, title: s.internalVendorsLabel, summary: sectionSummary('service', digital), rows: digital },
  ].filter((x) => x.rows.length > 0)
}

/** Everything the dashboard draws, for the tenants the viewer chose. */
export function buildDashboard(s: Snapshot, view: TenantView, flowOrder: readonly string[] = []): Dashboard {
  const links = linkIndex(s)
  const issues = (nodes: NodeSnapshot[], where: string): Issue[] =>
    nodes.flatMap((n) => {
      // dead letters keep a row amber but are not "degraded": they have their own count and list, so they are not an issue here
      const level = levelOf(n, stateFor(n, s.tenants ?? [], view))
      return level === 'warn' || level === 'bad' ? [{ id: n.id, name: n.name, where, level, reason: n.reason ?? (dlqCount(n) > 0 ? dlqReason(n) : null) }] : []
    })
  const worstFirst = (a: Issue, b: Issue): number => (a.level === b.level ? a.name.localeCompare(b.name) : a.level === 'bad' ? -1 : 1)

  const flows = flowsOf(s)
  const splits = pillarTraffic(s)
  const totals = viewTotals(s, view)
  const pillars: Pillar[] = s.groups.filter((g) => !g.isHub).map((g) => {
    const rows = g.nodes.map((n) => rowOf(n, s, view, links))
    const groupIssues = issues(g.nodes, g.displayName).sort(worstFirst)
    const jobs = g.nodes.flatMap((n) => (n.jobs ?? []).map((j) => ({ name: j.name, where: n.name, region: j.region ?? null, status: j.status, lastRun: j.lastRun ?? null })))
    return {
      id: g.id,
      name: g.displayName,
      level: worstOf(rows.map((r) => r.level)),
      down: groupIssues.filter((i) => i.level === 'bad').length,
      degraded: groupIssues.filter((i) => i.level === 'warn').length,
      dlq: rows.reduce((a, r) => a + (r.dlq ?? 0), 0),
      issues: groupIssues,
      groups: groupsOf(g, rows, g.nodes),
      jobs,
      configError: g.configError ?? null,
      flow: pillarFlow(flows, g.id),
      traffic: rows.reduce((a, r) => a + (r.rps ?? 0), 0),
      trafficSplit: splits.get(g.id) ? { in: splits.get(g.id)!.in * totals.tenantShare, out: splits.get(g.id)!.out * totals.tenantShare, internal: splits.get(g.id)!.internal * totals.tenantShare } : null,
    }
  })

  const affected = [
    ...s.groups.flatMap((g) => issues(g.nodes, g.displayName)),
    ...s.vendors.flatMap((v) => issues([v.node], v.islandName ?? v.node.name)),
  ].sort(worstFirst)

  const queued = s.groups.flatMap((g) => g.nodes).filter((n) => n.state !== 'Stale' && !isAbsent(n, 'backlog'))
  const choices = islandChoices(s).filter((c) => !c.vendor)

  return {
    townName: s.townName,
    groupLabel: s.groupLabel,
    summary: {
      down: affected.filter((i) => i.level === 'bad').length,
      degraded: affected.filter((i) => i.level === 'warn').length,
      affected,
      traffic: trafficSplit(s, totals.requestsPerSecond, totals.tenantShare),
      trafficPillars: trafficByPillar(pillars.map((p) => ({ id: p.id, name: p.name, rps: p.traffic * totals.tenantShare, split: p.trafficSplit }))),
      deadLetters: absentEverywhere(s, 'deadLetters') ? null : totals.deadLetters,
      backlog: absentEverywhere(s, 'backlog') ? null : queued.reduce((a, n) => a + (n.queueDepth ?? 0), 0),
      deadQueues: deadLetterItems(s.groups),
      flows: flowTile(flows, flowOrder, messagesPerSecond(s.groups.flatMap((g) => g.nodes))),
      incidents: incidentsOf(s),
    },
    pillars,
    sections: sectionsOf(s, view, links),
    hidden: choices.filter((c) => !c.shown).map((c) => ({ id: c.id, name: c.name })),
    choices,
  }
}

/** The ids to ask the server for after one pillar is hidden or shown. Every pillar shown is the empty list (no filter). */
export function pillarSelection(s: Pick<Snapshot, 'groups' | 'view' | 'vendors'>, id: string, show: boolean): string[] {
  const all = islandChoices(s)
  const shown = new Set(all.filter((c) => c.shown).map((c) => c.id))
  if (show) shown.add(id)
  else shown.delete(id)
  return all.every((c) => shown.has(c.id)) ? [] : all.filter((c) => shown.has(c.id)).map((c) => c.id)
}
