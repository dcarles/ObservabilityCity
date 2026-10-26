// Snapshots come from outside the page, so they are checked before the scene sees them. A bad one is repaired where that is
// safe (a missing list becomes an empty one, a number that is not a number becomes 0) and dropped where it is not (a building
// with no id), and a snapshot with nothing usable in it is refused so the town keeps showing the last good one.

import { DEFAULT_RING_CAPACITY, MAX_RING_CAPACITY, MIN_RING_CAPACITY, maxPillars } from './scene/layout'
import type { DependencySnapshot, EnvironmentInfo, OffscreenLink, ViewInfo, ExternalCallerSnapshot, GroupSnapshot, IncidentSnapshot, MessagingSnapshot, NodeSnapshot, Snapshot, TenantInfo, TenantUnitSnapshot, VendorSnapshot } from './types'

const KINDS = ['Api', 'Worker', 'Database', 'Cache', 'Cron', 'Gateway', 'Broker', 'Egress']
const STATES = ['Healthy', 'Degraded', 'Down', 'Stale']
const TENANT_KINDS = ['Customer', 'Test', 'Unknown']

/** Numbers every node has. Anything that is not a finite number becomes 0. */
const REQUIRED_NUMBERS = [
  'instancesTotal', 'instancesHealthy', 'load', 'requestsPerSecond', 'errorRate', 'p99Ms', 'slaP99Ms',
  'errorAmber', 'errorRed', 'resourceAmber', 'resourceRed', 'throttleAmber', 'throttleRed', 'backlogAmber', 'backlogRed',
] as const

/** Numbers a source may leave out. Anything that is not a finite number becomes null. */
const OPTIONAL_NUMBERS = ['cpu', 'memory', 'utilisation', 'throttled', 'queueDepth', 'oldestMessageSeconds', 'deadLetters'] as const

export interface Checked {
  /** The repaired snapshot, or null when nothing in it can be drawn. */
  snapshot: Snapshot | null
  /** What was repaired or dropped, for the console. Empty for a clean snapshot. */
  problems: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function checkSnapshot(raw: unknown): Checked {
  const problems: string[] = []
  if (!isObject(raw)) return { snapshot: null, problems: ['the snapshot is not an object'] }
  if (!Array.isArray(raw.groups)) return { snapshot: null, problems: ['the snapshot has no groups list'] }

  const groups: GroupSnapshot[] = []
  const seen = new Set<string>()
  for (const g of raw.groups) {
    const group = checkGroup(g, seen, problems)
    if (group) groups.push(group)
  }
  if (groups.every((g) => g.nodes.length === 0)) return { snapshot: null, problems: [...problems, 'no system in the snapshot can be drawn'] }

  // the layout needs a ring capacity it can use and a town that fits on two rings of it
  const declared = raw.ringCapacity
  const ringCapacity = Number.isInteger(declared) && (declared as number) >= MIN_RING_CAPACITY && (declared as number) <= MAX_RING_CAPACITY ? (declared as number) : DEFAULT_RING_CAPACITY
  if (declared !== undefined && ringCapacity !== declared) problems.push(`ringCapacity ${String(declared)} is outside ${MIN_RING_CAPACITY} to ${MAX_RING_CAPACITY}; using ${ringCapacity}`)
  const pillarCount = groups.filter((g) => !g.isHub).length
  if (pillarCount > maxPillars(ringCapacity)) return { snapshot: null, problems: [...problems, `${pillarCount} pillars do not fit on two rings of ${ringCapacity} (at most ${maxPillars(ringCapacity)})`] }

  const totals = isObject(raw.totals) ? raw.totals : {}
  const num = (v: unknown) => (isFiniteNumber(v) ? v : 0)
  const groupIds = new Set(groups.map((g) => g.id))
  const vendors: VendorSnapshot[] = []
  const vendorIds = new Set<string>()
  for (const v of Array.isArray(raw.vendors) ? raw.vendors : []) {
    const node = isObject(v) ? checkNode(v.node, 'third parties', vendorIds, problems) : null
    if (!node) { problems.push('dropped a third party that cannot be drawn'); continue }
    vendors.push({ node, calledBy: strings((v as Record<string, unknown>).calledBy) })
  }
  const snapshot: Snapshot = {
    townId: str(raw.townId),
    ringCapacity,
    townName: str(raw.townName) || str(raw.townId),
    groupLabel: str(raw.groupLabel) || 'Group',
    environment: str(raw.environment),
    environmentName: str(raw.environmentName) || str(raw.environment),
    environments: (Array.isArray(raw.environments) ? raw.environments : []).filter(isObject).filter((e) => typeof e.id === 'string' && e.id !== '')
      .map<EnvironmentInfo>((e) => ({ id: e.id as string, name: str(e.name) || (e.id as string), isDefault: e.isDefault === true })),
    tenants: checkTenants(raw.tenants, problems),
    topology: str(raw.topology) || 'direct',
    mode: raw.mode === 'demo' ? 'demo' : 'live',
    view: checkView(raw.view),
    generatedAt: str(raw.generatedAt),
    dayFraction: isFiniteNumber(raw.dayFraction) ? raw.dayFraction : 0.5,
    totals: {
      requestsPerSecond: num(totals.requestsPerSecond),
      errorRate: num(totals.errorRate),
      p99Ms: num(totals.p99Ms),
      degraded: num(totals.degraded),
      down: num(totals.down),
      incidents: num(totals.incidents),
      deadLetters: num(totals.deadLetters),
    },
    notices: Array.isArray(raw.notices) ? raw.notices.filter((n): n is string => typeof n === 'string') : [],
    groups,
    vendors,
    externalCallers: (Array.isArray(raw.externalCallers) ? raw.externalCallers : []).filter(isObject).filter((c) => typeof c.id === 'string' && c.id !== '').map<ExternalCallerSnapshot>((c) => ({
      id: c.id as string, name: str(c.name) || (c.id as string), requestsPerSecond: num(c.requestsPerSecond), calls: strings(c.calls),
    })),
    // a link to a group or vendor that is not in the snapshot cannot be drawn
    dependencies: (Array.isArray(raw.dependencies) ? raw.dependencies : []).filter(isObject)
      .filter((d) => typeof d.from === 'string' && typeof d.to === 'string' && groupIds.has(d.from) && (groupIds.has(d.to) || vendorIds.has(d.to)) && d.from !== d.to)
      .map<DependencySnapshot>((d) => ({ from: d.from as string, to: d.to as string, requestsPerSecond: num(d.requestsPerSecond) })),
  }
  return { snapshot, problems }
}

/** Which islands the snapshot shows. A snapshot that does not say shows the whole town. */
function checkView(v: unknown): ViewInfo {
  const raw = isObject(v) ? v : {}
  return {
    islands: strings(raw.islands),
    unknown: strings(raw.unknown),
    hidden: (Array.isArray(raw.hidden) ? raw.hidden : []).filter(isObject).filter((h) => typeof h.id === 'string' && h.id !== '')
      .map((h) => ({ id: h.id as string, displayName: str(h.displayName) || (h.id as string) })),
    links: (Array.isArray(raw.links) ? raw.links : []).filter(isObject)
      .filter((l) => typeof l.nodeId === 'string' && l.nodeId !== '' && typeof l.islandId === 'string' && l.islandId !== '')
      .map<OffscreenLink>((l) => ({
        nodeId: l.nodeId as string, islandId: l.islandId as string, islandName: str(l.islandName) || (l.islandId as string),
        incoming: l.incoming === true, requestsPerSecond: isFiniteNumber(l.requestsPerSecond) ? l.requestsPerSecond : 0,
      })),
  }
}

function checkGroup(g: unknown, seen: Set<string>, problems: string[]): GroupSnapshot | null {
  if (!isObject(g) || typeof g.id !== 'string' || g.id === '') {
    problems.push('dropped a group with no id')
    return null
  }
  if (seen.has(g.id)) {
    problems.push(`dropped a second group with the id '${g.id}'`)
    return null
  }
  seen.add(g.id)
  const nodes: NodeSnapshot[] = []
  const ids = new Set<string>()
  if (!Array.isArray(g.nodes)) problems.push(`group '${g.id}' has no nodes list`)
  for (const n of Array.isArray(g.nodes) ? g.nodes : []) {
    const node = checkNode(n, g.id, ids, problems)
    if (node) nodes.push(node)
  }
  return {
    id: g.id,
    displayName: str(g.displayName) || g.id,
    color: typeof g.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(g.color) ? g.color : '#8ab4ff',
    isHub: g.isHub === true,
    isLostFound: g.isLostFound === true,
    configError: typeof g.configError === 'string' && g.configError !== '' ? g.configError : null,
    incidents: (Array.isArray(g.incidents) ? g.incidents : []).filter(isObject).map<IncidentSnapshot>((i, k) => ({
      id: str(i.id) || `${g.id}-${k}`,
      title: str(i.title) || 'Incident',
      // 1 is the worst; anything else becomes the mildest, so a bad value never hides an incident
      severity: isFiniteNumber(i.severity) && i.severity >= 1 && i.severity <= 4 ? Math.round(i.severity) : 4,
      startedAt: str(i.startedAt),
    })).sort((a, b) => a.severity - b.severity),
    // a snapshot that does not say keeps the bridge it always had; one with no messaging block has no pier
    hasBridge: g.hasBridge !== false,
    messaging: checkMessaging(g.messaging),
    nodes,
  }
}

function checkMessaging(m: unknown): MessagingSnapshot {
  const raw = isObject(m) ? m : {}
  return {
    topics: (Array.isArray(raw.topics) ? raw.topics : []).filter(isObject).filter((t) => typeof t.name === 'string' && t.name !== '')
      .map((t) => ({ name: t.name as string, service: str(t.service) })),
    subscriptions: (Array.isArray(raw.subscriptions) ? raw.subscriptions : []).filter(isObject)
      .filter((x) => typeof x.topic === 'string' && typeof x.consumer === 'string' && x.consumer !== '')
      .map((x) => ({ topic: x.topic as string, publisher: str(x.publisher), consumer: x.consumer as string, legacy: x.legacy === true })),
  }
}

function checkNode(n: unknown, groupId: string, ids: Set<string>, problems: string[]): NodeSnapshot | null {
  if (!isObject(n) || typeof n.id !== 'string' || n.id === '') {
    problems.push(`dropped a system with no id in '${groupId}'`)
    return null
  }
  if (ids.has(n.id)) {
    problems.push(`dropped a second system with the id '${n.id}'`)
    return null
  }
  if (!KINDS.includes(n.kind as string)) {
    problems.push(`dropped '${n.id}': unknown kind '${String(n.kind)}'`)
    return null
  }
  ids.add(n.id)
  // An unknown state is shown as stale, which is grey and never green.
  const state = STATES.includes(n.state as string) ? (n.state as NodeSnapshot['state']) : 'Stale'
  if (state !== n.state) problems.push(`'${n.id}' has unknown state '${String(n.state)}', shown as Stale`)

  const out: Record<string, unknown> = {
    id: n.id,
    name: str(n.name) || n.id,
    kind: n.kind,
    service: typeof n.service === 'string' ? n.service : null,
    external: n.external === true,
    state,
    calls: strings(n.calls),
    gatewayCalls: strings(n.gatewayCalls),
    lastUpdated: typeof n.lastUpdated === 'string' ? n.lastUpdated : null,
  }
  for (const key of REQUIRED_NUMBERS) {
    out[key] = isFiniteNumber(n[key]) ? n[key] : 0
    if (!isFiniteNumber(n[key])) problems.push(`'${n.id}' has no usable ${key}`)
  }
  for (const key of OPTIONAL_NUMBERS) out[key] = isFiniteNumber(n[key]) ? n[key] : null
  // null is a store without tenants; a list, even an empty one, is a store with a database for each tenant
  out.tenants = Array.isArray(n.tenants) ? checkUnits(n.tenants, n.id, problems) : null
  return out as unknown as NodeSnapshot
}

function checkUnits(list: unknown[], nodeId: string, problems: string[]): TenantUnitSnapshot[] {
  const ids = new Set<string>()
  const out: TenantUnitSnapshot[] = []
  for (const u of list) {
    if (!isObject(u) || typeof u.id !== 'string' || u.id === '' || ids.has(u.id)) {
      problems.push(`dropped a tenant with no usable id in '${nodeId}'`)
      continue
    }
    ids.add(u.id)
    out.push({
      id: u.id,
      name: str(u.name) || u.id,
      kind: TENANT_KINDS.includes(u.kind as string) ? (u.kind as TenantUnitSnapshot['kind']) : 'Unknown',
      database: str(u.database),
      // an unknown state is shown as grey, never as healthy
      state: STATES.includes(u.state as string) ? (u.state as TenantUnitSnapshot['state']) : 'Stale',
      utilisation: isFiniteNumber(u.utilisation) ? u.utilisation : null,
      throttled: isFiniteNumber(u.throttled) ? u.throttled : null,
      requestsPerSecond: isFiniteNumber(u.requestsPerSecond) ? u.requestsPerSecond : 0,
    })
  }
  return out
}

function checkTenants(list: unknown, problems: string[]): TenantInfo[] {
  const ids = new Set<string>()
  const out: TenantInfo[] = []
  for (const t of Array.isArray(list) ? list : []) {
    if (!isObject(t) || typeof t.id !== 'string' || t.id === '' || ids.has(t.id)) {
      problems.push('dropped a tenant with no usable id')
      continue
    }
    ids.add(t.id)
    out.push({
      id: t.id,
      name: str(t.name) || t.id,
      kind: TENANT_KINDS.includes(t.kind as string) ? (t.kind as TenantInfo['kind']) : 'Unknown',
      share: isFiniteNumber(t.share) && t.share >= 0 ? t.share : 0,
    })
  }
  return out
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : []
}
