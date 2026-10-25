// Snapshots come from outside the page, so they are checked before the scene sees them. A bad one is repaired where that is
// safe (a missing list becomes an empty one, a number that is not a number becomes 0) and dropped where it is not (a building
// with no id), and a snapshot with nothing usable in it is refused so the town keeps showing the last good one.

import type { GroupSnapshot, NodeSnapshot, Snapshot } from './types'

const KINDS = ['Api', 'Worker', 'Database', 'Cache', 'Cron', 'Gateway', 'Broker', 'Egress']
const STATES = ['Healthy', 'Degraded', 'Down', 'Stale']

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

  const totals = isObject(raw.totals) ? raw.totals : {}
  const num = (v: unknown) => (isFiniteNumber(v) ? v : 0)
  const snapshot: Snapshot = {
    townId: str(raw.townId),
    townName: str(raw.townName) || str(raw.townId),
    groupLabel: str(raw.groupLabel) || 'Group',
    environment: str(raw.environment),
    generatedAt: str(raw.generatedAt),
    dayFraction: isFiniteNumber(raw.dayFraction) ? raw.dayFraction : 0.5,
    totals: {
      requestsPerSecond: num(totals.requestsPerSecond),
      errorRate: num(totals.errorRate),
      p99Ms: num(totals.p99Ms),
      degraded: num(totals.degraded),
      down: num(totals.down),
    },
    notices: Array.isArray(raw.notices) ? raw.notices.filter((n): n is string => typeof n === 'string') : [],
    groups,
  }
  return { snapshot, problems }
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
    nodes,
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
    calls: Array.isArray(n.calls) ? n.calls.filter((c): c is string => typeof c === 'string') : [],
    lastUpdated: typeof n.lastUpdated === 'string' ? n.lastUpdated : null,
  }
  for (const key of REQUIRED_NUMBERS) {
    out[key] = isFiniteNumber(n[key]) ? n[key] : 0
    if (!isFiniteNumber(n[key])) problems.push(`'${n.id}' has no usable ${key}`)
  }
  for (const key of OPTIONAL_NUMBERS) out[key] = isFiniteNumber(n[key]) ? n[key] : null
  return out as unknown as NodeSnapshot
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
