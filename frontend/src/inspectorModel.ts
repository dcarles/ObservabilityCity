// What the inspector drawer says, as pure functions: a system's numbers in, rows and sentences out.

import type { ConfigValue, HealthState, IncidentSnapshot, JobSnapshot, LinkRef, LogGroup, LogSection, NodeSnapshot, ResourceLink, ScopeInfo, ScopeResource, SettingLayer, SystemDetail } from './types'
import { inboundSplitText } from './inbound'
import { limitRange, throttleWho } from './tenants'
import { isAbsent, isUnmonitored, QUIET_TEXT } from './signals'
import { formatAge, formatMs, formatRate, plaqueText, resourceUse } from './visuals'

export type Tone = 'ok' | 'warn' | 'bad' | 'stale' | ''

export const stateTone = (s: HealthState): Tone => (s === 'Healthy' ? 'ok' : s === 'Degraded' ? 'warn' : s === 'Down' ? 'bad' : 'stale')

const pct = (v: number, digits = 0): string => `${(v * 100).toFixed(digits)}%`

/** What a missing app says: it names the cloud the environment says it uses (scope.cloud), and the inventory when it does not say. */
export const notFoundText = (cloud?: string | null): string => `not found in ${cloud ? cloud : 'the inventory'}`

const jobName = (j: { name: string; region?: string | null }): string => (j.region ? `${j.name} (${j.region})` : j.name)

/** The jobs of a function that are failing or late, in words. */
export function jobReasons(n: Pick<NodeSnapshot, 'jobs'>, now: number = Date.now()): string[] {
  return (n.jobs ?? []).flatMap((j) =>
    j.status === 'Failed' ? [`Job ${jobName(j)} failed its last run${j.lastRun ? ` at ${dayTime(j.lastRun, now)}` : ''}.`]
      : j.status === 'Overdue' ? [`Job ${jobName(j)} should have run${j.next ? ` at ${dayTime(j.next, now)}` : ''} and has not.`]
        : [])
}

/** In words, why the system is not healthy. Empty for a healthy one. Each line names the number and the line it crossed. */
export function reasons(n: NodeSnapshot, cloud?: string | null): string[] {
  if (isUnmonitored(n)) return []
  if (n.app === 'Missing') return [`The app is ${notFoundText(cloud)}: the cloud has no resource of this name, so nothing here is shown as healthy.`]
  if (n.state === 'Stale') return ['No fresh data: the last reading is too old to trust, so nothing here is shown as healthy.']
  const jobs = jobReasons(n)
  if (n.state === 'Down') return jobs.length > 0 ? jobs : ['Down: the system is not answering.']
  const out: string[] = [...jobs]
  if (n.app === 'Stopped') out.push('The app is stopped, so this building is under construction and its jobs are not judged.')
  if (isAbsent(n, 'errors')) { /* nothing measures errors here, so there is nothing to say about them */ }
  else if (n.errorRate >= n.errorRed) out.push(`Errors are at ${pct(n.errorRate, 1)}, past the red line of ${pct(n.errorRed, 1)}.`)
  else if (n.errorRate >= n.errorAmber) out.push(`Errors are at ${pct(n.errorRate, 1)}, past the amber line of ${pct(n.errorAmber, 1)}.`)
  if (!isAbsent(n, 'latency') && n.p99Ms > n.slaP99Ms) out.push(`p99 is ${formatMs(n.p99Ms)}, over the SLA of ${formatMs(n.slaP99Ms)}.`)
  if (!isAbsent(n, 'instances') && n.instancesHealthy < n.instancesTotal) out.push(`${n.instancesTotal - n.instancesHealthy} of ${n.instancesTotal} instances are unhealthy.`)
  const use = resourceUse(n)
  if (use >= n.resourceRed) out.push(`Resources are at ${pct(use)}, past the red line of ${pct(n.resourceRed)}.`)
  else if (use >= n.resourceAmber) out.push(`Resources are at ${pct(use)}, past the amber line of ${pct(n.resourceAmber)}.`)
  if (!isAbsent(n, 'throttled') && (n.throttled ?? 0) >= n.throttleAmber && (n.throttled ?? 0) > 0) out.push(`Turning away ${pct(n.throttled!, 1)} of requests (throttled).`)
  if (!isAbsent(n, 'backlog') && (n.oldestMessageSeconds ?? 0) >= n.backlogAmber && (n.oldestMessageSeconds ?? 0) > 0) out.push(`The oldest message has waited ${formatAge(n.oldestMessageSeconds!)}, past the ${formatAge(n.backlogAmber)} line.`)
  if (!isAbsent(n, 'deadLetters') && (n.deadLetters ?? 0) > 0) out.push(`${formatRate(n.deadLetters!)} message${n.deadLetters === 1 ? ' is' : 's are'} in the dead-letter queue.`)
  return out
}

export interface Row {
  label: string
  value: string
  tone: Tone
}

/** The key numbers of a system, in reading order. Numbers a source does not give are left out, not shown as zero. */
export function overviewRows(n: NodeSnapshot, nameOf: (id: string) => string = (id) => id, cloud?: string | null): Row[] {
  if (isUnmonitored(n)) return [{ label: 'Data', value: 'no source configured', tone: '' }]
  if (n.app === 'Missing') return [{ label: 'App', value: notFoundText(cloud), tone: 'stale' }]
  if (n.state === 'Stale') return [{ label: 'Data', value: 'none fresh', tone: 'stale' }]
  const rows: Row[] = []
  if (n.app === 'Running' || n.app === 'Stopped') rows.push({ label: 'App', value: n.app === 'Running' ? 'running' : 'stopped (under construction)', tone: n.app === 'Stopped' ? 'warn' : '' })
  if (!isAbsent(n, 'instances')) rows.push({ label: 'Instances', value: plaqueText(n), tone: n.instancesHealthy < n.instancesTotal ? 'warn' : '' })
  if (!isAbsent(n, 'requests')) rows.push({ label: 'Requests', value: `${formatRate(n.requestsPerSecond)}/s`, tone: '' })
  const split = isAbsent(n, 'requests') ? null : inboundSplitText(n, nameOf)
  if (split) rows.push({ label: 'Comes from', value: `${split}${n.inboundEstimated ? ' (estimated)' : ' (measured)'}`, tone: '' })
  if (!isAbsent(n, 'errors')) rows.push(n.quiet ? { label: 'Errors', value: QUIET_TEXT, tone: '' } : { label: 'Errors', value: pct(n.errorRate, 2), tone: n.errorRate >= n.errorRed ? 'bad' : n.errorRate >= n.errorAmber ? 'warn' : '' })
  if (!isAbsent(n, 'latency')) rows.push(n.quiet ? { label: 'p99 / SLA', value: QUIET_TEXT, tone: '' } : { label: 'p99 / SLA', value: `${formatMs(n.p99Ms)} / ${formatMs(n.slaP99Ms)}`, tone: n.p99Ms > n.slaP99Ms ? 'warn' : '' })
  if (!isAbsent(n, 'requests') && !isAbsent(n, 'instances')) rows.push({ label: 'Load', value: pct(n.load), tone: '' })
  const hot = (v: number) => (v >= n.resourceRed ? 'bad' : v >= n.resourceAmber ? 'warn' : '') as Tone
  if (n.cpu != null && !isAbsent(n, 'cpu')) rows.push({ label: 'CPU', value: pct(n.cpu), tone: hot(n.cpu) })
  if (n.memory != null && !isAbsent(n, 'memory')) rows.push({ label: 'Memory', value: pct(n.memory), tone: hot(n.memory) })
  if (n.utilisation != null && !isAbsent(n, 'utilisation')) rows.push({ label: 'Capacity used', value: pct(n.utilisation), tone: hot(n.utilisation) })
  if (n.throttled != null && !isAbsent(n, 'throttled')) rows.push({ label: 'Throttled', value: throttleWho(n.tenants ?? [], n.throttleAmber) ?? pct(n.throttled, 1), tone: n.throttled >= n.throttleRed ? 'bad' : n.throttled >= n.throttleAmber && n.throttled > 0 ? 'warn' : '' })
  const provisioned = limitRange(n.tenants ?? [])
  if (provisioned) rows.push({ label: 'Provisioned', value: provisioned, tone: '' })
  if (n.queueDepth != null && !isAbsent(n, 'backlog')) rows.push({ label: 'Waiting', value: `${formatRate(n.queueDepth)} messages`, tone: '' })
  if (n.oldestMessageSeconds != null && !isAbsent(n, 'backlog')) rows.push({ label: 'Oldest message', value: formatAge(n.oldestMessageSeconds), tone: n.oldestMessageSeconds >= n.backlogRed ? 'bad' : n.oldestMessageSeconds >= n.backlogAmber ? 'warn' : '' })
  if (n.deadLetters != null && !isAbsent(n, 'deadLetters')) rows.push({ label: 'Dead letters', value: formatRate(n.deadLetters), tone: n.deadLetters > 0 ? 'bad' : '' })
  return rows
}

const JOB_TONE: Record<JobSnapshot['status'], Tone> = { Ok: '', Failed: 'bad', Overdue: 'warn' }

/** One row for each scheduled job of a function, in each region: how it stands, when it last ran and when it runs next. Nothing for a building without jobs. */
export function jobRows(n: Pick<NodeSnapshot, 'jobs'>, now: number = Date.now()): Row[] {
  return (n.jobs ?? []).map((j) => ({
    label: jobName(j),
    value: [j.status === 'Ok' ? 'ok' : j.status === 'Failed' ? 'failed' : 'overdue', j.lastRun ? `ran ${dayTime(j.lastRun, now)}` : null, j.next ? `next ${dayTime(j.next, now)}` : null].filter(Boolean).join(' · '),
    tone: JOB_TONE[j.status],
  }))
}

/** "sev 2, 3 open": the worst open incident of an island and how many there are. */
export function incidentSummary(incidents: readonly IncidentSnapshot[]): string {
  if (incidents.length === 0) return ''
  const worst = Math.min(...incidents.map((i) => i.severity))
  return `sev ${worst}, ${incidents.length} open`
}

export const SEVERITY_WORD: Record<number, string> = { 1: 'storm', 2: 'rain', 3: 'overcast', 4: 'light clouds' }

/**
 * "19:49" for a time today, "yesterday 00:00" or "tomorrow 00:00" a day either side, and "29 Oct 00:00" any other day, in the viewer's own time zone.
 * A daily job with only a time of day cannot be told from one that ran a week ago.
 */
export function dayTime(iso: string, now: number): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (v: number) => String(v).padStart(2, '0')
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`
  const midnight = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const days = Math.round((midnight(d) - midnight(new Date(now))) / 86_400_000)
  if (days === 0) return time
  if (days === -1) return `yesterday ${time}`
  if (days === 1) return `tomorrow ${time}`
  return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${time}`
}

/** "12:04:09" in the viewer's own time zone. */
export function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (v: number) => String(v).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** "4 s ago", "2 min ago". */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`
}

/** The four sections of the Logs tab, in the order they are shown, with the heading each has. */
export const LOG_SECTION_TITLE: Record<string, string> = {
  failed: '5xx requests',
  slow: 'Slow requests',
  logs: 'Warnings and errors',
  exceptions: 'Exceptions',
}

/** The heading of a section; the slow one says the line it is measured against. */
export function logSectionTitle(section: LogSection, slowOverMs: number): string {
  const title = LOG_SECTION_TITLE[section.id] ?? section.id
  return section.id === 'slow' ? `${title} (over ${formatMs(slowOverMs)})` : title
}

/** What an empty section says, so an empty list is never mistaken for a list that failed to load. */
export function logSectionEmpty(section: LogSection, window: string): string {
  const what = { failed: 'No 5xx requests', slow: 'No slow requests', logs: 'No warnings or errors', exceptions: 'No exceptions' }[section.id] ?? 'Nothing'
  return `${what} in the last ${window}.`
}

/** How many times an entry repeated, written as "×4"; nothing for one. */
export function repeatLabel(group: LogGroup): string {
  return group.count > 1 ? `×${group.count}` : ''
}

/** What a request group adds to its text: its status and how long the newest one took. */
export function groupDetail(group: LogGroup): string {
  return [group.result, group.durationMs != null ? formatMs(group.durationMs) : null].filter((x): x is string => !!x).join(' · ')
}

/** The links of an entry to its full trace that are safe to draw (only http and https). */
export function traceLinks(group: LogGroup): ResourceLink[] {
  return (group.links ?? []).filter((l) => l.name.length > 0 && isWebAddress(l.url))
}

export const LAYER_WORD: Record<SettingLayer, string> = {
  System: 'this system',
  Pillar: 'pillar defaults',
  App: 'defaults.yaml',
  BuiltIn: 'built in',
}

/** The settings with the ones the system sets itself first, since those are the ones someone chose. The order inside a layer is kept. */
export function configOrder(rows: readonly ConfigValue[]): ConfigValue[] {
  const rank: Record<SettingLayer, number> = { System: 0, Pillar: 1, App: 2, BuiltIn: 3 }
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank[a.r.layer] - rank[b.r.layer] || a.i - b.i).map((x) => x.r)
}

export interface LinkItem {
  /** The system to open on click; null for lines that are only words (a caller outside, a topic). */
  id: string | null
  name: string
  where: string
  /** Where a link between systems comes from: written in a registry file, or found in the telemetry (with the last day it was seen). Absent for lines that are not links. */
  origin?: LinkOrigin
}

export interface LinkOrigin {
  found: boolean
  /** yyyy-MM-dd of the last day the telemetry showed a found link; null for a declared one. */
  lastSeen: string | null
}

export interface LinkSection {
  id: string
  title: string
  items: LinkItem[]
}

const linkItem = (l: LinkRef): LinkItem => ({
  id: l.id,
  name: l.name,
  where: l.kind === 'Vendor' ? 'Third party' : l.islandName,
  origin: { found: l.found, lastSeen: l.lastSeen ?? null },
})

/** The words on a link's tag, and the hover text that says when it was last seen. */
export function originLabel(o: LinkOrigin): { text: string; title: string } {
  return o.found
    ? { text: 'Seen in calls', title: o.lastSeen ? `Found in the telemetry, last seen ${o.lastSeen}` : 'Found in the telemetry' }
    : { text: 'Declared', title: 'Written in a registry file' }
}

/** The Links tab: who this system calls and who calls it, through the gateway or not, and its messaging. Empty sections are left out. */
export function linkSections(d: SystemDetail): LinkSection[] {
  const sections: LinkSection[] = [
    { id: 'calls', title: 'Calls', items: d.calls.map(linkItem) },
    { id: 'calledBy', title: 'Called by', items: d.calledBy.map(linkItem) },
    { id: 'gatewayCalls', title: 'Calls through the gateway', items: d.gatewayCalls.map(linkItem) },
    { id: 'gatewayCalledBy', title: 'Called through the gateway by', items: d.gatewayCalledBy.map(linkItem) },
    { id: 'outside', title: 'Called from outside', items: d.outsideCallers.map((c) => ({ id: null, name: c, where: 'Outside caller' })) },
    { id: 'topics', title: 'Topics published', items: d.serviceTopics.map((t) => ({ id: null, name: t, where: 'Topic' })) },
    {
      id: 'subscriptions',
      title: 'Messages',
      items: d.subscriptions.map((s) => ({ id: null, name: `${s.topic}${s.legacy ? ' (legacy)' : ''}`, where: `${s.publisher} → ${s.consumer}` })),
    },
  ]
  return sections.filter((s) => s.items.length > 0)
}

export interface ScopeRow {
  key: string
  value: string
  /** How the value was found, in words. */
  note: string
}

export interface ScopeView {
  rows: ScopeRow[]
  resources: ScopeResource[]
  problems: string[]
  /** What the inventory is doing, when that matters; empty once it has been read. */
  status: string
}

const VIA: Record<string, string> = {
  explicit: 'named in the environment file',
  name: 'found by its name',
  tag: 'found by its tag',
  'telemetry.role': 'set on this system',
  'scope.telemetryRole': 'derived from the environment template',
}

const WORKSPACE_VIA: Record<string, string> = {
  id: 'its id is given, so nothing is looked up',
  name: 'found by its name',
}

const INVENTORY: Record<string, string> = {
  none: 'No inventory source is configured, so only what the rules say on their own is shown.',
  waiting: 'Waiting for the first read of the inventory.',
  failed: 'The last read of the inventory failed. What was read before is shown.',
  read: '',
}

/**
 * The "where it lives" part of the Config tab. Null when the environment has no scope rules at all (nothing is drawn); a value the rules do not give
 * is left out, not shown empty.
 */
export function scopeView(s: ScopeInfo | null | undefined): ScopeView | null {
  if (!s) return null
  const rows: ScopeRow[] = []
  if (s.subscription) rows.push({ key: 'subscription', value: s.subscription, note: VIA[s.subscriptionVia ?? ''] ?? '' })
  if (s.workspace) rows.push({ key: 'workspace', value: s.workspace, note: WORKSPACE_VIA[s.workspaceVia ?? ''] ?? 'from the environment' })
  if (s.serviceCode) rows.push({ key: 'service code', value: s.serviceCode, note: 'matched against resource names' })
  if (s.telemetryRole) rows.push({ key: 'telemetry role', value: s.telemetryRole, note: VIA[s.telemetryRoleVia ?? ''] ?? '' })
  if (s.instances != null) rows.push({ key: 'instances', value: String(s.instances), note: 'added up over the resources that are counted' })
  const resources = [...s.resources].sort((a, b) => a.name.localeCompare(b.name))
  return { rows, resources, problems: [...s.problems], status: INVENTORY[s.inventoryState] ?? '' }
}

/** Only http and https addresses become links, whatever the server sent. */
export function isWebAddress(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/** The links of one resource that are safe to draw. None when the environment has no link rules for it. */
export function resourceLinks(r: ScopeResource): ResourceLink[] {
  return (r.links ?? []).filter((l) => l.name.length > 0 && isWebAddress(l.url))
}

export interface OverviewLinks {
  /** One entry per link of a resource that does not belong to a tenant, in resource order. */
  items: { resource: string; link: ResourceLink }[]
  /** How many tenant resources have links; their links are on the Config tab, one row each. */
  tenantResources: number
  /** Links beyond the ones listed. */
  more: number
}

const OVERVIEW_LINK_LIMIT = 6

/** The "open in" part of the Overview tab. Null when no resource has a link, so a town without link rules shows nothing. */
export function overviewLinks(s: ScopeInfo | null | undefined): OverviewLinks | null {
  if (!s) return null
  const own = s.resources.filter((r) => !r.tenant).flatMap((r) => resourceLinks(r).map((link) => ({ resource: r.name, link })))
  const tenantResources = s.resources.filter((r) => r.tenant && resourceLinks(r).length > 0).length
  if (own.length === 0 && tenantResources === 0) return null
  return { items: own.slice(0, OVERVIEW_LINK_LIMIT), tenantResources, more: Math.max(0, own.length - OVERVIEW_LINK_LIMIT) }
}

/** What kind of outside place a vendor's building is, for the inspector and the lists: a third party, or one of the company's own services outside the monitored platform, with its island when it shares one. */
export function vendorWhere(v?: { internal: boolean; islandName?: string | null }): string {
  return (v?.internal ? 'Internal service' : 'Third party') + (v?.islandName ? `, ${v.islandName}` : '')
}
