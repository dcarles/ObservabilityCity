// What the inspector drawer says, as pure functions: a system's numbers in, rows and sentences out.

import type { ConfigValue, HealthState, IncidentSnapshot, LinkRef, LogLine, NodeSnapshot, SettingLayer, SystemDetail } from './types'
import { isAbsent, isUnmonitored } from './signals'
import { formatAge, formatMs, formatRate, plaqueText, resourceUse } from './visuals'

export type Tone = 'ok' | 'warn' | 'bad' | 'stale' | ''

export const stateTone = (s: HealthState): Tone => (s === 'Healthy' ? 'ok' : s === 'Degraded' ? 'warn' : s === 'Down' ? 'bad' : 'stale')

const pct = (v: number, digits = 0): string => `${(v * 100).toFixed(digits)}%`

/** In words, why the system is not healthy. Empty for a healthy one. Each line names the number and the line it crossed. */
export function reasons(n: NodeSnapshot): string[] {
  if (isUnmonitored(n)) return []
  if (n.state === 'Stale') return ['No fresh data: the last reading is too old to trust, so nothing here is shown as healthy.']
  if (n.state === 'Down') return ['Down: the system is not answering.']
  const out: string[] = []
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
export function overviewRows(n: NodeSnapshot): Row[] {
  if (isUnmonitored(n)) return [{ label: 'Data', value: 'no source configured', tone: '' }]
  if (n.state === 'Stale') return [{ label: 'Data', value: 'none fresh', tone: 'stale' }]
  const rows: Row[] = []
  if (!isAbsent(n, 'instances')) rows.push({ label: 'Instances', value: plaqueText(n), tone: n.instancesHealthy < n.instancesTotal ? 'warn' : '' })
  if (!isAbsent(n, 'requests')) rows.push({ label: 'Requests', value: `${formatRate(n.requestsPerSecond)}/s`, tone: '' })
  if (!isAbsent(n, 'errors')) rows.push({ label: 'Errors', value: pct(n.errorRate, 2), tone: n.errorRate >= n.errorRed ? 'bad' : n.errorRate >= n.errorAmber ? 'warn' : '' })
  if (!isAbsent(n, 'latency')) rows.push({ label: 'p99 / SLA', value: `${formatMs(n.p99Ms)} / ${formatMs(n.slaP99Ms)}`, tone: n.p99Ms > n.slaP99Ms ? 'warn' : '' })
  if (!isAbsent(n, 'requests') && !isAbsent(n, 'instances')) rows.push({ label: 'Load', value: pct(n.load), tone: '' })
  const hot = (v: number) => (v >= n.resourceRed ? 'bad' : v >= n.resourceAmber ? 'warn' : '') as Tone
  if (n.cpu != null && !isAbsent(n, 'cpu')) rows.push({ label: 'CPU', value: pct(n.cpu), tone: hot(n.cpu) })
  if (n.memory != null && !isAbsent(n, 'memory')) rows.push({ label: 'Memory', value: pct(n.memory), tone: hot(n.memory) })
  if (n.utilisation != null && !isAbsent(n, 'utilisation')) rows.push({ label: 'Capacity used', value: pct(n.utilisation), tone: hot(n.utilisation) })
  if (n.throttled != null && !isAbsent(n, 'throttled')) rows.push({ label: 'Throttled', value: pct(n.throttled, 1), tone: n.throttled >= n.throttleRed ? 'bad' : n.throttled >= n.throttleAmber && n.throttled > 0 ? 'warn' : '' })
  if (n.queueDepth != null && !isAbsent(n, 'backlog')) rows.push({ label: 'Waiting', value: `${formatRate(n.queueDepth)} messages`, tone: '' })
  if (n.oldestMessageSeconds != null && !isAbsent(n, 'backlog')) rows.push({ label: 'Oldest message', value: formatAge(n.oldestMessageSeconds), tone: n.oldestMessageSeconds >= n.backlogRed ? 'bad' : n.oldestMessageSeconds >= n.backlogAmber ? 'warn' : '' })
  if (n.deadLetters != null && !isAbsent(n, 'deadLetters')) rows.push({ label: 'Dead letters', value: formatRate(n.deadLetters), tone: n.deadLetters > 0 ? 'bad' : '' })
  return rows
}

/** "sev 2, 3 open": the worst open incident of an island and how many there are. */
export function incidentSummary(incidents: readonly IncidentSnapshot[]): string {
  if (incidents.length === 0) return ''
  const worst = Math.min(...incidents.map((i) => i.severity))
  return `sev ${worst}, ${incidents.length} open`
}

export const SEVERITY_WORD: Record<number, string> = { 1: 'storm', 2: 'rain', 3: 'overcast', 4: 'light clouds' }

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

export type LogFilter = 'all' | 'warn' | 'error'

/** Lines at or above a level: all, warnings and errors, errors only. */
export function filterLogs(lines: readonly LogLine[], filter: LogFilter): LogLine[] {
  if (filter === 'all') return [...lines]
  return lines.filter((l) => (filter === 'error' ? l.level === 'Error' : l.level !== 'Info'))
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
}

export interface LinkSection {
  id: string
  title: string
  items: LinkItem[]
}

const linkItem = (l: LinkRef): LinkItem => ({ id: l.id, name: l.name, where: l.kind === 'Vendor' ? 'Third party' : l.islandName })

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
