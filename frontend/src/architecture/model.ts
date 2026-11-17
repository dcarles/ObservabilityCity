// What the architecture diagram shows at its first level, worked out from the dashboard's model as plain data: one box for each pillar, each third party, each
// internal service outside the platform and each shared (hub) system, and a line for every call between two boxes. Nothing here draws or places anything
// (layout.ts does that), so every rule is unit tested. The numbers are the snapshot's own; a signal nobody measures is null, never a zero.

import { buildDashboard, worstOf, type Dashboard, type Level, type SideRow } from '../dashboard/model'
import { countsText } from '../dashboard/render'
import { dlqCount } from '../deadLetters'
import type { TenantView } from '../tenants'
import type { NodeSnapshot, Snapshot } from '../types'

export type BoxKind = 'pillar' | 'vendor' | 'internal' | 'shared' | 'service'

export interface ArchBox {
  id: string
  kind: BoxKind
  name: string
  /** Worst state of the monitored systems inside; grey when none is monitored. */
  level: Level
  /** The pillar's own colour (a stripe on its box); null for the others. */
  color: string | null
  /** The line under the name: "5 services", "vendor", "gateway". */
  sub: string
  /** What is wrong, in words ("1 down · 2 degraded"); null when nothing is. */
  reason: string | null
  /** A short measured figure for a box with no flow chips ("820 rps"); null when nothing measures it. */
  figure: string | null
  /** Messages a second sent and received, requests a second sent and received (to and from other pillars); null where nothing measures it. */
  msg: { out: number | null; in: number | null } | null
  traffic: { out: number | null; in: number | null } | null
  dlq: number
  /** The system to open in the drawer when the box is one system; null for a box of many. */
  nodeId: string | null
  /** A box of another pillar, standing closed beside the one that is open; tap it, then Open, to go there. */
  closed?: boolean
  /** Portal links of a box that is only links (Log Analytics, App Insights): nothing is measured, so it is grey and has no drawer. Empty for every other box. */
  links: { name: string; url: string }[]
}

export interface ArchEdge {
  from: string
  to: string
  /** Requests a second over the link, summed; null when none of the calls is measured. */
  rps: number | null
  /** Amber or red when either end is, else green; grey only when both ends have no data. */
  level: Level
  /** The calling pillar's colour (else the called one's); null when neither end is a pillar. */
  color: string | null
}

export interface ArchTotals {
  down: number
  degraded: number
  deadLetters: number | null
  traffic: number | null
  messages: number | null
}

export interface Architecture {
  townName: string
  groupLabel: string
  totals: ArchTotals
  boxes: ArchBox[]
  edges: ArchEdge[]
  /** The name of the frame the third parties sit in. */
  vendorsLabel: string
  /** The words the viewer's town uses for what is outside the platform. */
  internalLabel: string
  /** The dashboard model the numbers came from, for the Pillars menu and the drawer. */
  dashboard: Dashboard
  /** The pillar opened (its service groups are the boxes marked `service`; every other box is closed); null at the first level. */
  open: { id: string; name: string } | null
}

const TYPE: Record<string, string> = { Api: 'API', Worker: 'Worker', Database: 'Database', Cache: 'Cache', Function: 'Function', Gateway: 'Gateway', Broker: 'Broker', Egress: 'Egress' }
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const num = (v: number): string => v.toLocaleString('en-GB', { maximumFractionDigits: v < 10 ? 1 : 0 })

/** An edge is amber or red as soon as one end is; green when both are fine; grey when neither end has data. */
export function edgeLevel(a: Level, b: Level): Level {
  return worstOf([a, b])
}

const reasonOf = (down: number, degraded: number, level: Level): string | null =>
  down + degraded > 0 ? countsText(down, degraded) : level === 'none' ? 'no fresh data' : null

/** The numbers of a box that stands for one or more systems on a third party's or an internal service's island. */
function figureOf(rows: readonly SideRow[]): string | null {
  const details = rows.map((r) => r.detail).filter(Boolean)
  return rows.length === 1 && details[0] ? details[0].split(' · ')[0] : null
}

/**
 * The first level of the diagram for the tenants the viewer chose. Shared systems get a box each in their own frame but no lines (the hub is a service
 * layer every pillar uses, and drawing it would bury the pillars' own links). Third parties that share an island are one box.
 */
export function buildArchitecture(s: Snapshot, view: TenantView, dashboard?: Dashboard): Architecture {
  const d = dashboard ?? buildDashboard(s, view)
  const boxes: ArchBox[] = []
  const boxOf = new Map<string, string>()
  const hub = s.groups.find((g) => g.isHub)
  const nodeById = new Map<string, NodeSnapshot>([...s.groups.flatMap((g) => g.nodes), ...s.vendors.map((v) => v.node)].map((n) => [n.id, n]))

  for (const p of d.pillars) {
    const group = s.groups.find((g) => g.id === p.id)
    for (const g of p.groups) for (const r of g.rows) boxOf.set(r.id, p.id)
    boxes.push({
      id: p.id, kind: 'pillar', name: p.name, level: p.level, color: group?.color ?? null,
      sub: p.configError ? 'config error' : plural(p.groups.length, 'service'),
      reason: p.configError ?? reasonOf(p.down, p.degraded, p.level),
      figure: p.traffic > 0 ? `${num(p.traffic)} rps` : null,
      msg: p.flow && (p.flow.sent != null || p.flow.received != null) ? { out: p.flow.sent, in: p.flow.received } : null,
      traffic: p.trafficSplit ? { out: p.trafficSplit.out, in: p.trafficSplit.in } : null,
      dlq: p.dlq, nodeId: null, links: [],
    })
  }

  const side = new Map(d.sections.flatMap((x) => x.rows).filter((r) => r.id).map((r) => [r.id!, r]))
  for (const r of d.sections.find((x) => x.id === 'hub')?.rows ?? []) {
    if (!r.id || !r.drawer) continue
    const n = hub?.nodes.find((x) => x.id === r.id)
    boxOf.set(r.id, `shared:${r.id}`)
    boxes.push({
      id: `shared:${r.id}`, kind: 'shared', name: r.name, level: r.level, color: null,
      sub: n ? TYPE[n.kind] ?? n.kind : 'shared', reason: r.level === 'warn' || r.level === 'bad' ? r.health : null, figure: figureOf([r]),
      msg: null, traffic: null, dlq: n ? dlqCount(n) : 0, nodeId: r.id, links: [],
    })
  }
  // shared resources that are only links (a log store, an application monitor) have no health to show: a grey box that lists its links when tapped
  for (const r of d.sections.find((x) => x.id === 'hub')?.rows ?? []) {
    if (r.id || r.drawer) continue
    boxes.push({
      id: `shared:link:${r.name}`, kind: 'shared', name: r.name, level: 'none', color: null,
      sub: r.detail.split(' · ')[0] || 'links only', reason: 'links only', figure: null,
      msg: null, traffic: null, dlq: 0, nodeId: null, links: r.links.map((l) => ({ name: l.name, url: l.url })),
    })
  }

  // a third party's services that share an island are one box; a vendor with no island is its own box
  const islands = new Map<string, { name: string; internal: boolean; ids: string[] }>()
  for (const v of s.vendors) {
    const key = `vendor:${v.islandId ?? v.node.id}`
    const e = islands.get(key) ?? islands.set(key, { name: v.islandName ?? v.node.name, internal: v.internal, ids: [] }).get(key)!
    e.ids.push(v.node.id)
  }
  for (const [id, e] of islands) {
    const rows = e.ids.map((i) => side.get(i)).filter((r): r is SideRow => !!r)
    const level = worstOf(rows.map((r) => r.level))
    const bad = rows.filter((r) => r.level === 'bad').length
    const warn = rows.filter((r) => r.level === 'warn').length
    for (const i of e.ids) boxOf.set(i, id)
    boxes.push({
      id, kind: e.internal ? 'internal' : 'vendor', name: e.name, level, color: null,
      sub: e.internal ? d.sections.find((x) => x.id === 'digital')?.title.toLowerCase() ?? 'internal' : e.ids.length > 1 ? `third party · ${plural(e.ids.length, 'service')}` : 'third party',
      reason: reasonOf(bad, warn, level), figure: figureOf(rows),
      msg: null, traffic: null, dlq: e.ids.reduce((a, i) => a + (nodeById.has(i) ? dlqCount(nodeById.get(i)!) : 0), 0),
      nodeId: e.ids.length === 1 ? e.ids[0] : null, links: [],
    })
  }

  // every call between two systems is a line between their boxes; calls inside one box and calls into the hub are left out
  const levelOf = new Map(boxes.map((b) => [b.id, b.level]))
  const colorOf = new Map(boxes.filter((b) => b.color).map((b) => [b.id, b.color!]))
  const sums = new Map<string, number | null>()
  const addCalls = (id: string, calls: readonly { id: string; rps: number | null }[]): void => {
    const from = boxOf.get(id)
    if (!from) return
    for (const c of calls) {
      const to = boxOf.get(c.id)
      if (!to || to === from || to.startsWith('shared:') || from.startsWith('shared:')) continue
      const key = `${from}\n${to}`
      const before = sums.get(key)
      sums.set(key, c.rps == null ? before ?? null : (before ?? 0) + c.rps)
    }
  }
  for (const p of d.pillars) for (const g of p.groups) for (const r of g.rows) addCalls(r.id, r.calls)
  for (const r of side.values()) if (r.id) addCalls(r.id, r.calls)
  const edges: ArchEdge[] = [...sums].map(([key, rps]) => {
    const [from, to] = key.split('\n')
    return { from, to, rps, level: edgeLevel(levelOf.get(from) ?? 'none', levelOf.get(to) ?? 'none'), color: colorOf.get(from) ?? colorOf.get(to) ?? null }
  }).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  return {
    townName: d.townName,
    groupLabel: d.groupLabel,
    totals: { down: d.summary.down, degraded: d.summary.degraded, deadLetters: d.summary.deadLetters, traffic: d.summary.traffic?.total ?? null, messages: d.summary.messageFlow },
    boxes,
    edges,
    vendorsLabel: 'Third-party vendors',
    internalLabel: s.internalVendorsLabel,
    dashboard: d,
    open: null,
  }
}

/**
 * The inside of one pillar: a box for each of its service groups (the lines of the dashboard's table), a line for every call between two of them, and the
 * third parties and other pillars it calls or is called by as closed boxes at the edge, each with the line that joins it. The shared systems and the link-only
 * boxes are left out: nothing draws a line to them. Null when the town has no such pillar.
 */
export function buildPillarArchitecture(s: Snapshot, view: TenantView, pillarId: string, dashboard?: Dashboard): Architecture | null {
  const d = dashboard ?? buildDashboard(s, view)
  const pillar = d.pillars.find((p) => p.id === pillarId)
  if (!pillar) return null
  const whole = buildArchitecture(s, view, d)
  const group = s.groups.find((g) => g.id === pillarId)
  const color = group?.color ?? null

  const boxOf = new Map<string, string>()
  const boxes: ArchBox[] = []
  for (const g of pillar.groups) {
    const id = `svc:${g.key}`
    for (const r of g.rows) boxOf.set(r.id, id)
    const down = g.rows.filter((r) => r.level === 'bad').length
    const degraded = g.rows.filter((r) => r.level === 'warn').length
    boxes.push({
      id, kind: 'service', name: g.name, level: g.level, color,
      sub: plural(g.rows.length, 'system'), reason: reasonOf(down, degraded, g.level),
      figure: g.rps != null && g.rps > 0 ? `${num(g.rps)} rps` : null,
      msg: null, traffic: null, dlq: g.dlq ?? 0, nodeId: g.rows.length === 1 ? g.rows[0].id : null, links: [],
    })
  }
  const inside = new Set(boxes.map((b) => b.id))
  const outside = new Map(whole.boxes.filter((b) => b.kind !== 'shared' && b.id !== pillarId).map((b) => [b.id, b]))
  for (const p of d.pillars) if (p.id !== pillarId) for (const g of p.groups) for (const r of g.rows) boxOf.set(r.id, p.id)
  for (const v of s.vendors) boxOf.set(v.node.id, `vendor:${v.islandId ?? v.node.id}`)

  const sums = new Map<string, number | null>()
  const addCalls = (id: string, calls: readonly { id: string; rps: number | null }[]): void => {
    const from = boxOf.get(id)
    if (!from) return
    for (const c of calls) {
      const to = boxOf.get(c.id)
      if (!to || to === from || !(inside.has(from) || inside.has(to))) continue
      const key = `${from}\n${to}`
      const before = sums.get(key)
      sums.set(key, c.rps == null ? before ?? null : (before ?? 0) + c.rps)
    }
  }
  for (const p of d.pillars) for (const g of p.groups) for (const r of g.rows) addCalls(r.id, r.calls)
  const side = new Map(d.sections.flatMap((x) => x.rows).filter((r) => r.id).map((r) => [r.id!, r]))
  for (const r of side.values()) if (r.id) addCalls(r.id, r.calls)

  const linked = new Set<string>()
  for (const key of sums.keys()) for (const id of key.split('\n')) if (!inside.has(id)) linked.add(id)
  for (const id of [...linked].sort()) { const b = outside.get(id); if (b) boxes.push(b.kind === 'pillar' ? { ...b, closed: true } : b) }

  const byId = new Map(boxes.map((b) => [b.id, b]))
  const edges: ArchEdge[] = [...sums].flatMap(([key, rps]) => {
    const [from, to] = key.split('\n')
    const a = byId.get(from)
    const b = byId.get(to)
    if (!a || !b) return []
    return [{ from, to, rps, level: edgeLevel(a.level, b.level), color: a.color ?? b.color }]
  }).sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to))

  return { ...whole, boxes, edges, open: { id: pillar.id, name: pillar.name } }
}
