// Snapshots come from outside the page, so they are checked before the scene sees them. A bad one is repaired where that is
// safe (a missing list becomes an empty one, a number that is not a number becomes 0) and dropped where it is not (a building
// with no id), and a snapshot with nothing usable in it is refused so the town keeps showing the last good one.

import { KNOWN_SIGNALS } from './signals'
import { DEFAULT_RING_CAPACITY, MAX_RING_CAPACITY, MIN_RING_CAPACITY, maxPillars } from './scene/layout'
import type { AssetSnapshot, DependencySnapshot, EnvironmentInfo, OffscreenLink, ViewInfo, ExternalCallerSnapshot, GroupSnapshot, IncidentSnapshot, MessagingSnapshot, NodeSnapshot, Snapshot, TenantInfo, TenantUnitSnapshot, VendorSnapshot } from './types'

const KINDS = ['Api', 'Worker', 'Database', 'Cache', 'Function', 'Gateway', 'Broker', 'Egress']
const STATES = ['Healthy', 'Degraded', 'Down', 'Stale']
const TENANT_KINDS = ['Customer', 'Test', 'Unknown']
const APP_STATES = ['Running', 'Stopped', 'Missing']
const JOB_STATUSES = ['Ok', 'Failed', 'Overdue']

/** Numbers every node has. Anything that is not a finite number reads as 0, and the system is shown grey unless the number only shapes the drawing. */
const REQUIRED_NUMBERS = [
  'instancesTotal', 'instancesHealthy', 'load', 'requestsPerSecond', 'errorRate', 'p99Ms', 'slaP99Ms',
  'errorAmber', 'errorRed', 'resourceAmber', 'resourceRed', 'throttleAmber', 'throttleRed', 'backlogAmber', 'backlogRed',
] as const

/** Numbers that only shape the drawing. When one is missing it reads 0; any other missing number turns the system grey (Stale), never a healthy-looking 0. */
const VISUAL_ONLY = new Set<string>(['load'])

/** The signal that, when a system's source says it has none, makes its number legitimately absent. */
const SIGNAL_OF: Record<string, string> = {
  instancesTotal: 'instances', instancesHealthy: 'instances', requestsPerSecond: 'requests', errorRate: 'errors', p99Ms: 'latency',
}

/** Numbers a source may leave out. Anything that is not a finite number becomes null. */
const OPTIONAL_NUMBERS = ['cpu', 'memory', 'utilisation', 'throttled', 'queueDepth', 'oldestMessageSeconds', 'deadLetters', 'outsideRequestsPerSecond'] as const

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
    const rawVendor = v as Record<string, unknown>
    vendors.push({
      node, calledBy: strings(rawVendor.calledBy),
      islandId: typeof rawVendor.islandId === 'string' ? rawVendor.islandId : null,
      islandName: typeof rawVendor.islandName === 'string' ? rawVendor.islandName : null,
      internal: rawVendor.internal === true,
      calls: Array.isArray(rawVendor.calls) ? strings(rawVendor.calls) : null,
    })
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
    trafficDensity: isFiniteNumber(raw.trafficDensity) && raw.trafficDensity > 0 ? raw.trafficDensity : 1,
    view: checkView(raw.view),
    generatedAt: str(raw.generatedAt),
    incidentFreeSince: typeof raw.incidentFreeSince === 'string' && Number.isFinite(Date.parse(raw.incidentFreeSince)) ? raw.incidentFreeSince : null,
    incidentsSeen: raw.incidentsSeen === true,
    outsideRequestsPerSecond: isFiniteNumber(raw.outsideRequestsPerSecond) ? raw.outsideRequestsPerSecond : null,
    // what the environment calls its cloud, for "not found in ..."; null says "the inventory"
    // what the town calls its own services outside the monitored platform (labels.internalVendors)
    internalVendorsLabel: str(raw.internalVendorsLabel).trim() || 'Internal services',
    wall: checkWall(raw.wall) as Snapshot['wall'], // null when the town sets none, as the server sends it
    cloud: typeof raw.cloud === 'string' && raw.cloud.trim() !== '' ? raw.cloud.trim() : null,
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
    notes: Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === 'string') : null,
    // how fresh each configured source is; one that cannot be read is left out
    sources: Array.isArray(raw.sources)
      ? raw.sources.filter(isObject).filter((x) => typeof x.name === 'string' && isFiniteNumber(x.intervalSeconds)).map((x) => ({ name: x.name as string, lastRead: typeof x.lastRead === 'string' ? x.lastRead : null, intervalSeconds: x.intervalSeconds as number, overdue: x.overdue === true }))
      : null,
    // the cloud's own health reports; one without an id, a resource or a state cannot be listed and is dropped
    healthEvents: Array.isArray(raw.healthEvents)
      ? raw.healthEvents.filter(isObject).filter((e) => typeof e.id === 'string' && e.id !== '' && typeof e.resource === 'string' && typeof e.state === 'string' && typeof e.since === 'string').map((e) => ({
        id: e.id as string, resource: e.resource as string, state: e.state as string, previous: str(e.previous) || null, cause: str(e.cause) || null, since: e.since as string,
        nodeId: str(e.nodeId) || null, groupId: str(e.groupId) || null, summary: str(e.summary) || null, resolvedAt: typeof e.resolvedAt === 'string' ? e.resolvedAt : null,
      }))
      : null,
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
      .map((h) => ({ id: h.id as string, displayName: str(h.displayName) || (h.id as string), vendor: h.vendor === true })),
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
    // a snapshot that does not say has no road to the ring except where a third party is reached (the town works that out)
    hasRingBridge: g.hasRingBridge === true,
    messaging: checkMessaging(g.messaging),
    nodes,
    assets: checkAssets(g.assets),
    flow: checkFlow(g.flow) as GroupSnapshot['flow'], // null, as the server writes it, when nothing measures the pillar
  }
}

/** What the pillar sends and receives. A rate that is not a finite number is not measured (null); no usable window or no object at all is no flow. */
function checkFlow(f: unknown): NonNullable<GroupSnapshot['flow']> | null {
  if (!isObject(f)) return null
  const rate = (v: unknown): number | null => (isFiniteNumber(v) && v >= 0 ? v : null)
  const sent = rate(f.sentPerSecond)
  const received = rate(f.receivedPerSecond)
  if (sent === null && received === null) return null
  return { sentPerSecond: sent, receivedPerSecond: received, windowSeconds: isFiniteNumber(f.windowSeconds) && f.windowSeconds > 0 ? Math.round(f.windowSeconds) : 0 }
}

const ASSET_SHAPES = ['box', 'vault', 'store', 'settings', 'observatory']

/** The island's resources that stand as basic buildings. One without an id or a name cannot be drawn or opened and is dropped; an unknown shape is a plain box. */
function checkAssets(list: unknown): AssetSnapshot[] {
  const ids = new Set<string>()
  const out: AssetSnapshot[] = []
  for (const a of Array.isArray(list) ? list : []) {
    if (!isObject(a) || typeof a.id !== 'string' || a.id === '' || ids.has(a.id) || typeof a.name !== 'string' || a.name === '') continue
    ids.add(a.id)
    out.push({
      id: a.id, name: a.name, label: str(a.label) || 'Resource', shape: ASSET_SHAPES.includes(a.shape as string) ? (a.shape as string) : 'box',
      service: typeof a.service === 'string' && a.service !== '' ? a.service : null, group: typeof a.group === 'string' && a.group !== '' ? a.group : null, region: typeof a.region === 'string' && a.region !== '' ? a.region : null,
      links: (Array.isArray(a.links) ? a.links : []).filter(isObject).filter((l) => typeof l.name === 'string' && typeof l.url === 'string' && /^https?:\/\//i.test(l.url as string))
        .map((l) => ({ name: l.name as string, url: l.url as string })),
    })
  }
  return out
}

function checkMessaging(m: unknown): MessagingSnapshot {
  const raw = isObject(m) ? m : {}
  return {
    topics: (Array.isArray(raw.topics) ? raw.topics : []).filter(isObject).filter((t) => typeof t.name === 'string' && t.name !== '')
      .map((t) => ({ name: t.name as string, service: typeof t.service === 'string' ? t.service : null })), // null: the topic belongs to the island as a whole
    subscriptions: (Array.isArray(raw.subscriptions) ? raw.subscriptions : []).filter(isObject)
      .filter((x) => typeof x.topic === 'string' && typeof x.consumer === 'string' && x.consumer !== '')
      .map((x) => ({ topic: x.topic as string, publisher: str(x.publisher), consumer: x.consumer as string, legacy: x.legacy === true })),
    schedules: (Array.isArray(raw.schedules) ? raw.schedules : []).filter(isObject)
      .filter((x) => typeof x.system === 'string' && x.system !== '' && typeof x.job === 'string' && x.job !== '')
      .map((x) => ({ system: x.system as string, job: x.job as string, services: (Array.isArray(x.services) ? x.services : []).filter((v): v is string => typeof v === 'string' && v !== '') })),
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
    // an older server that does not say has every signal present
    absent: strings(n.absent).filter((s) => (KNOWN_SIGNALS as readonly string[]).includes(s)),
    // an older server that does not say has no quiet system
    quiet: n.quiet === true,
    // which sources feed the system and how old each one's last answer is, only when one is late; an entry without a name cannot be shown
    sources: Array.isArray(n.sources)
      ? n.sources.filter(isObject).filter((s) => typeof s.source === 'string' && s.source !== '')
        .map((s) => ({ source: s.source as string, ageSeconds: isFiniteNumber(s.ageSeconds) && s.ageSeconds >= 0 ? s.ageSeconds : 0, fresh: s.fresh === true, signals: strings(s.signals) }))
      : null,
  }
  let unreadable = false
  for (const key of REQUIRED_NUMBERS) {
    out[key] = isFiniteNumber(n[key]) ? n[key] : 0
    if (!isFiniteNumber(n[key])) {
      problems.push(`'${n.id}' has no usable ${key}`)
      // a missing number that decides the colour must not read as 0 (zero errors, healthy): the building goes grey. A source that says it has no such signal is not "missing"
      if (!VISUAL_ONLY.has(key) && !(out.absent as string[]).includes(SIGNAL_OF[key] ?? '')) unreadable = true
    }
  }
  if (unreadable && out.state !== 'Stale') {
    out.state = 'Stale'
    problems.push(`'${n.id}' is missing a number its colour depends on, shown as Stale`)
  }
  for (const key of OPTIONAL_NUMBERS) out[key] = isFiniteNumber(n[key]) ? n[key] : null
  // null is traffic that is not measured; a list, even an empty one, is an API whose callers the town knows
  out.inbound = Array.isArray(n.inbound)
    ? n.inbound.filter(isObject).filter((l) => typeof l.from === 'string' && l.from !== '').map((l) => ({ from: l.from as string, requestsPerSecond: isFiniteNumber(l.requestsPerSecond) && l.requestsPerSecond >= 0 ? l.requestsPerSecond : 0 }))
    : null
  out.inboundEstimated = n.inboundEstimated === true
  // why the state is not healthy, in words; the backend leaves it out for a healthy system
  out.reason = typeof n.reason === 'string' && n.reason !== '' ? n.reason : null
  // what a database runs on; an older server, or a database that names none, has null, and a half-filled one cannot be shown
  out.engine = isObject(n.engine) && ['id', 'name', 'type', 'typeName'].every((k) => typeof (n.engine as Record<string, unknown>)[k] === 'string' && (n.engine as Record<string, unknown>)[k] !== '')
    ? { id: n.engine.id, name: n.engine.name, type: n.engine.type, typeName: n.engine.typeName }
    : null
  // null: nothing says whether the app runs; a job or region list is only there for a function or a service in two regions
  out.app = APP_STATES.includes(n.app as string) ? n.app : null
  const optionalNumber = (v: unknown) => (isFiniteNumber(v) ? v : null)
  const optionalText = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
  out.jobs = Array.isArray(n.jobs)
    ? n.jobs.filter(isObject).filter((j) => typeof j.name === 'string' && j.name !== '')
      .map((j) => ({ name: j.name as string, region: optionalText(j.region), status: JOB_STATUSES.includes(j.status as string) ? j.status : 'Ok', lastRun: optionalText(j.lastRun), next: optionalText(j.next) }))
    : null
  // the queues a consumer reads: one without a name cannot be shown; a link must be a web address, or it is dropped
  out.queues = Array.isArray(n.queues)
    ? n.queues.filter(isObject).filter((q) => typeof q.name === 'string' && q.name !== '')
      .map((q) => ({
        name: q.name as string, backlog: optionalNumber(q.backlog), deadLetters: optionalNumber(q.deadLetters), perSecond: optionalNumber(q.perSecond),
        link: isObject(q.link) && typeof q.link.name === 'string' && q.link.name !== '' && typeof q.link.url === 'string' && /^https?:\/\//i.test(q.link.url) ? { name: q.link.name, url: q.link.url } : null,
        // the kinds of message it handled: null when nothing measures them; one without a name or a rate cannot be shown
        types: Array.isArray(q.types)
          ? q.types.filter(isObject).filter((t) => typeof t.type === 'string' && t.type !== '' && isFiniteNumber(t.perSecond) && t.perSecond >= 0).map((t) => ({ type: t.type as string, perSecond: t.perSecond as number }))
          : null,
        typesCut: isFiniteNumber(q.typesCut) && q.typesCut > 0 ? Math.round(q.typesCut) : 0,
        // where the dead letters are, when the broker spans regions: one without a region or a count cannot be shown; a link must be a web address
        deadLetterRegions: Array.isArray(q.deadLetterRegions)
          ? q.deadLetterRegions.filter(isObject).filter((r) => typeof r.region === 'string' && r.region !== '' && isFiniteNumber(r.count) && r.count > 0)
            .map((r) => ({ region: r.region as string, label: optionalText(r.label) ?? (r.region as string), count: r.count as number, link: isObject(r.link) && typeof r.link.name === 'string' && r.link.name !== '' && typeof r.link.url === 'string' && /^https?:\/\//i.test(r.link.url) ? { name: r.link.name, url: r.link.url } : null }))
          : null,
      }))
    : null
  out.regions = Array.isArray(n.regions)
    ? n.regions.filter(isObject).filter((r) => typeof r.region === 'string' && r.region !== '')
      .map((r) => ({ region: r.region as string, label: optionalText(r.label) ?? (r.region as string), instances: optionalNumber(r.instances), cpu: optionalNumber(r.cpu), memory: optionalNumber(r.memory), share: isFiniteNumber(r.share) && r.share >= 0 && r.share <= 1 ? r.share : null, skewed: r.skewed === true }))
    : null
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
      limit: isFiniteNumber(u.limit) && u.limit > 0 ? u.limit : null,
      ...(u.idle === true ? { idle: true } : {}),
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
      notFound: t.notFound === true,
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

/** The town's wall defaults (town.yaml wall): only what is a usable value; nothing usable is no defaults at all. */
function checkWall(raw: unknown): { holdSeconds?: number; overviewSeconds?: number; overviewIslandSeconds?: number; light?: 'dusk' | 'day' } | null {
  if (!isObject(raw)) return null
  const wall: { holdSeconds?: number; overviewSeconds?: number; overviewIslandSeconds?: number; light?: 'dusk' | 'day' } = {}
  if (isFiniteNumber(raw.holdSeconds) && raw.holdSeconds >= 0.5) wall.holdSeconds = raw.holdSeconds
  if (isFiniteNumber(raw.overviewSeconds) && raw.overviewSeconds >= 0) wall.overviewSeconds = raw.overviewSeconds
  if (isFiniteNumber(raw.overviewIslandSeconds) && raw.overviewIslandSeconds >= 0) wall.overviewIslandSeconds = raw.overviewIslandSeconds
  if (raw.light === 'dusk' || raw.light === 'day') wall.light = raw.light
  return Object.keys(wall).length > 0 ? wall : null
}
