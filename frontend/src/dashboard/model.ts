// What the dashboard shows, worked out from a snapshot as plain data. Nothing here touches the page, so every rule is unit tested.
// The numbers are the snapshot's own; the dashboard invents nothing, and a signal nobody measures is null (shown as a dash), never a zero.

import { absentEverywhere, isAbsent, isUnmonitored } from '../signals'
import { isFollowed, isFollowing, isShown, isThrottled, tenantLevel, type TenantView } from '../tenants'
import { islandChoices } from '../islands'
import { stateFor, viewTotals } from '../viewTotals'
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
  level: Level
  /** Past its amber line or throttling. */
  hot: boolean
}

export interface Row {
  id: string
  name: string
  type: string
  level: Level
  reason: string | null
  rps: number | null
  errorPct: number | null
  p99: number | null
  instances: string | null
  cpu: number | null
  ru: number | null
  backlog: number | null
  dlq: number | null
  calledBy: Chip[]
  calls: Chip[]
  /** The tenant lines of a database with one database for each tenant; null for everything else. */
  tenants: TenantRow[] | null
  /** The tenant lines show by themselves: a tenant is at its amber line or throttling. */
  tenantsOpenByDefault: boolean
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
}

export interface Dashboard {
  townName: string
  summary: {
    down: number
    degraded: number
    affected: Issue[]
    traffic: { total: number; external: number; internal: number } | null
    deadLetters: number | null
    backlog: number | null
  }
  pillars: Pillar[]
  /** Pillars the viewer has hidden, to show again. */
  hidden: { id: string; name: string }[]
  /** Every pillar, shown or not, for the show/hide list. */
  choices: { id: string; name: string; shown: boolean }[]
}

const TYPE: Record<string, string> = { Api: 'API', Worker: 'Worker', Database: 'DB', Cache: 'Cache', Function: 'Function', Gateway: 'Gateway', Broker: 'Broker', Egress: 'Egress' }
const KIND_ORDER = ['Api', 'Function', 'Worker', 'Database', 'Cache', 'Gateway', 'Broker', 'Egress']
const pct = (v: number | null | undefined): number | null => (v == null ? null : v * 100)

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
      level: ({ green: 'ok', amber: 'warn', red: 'bad', grey: 'none' } as const)[tenantLevel(u)],
      hot: (u.utilisation ?? 0) >= n.resourceAmber || isThrottled(u, n.throttleAmber),
    }))
    .sort((a, b) => (b.ru ?? 0) - (a.ru ?? 0))
}

function rowOf(n: NodeSnapshot, s: Snapshot, view: TenantView, links: ReturnType<typeof linkIndex>): Row {
  const level = levelOf(n, stateFor(n, s.tenants ?? [], view))
  const db = n.kind === 'Database'
  const tenants = tenantRows(n, view)
  const outside = n.outsideRequestsPerSecond ?? 0
  const calledBy = [...(links.calledBy.get(n.id) ?? [])]
  if (outside > 0) calledBy.push({ id: 'outside', name: 'Outside callers', rps: outside })
  const measured = level !== 'none'
  const absent = (sig: Parameters<typeof isAbsent>[1]): boolean => !measured || isAbsent(n, sig)
  const worstRu = tenants && tenants.length > 0 ? Math.max(...tenants.map((t) => t.ru ?? 0)) : null
  return {
    id: n.id,
    name: n.name,
    type: TYPE[n.kind] ?? n.kind,
    level,
    reason: level === 'warn' || level === 'bad' ? n.reason ?? null : null,
    rps: db || absent('requests') ? null : n.requestsPerSecond,
    errorPct: db || absent('errors') || n.quiet ? null : n.errorRate * 100,
    p99: db || absent('latency') || n.quiet ? null : n.p99Ms,
    instances: absent('instances') || n.instancesTotal === 0 ? null : `${n.instancesHealthy}/${n.instancesTotal}`,
    cpu: absent('cpu') ? null : pct(n.cpu),
    ru: absent('utilisation') ? null : worstRu ?? pct(n.utilisation),
    backlog: absent('backlog') ? null : n.queueDepth ?? null,
    dlq: absent('deadLetters') ? null : n.deadLetters ?? null,
    calledBy,
    calls: links.calls.get(n.id) ?? [],
    tenants,
    tenantsOpenByDefault: tenants?.some((t) => t.hot) ?? false,
  }
}

function groupsOf(g: GroupSnapshot, rows: Row[], nodes: NodeSnapshot[]): Group[] {
  const byKey = new Map<string, { name: string; rows: Row[] }>()
  nodes.forEach((n, i) => {
    const name = n.service ?? n.name
    const key = `${g.id}/${name}`
    const entry = byKey.get(key) ?? byKey.set(key, { name, rows: [] }).get(key)!
    entry.rows.push(rows[i])
  })
  const kindIndex = new Map(nodes.map((n, i) => [rows[i].id, KIND_ORDER.indexOf(n.kind)]))
  return [...byKey].map(([key, e]) => {
    const sorted = e.rows.sort((a, b) => (kindIndex.get(a.id) ?? 99) - (kindIndex.get(b.id) ?? 99) || a.name.localeCompare(b.name))
    const sum = (f: (r: Row) => number | null): number | null => { const v = sorted.map(f).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null }
    return { key, name: e.name, level: worstOf(sorted.map((r) => r.level)), rows: sorted, rps: sum((r) => r.rps), dlq: sum((r) => r.dlq) }
  }).sort((a, b) => RANK[b.level] - RANK[a.level] || a.name.localeCompare(b.name))
}

/** Everything the dashboard draws, for the tenants the viewer chose. */
export function buildDashboard(s: Snapshot, view: TenantView): Dashboard {
  const links = linkIndex(s)
  const issues = (nodes: NodeSnapshot[], where: string): Issue[] =>
    nodes.flatMap((n) => {
      const level = levelOf(n, stateFor(n, s.tenants ?? [], view))
      return level === 'warn' || level === 'bad' ? [{ id: n.id, name: n.name, where, level, reason: n.reason ?? null }] : []
    })
  const worstFirst = (a: Issue, b: Issue): number => (a.level === b.level ? a.name.localeCompare(b.name) : a.level === 'bad' ? -1 : 1)

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
    }
  })

  const affected = [
    ...s.groups.flatMap((g) => issues(g.nodes, g.displayName)),
    ...s.vendors.flatMap((v) => issues([v.node], v.islandName ?? v.node.name)),
  ].sort(worstFirst)

  const totals = viewTotals(s, view)
  const outside = s.outsideRequestsPerSecond ?? s.externalCallers.reduce((a, c) => a + c.requestsPerSecond, 0)
  const external = Math.min(totals.requestsPerSecond, outside * totals.tenantShare)
  const queued = s.groups.flatMap((g) => g.nodes).filter((n) => n.state !== 'Stale' && !isAbsent(n, 'backlog'))
  const choices = islandChoices(s).filter((c) => !c.vendor)

  return {
    townName: s.townName,
    summary: {
      down: affected.filter((i) => i.level === 'bad').length,
      degraded: affected.filter((i) => i.level === 'warn').length,
      affected,
      traffic: absentEverywhere(s, 'requests') ? null : { total: totals.requestsPerSecond, external, internal: Math.max(0, totals.requestsPerSecond - external) },
      deadLetters: absentEverywhere(s, 'deadLetters') ? null : totals.deadLetters,
      backlog: absentEverywhere(s, 'backlog') ? null : queued.reduce((a, n) => a + (n.queueDepth ?? 0), 0),
    },
    pillars,
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
