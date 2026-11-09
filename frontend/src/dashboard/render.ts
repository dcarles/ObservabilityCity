// The dashboard's markup, as strings made from the model. The page draws them; tests read them. Words follow the plan: counts and names, never an
// overall verdict, and nothing about towns, islands or buildings.

import { escapeHtml as esc } from '../picker'
import type { Chip, Dashboard, Group, IncidentRow, Issue, JobRow, Level, Pillar, Row, Section, SideRow, TenantRow } from './model'
import type { SourceLine } from './freshness'
import { busiest, windowText, type Flow, type FlowTile, type TrafficRow } from './flows'
import { formatRate } from '../visuals'

/** What the viewer has opened or closed. A group or a database that is not in the maps follows its own default. */
export interface UiState {
  openPillars: ReadonlySet<string>
  groups: ReadonlyMap<string, boolean>
  databases: ReadonlyMap<string, boolean>
  /** The services whose called-by and calls chips the viewer has opened. */
  connections: ReadonlySet<string>
  /** The lists under the pillars the viewer has opened; all start closed. */
  sections: ReadonlySet<string>
  /** The Message flow tile lists every pair, not only the biggest few. */
  flowsAll?: boolean
}

const num = (v: number | null, digits = 0): string => (v == null ? '–' : v.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits }))
const ms = (v: number | null): string => (v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)}`)
const dot = (l: Level): string => `<span class="dot ${l}" title="${l === 'none' ? 'No fresh data' : ''}"></span>`
/** A share in percent for a bar and its figure; null draws a dash. */
const meter = (v: number | null, amber: number): string => (v == null
  ? '<span class="dim">–</span>'
  : `<span class="meter${v >= amber ? ' hot' : ''}"><i style="width:${Math.min(100, Math.max(0, v))}%"></i></span><span class="mv">${Math.round(v)}%</span>`)
const loadRow = (label: string, bars: string): string => `<div class="lrow"><span class="lt">${label}</span>${bars}</div>`
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export const countsText = (down: number, degraded: number): string => `${down} down · ${degraded} degraded`

export function groupIsOpen(g: Group, ui: UiState): boolean {
  return ui.groups.get(g.key) ?? (g.level === 'warn' || g.level === 'bad')
}

export function databaseIsOpen(r: Row, ui: UiState): boolean {
  return ui.databases.get(r.id) ?? r.tenantsOpenByDefault
}

function chips(list: readonly Chip[]): string {
  return list.length ? list.map((c) => `<span class="ch">${esc(c.name)}${c.rps != null ? ` <i>${num(c.rps, c.rps < 10 ? 1 : 0)}</i>` : ''}</span>`).join('') : '<span class="dim">–</span>'
}

function issueChip(i: Issue, withWhere: boolean): string {
  return `<span class="chip ${i.level}" data-system="${esc(i.id)}"><b>${esc(i.name)}</b>${withWhere ? ` · ${esc(i.where)}` : ''} · ${i.level === 'bad' ? 'down' : 'degraded'}${i.reason ? ` · ${esc(i.reason)}` : ''}</span>`
}

export function summaryHtml(d: Dashboard, ui: Pick<UiState, 'flowsAll'> = {}): string {
  const s = d.summary
  const services = `<div class="kpi" id="kpi-services"><span>Services</span><b>${countsText(s.down, s.degraded)}</b>
    <div class="lst">${s.affected.length ? s.affected.map((i) => `<span class="ch" data-system="${esc(i.id)}">${dot(i.level)} ${esc(i.name)} <i>${esc(i.where)} · ${i.level === 'bad' ? 'down' : 'degraded'}</i></span>`).join('') : '<small>All services are healthy</small>'}</div></div>`
  const t = s.traffic
  const traffic = t ? `<div class="kpi" id="kpi-traffic"><span>Total traffic</span><b>${num(t.total)} <u>rps</u></b>
    <div class="bar"><i style="width:${t.total > 0 ? (t.external / t.total) * 100 : 0}%"></i></div><small>External ${num(t.external)} · Internal ${num(t.internal)}</small>${trafficRowsHtml(s.trafficPillars)}</div>` : ''
  const dlq = s.deadLetters != null ? `<div class="kpi" id="kpi-dlq"><span>Dead letters</span><b>${num(s.deadLetters)}</b>${s.backlog != null ? `<small>Backlog ${num(s.backlog)} messages</small>` : ''}
    <div class="dlist">${deadQueuesHtml(s.deadQueues)}</div></div>` : ''
  const inc = s.incidents
  const incidents = inc ? `<div class="kpi" id="kpi-incidents"><span>Incidents</span><b class="${inc.open > 0 ? 'bad' : 'ok'}">${num(inc.open)}</b>
    <div class="ilist">${inc.rows.length ? inc.rows.map(incidentLine).join('') : '<small>No incidents</small>'}</div></div>` : ''
  return services + traffic + flowTileHtml(s.flows, ui.flowsAll === true) + dlq + incidents
}

const rate = (v: number): string => `${formatRate(v)} msg/s`

type Side = 'sends ext' | 'sends int' | 'receives'
const NONE: Record<Side, string> = { 'sends ext': 'no external messages sent', 'sends int': 'no internal messages sent', receives: 'no messages received' }

/** What a pillar sends (outside its walls or inside) or receives, in words: the rate, or that there are no messages. Null when nothing measures that side. */
function flowSide(v: number | null, label: Side): { label: Side; value: string; none: boolean } | null {
  if (v == null) return null
  return v > 0 ? { label, value: rate(v), none: false } : { label, value: NONE[label], none: true }
}

const sidesOf = (f: Flow): { side: NonNullable<ReturnType<typeof flowSide>>; v: number | null }[] =>
  ([[flowSide(f.sent, 'sends ext'), f.sent], [flowSide(f.internal, 'sends int'), f.internal], [flowSide(f.received, 'receives'), f.received]] as const)
    .flatMap(([side, v]) => (side ? [{ side, v }] : []))

/** The requests a second of each pillar, busiest first, with a bar scaled to the busiest. The few biggest only, so the card stays as tall as its neighbours. */
function trafficRowsHtml(rows: readonly TrafficRow[]): string {
  if (rows.length === 0) return ''
  const top = rows.slice(0, 5), max = rows[0].rps
  const more = rows.length - top.length
  return `<div class="plist">${top.map((r) => `<div class="pl" data-pillar-traffic="${esc(r.id)}"><span class="fn">${esc(r.name)}</span><span class="fbar"><i style="width:${Math.max(2, (r.rps / max) * 100)}%"></i></span><b class="fv">${r.split ? `${num(r.split.in, r.split.in < 10 ? 1 : 0)} in · ${num(r.split.out, r.split.out < 10 ? 1 : 0)} out` : `${num(r.rps, r.rps < 10 ? 1 : 0)} rps`}</b></div>`).join('')}${more > 0 ? `<small class="dim">and ${more} more</small>` : ''}</div>`
}

/** The line under the tile's list and in an open card: the time the rates average over, from the source's window. Nothing when the window is not known. */
const windowNote = (seconds: number): string => (windowText(seconds) ? `<small class="fwin">Average over the last ${windowText(seconds)}</small>` : '')

/**
 * The Message flow tile: the busiest pillars, each with what it sends and what it receives (a bar for each, scaled to the busiest side of any pillar), and a button
 * for all of them. A side with no messages says so. Left out when no pillar moves any message.
 */
export function flowTileHtml(f: FlowTile | null, all: boolean): string {
  if (!f) return ''
  const list = all ? f.all : f.top
  const row = (x: { side: NonNullable<ReturnType<typeof flowSide>>; v: number | null }): string =>
    `<div class="fr"><span class="fd">${x.side.label}</span><span class="fbar"><i style="width:${x.side.none || f.max <= 0 ? 0 : Math.max(2, ((x.v ?? 0) / f.max) * 100)}%"></i></span><b class="fv${x.side.none ? ' none' : ''}">${x.side.value}</b></div>`
  const lines = list.map((x) => `<div class="fl" data-flow="${esc(x.id)}"><span class="fn">${esc(x.name)}</span>${sidesOf(x).map(row).join('')}</div>`).join('')
  const more = f.all.length > f.top.length || all
  const total = f.total != null ? `<b>${formatRate(f.total)} <u>msg/s</u></b><small>Taken in by all the queues of the platform</small>` : ''
  return `<div class="kpi" id="kpi-flow"><span>Message flow</span>${total}<div class="flist">${lines || '<small>No pillar sends or receives 1 message a second or more.</small>'}</div>${windowNote(f.windowSeconds)}${more ? `<button class="btn fall" data-flows-all aria-expanded="${all}">${all ? 'Show fewer' : `Show all ${f.all.length}`}</button>` : ''}</div>`
}

/**
 * A pillar's flow on its card. Closed: one chip with what it sends and receives, only when it moves any message. Open: both sides, also when one is none
 * ("no messages sent"), and the window the rates average over. Nothing when the environment does not measure the pillar.
 */
export function pillarFlowHtml(f: Flow | null, open: boolean, traffic: Pick<Pillar, 'trafficSplit'>['trafficSplit'] = null): string {
  const sides = f ? sidesOf(f).map((x) => x.side) : []
  const busy = f ? busiest(f) > 0 : false
  const tr = traffic && traffic.in + traffic.out + traffic.internal > 0 ? traffic : null
  if (sides.length === 0 && !tr) return ''
  const part = (x: (typeof sides)[number]): string => (x.none ? `<i>${x.value}</i>` : `${x.label} <i>${x.value}</i>`)
  const rps = (v: number): string => `${num(v, v < 10 ? 1 : 0)} rps`
  if (!open) {
    const chips = [busy && f ? `<span class="ch" data-flow="${esc(f.id)}">${sides.map(part).join(' · ')}</span>` : '', tr ? `<span class="ch" data-traffic>traffic in <i>${rps(tr.in)}</i> · out <i>${rps(tr.out)}</i></span>` : ''].filter(Boolean)
    return chips.length ? `<div class="pflow">${chips.join('')}</div>` : ''
  }
  const title: Record<Side, string> = { 'sends ext': 'Sends outside', 'sends int': 'Sends inside', receives: 'Receives' }
  const blocks = [
    ...(f ? sides.map((x) => `<div><span class="lbl">${title[x.label]}</span><span class="ch" data-flow="${esc(f.id)}"><i>${x.value}</i></span></div>`) : []),
    ...(tr ? [['Requests in', tr.in], ['Requests out', tr.out], ['Requests inside', tr.internal]].map(([l, v]) => `<div><span class="lbl">${l}</span><span class="ch" data-traffic><i>${rps(v as number)}</i></span></div>`) : []),
  ]
  return `<div class="sub-title">Messages and traffic</div><div class="pflowx">${blocks.join('')}${f ? windowNote(f.windowSeconds) : ''}</div>`
}

/** The queues with dead letters, worst first: the service that reads each, its pillar, the queue and how many. */
export function deadQueuesHtml(items: Dashboard['summary']['deadQueues']): string {
  if (!items.length) return '<small>No queue has dead letters right now.</small>'
  const queues = new Set(items.map((d) => `${d.nodeId}|${d.queue}`)).size // a queue with dead letters in two regions is one queue, two rows
  const head = `<small class="dh">${queues} ${queues === 1 ? 'queue' : 'queues'} with dead letters</small>`
  return head + items.map((d) => `<div class="dl" data-system="${esc(d.nodeId)}"><span class="what">${esc(d.nodeName)} <em>· ${esc(d.groupName)}</em></span><span class="q">${esc(d.queue)} · ${d.region ? `<span class="qreg">${esc(d.region)}</span> · ` : ''}<i>${num(Math.round(d.count))}</i> dead</span></div>`).join('')
}

function incidentLine(r: IncidentRow): string {
  const body = `<span class="src">${r.source}</span><span class="what">${esc(r.what)}</span><span class="st">${esc(r.status)}</span>${r.cause ? `<span class="cs">cause ${esc(r.cause)}</span>` : ''}`
  return `<div class="il ${r.tone}"${r.nodeId ? ` data-system="${esc(r.nodeId)}"` : ''}${r.times ? ` title="${esc(r.times)}"` : ''}>${body}${r.times || r.dismiss ? `<span class="sub">${r.times ? `<span class="tm">${esc(r.times)}</span>` : ''}${r.dismiss ? `<button class="idis" data-dismiss="${esc(r.dismiss)}" title="Hide this report until the server restarts">Dismiss</button>` : ''}</span>` : ''}</div>`
}

const CPU_AMBER = 80
const MEM_AMBER = 85
const RU_AMBER = 85

function tenantLine(t: TenantRow): string {
  const throttled = (t.throttled ?? 0) > 0
  return `<tr class="sub" data-tenant="${esc(t.id)}"><td class="ind2">${dot(t.level)}<span class="tn">${esc(t.name)}</span>${t.test ? '<span class="test">test</span>' : ''}${t.unknown ? '<span class="test">unknown</span>' : ''}</td><td></td><td></td><td></td>
    <td class="ld">${loadRow('RU', `${meter(t.ru, RU_AMBER)}${t.limit != null ? `<span class="mx">max ${num(t.limit)} RU/s</span>` : ''}`)}</td>
    <td colspan="2">${throttled ? `<span class="thr">${num(t.throttled, 1)}% throttled</span>` : '<span class="dim">no throttling</span>'}</td></tr>`
}

function trafficCell(r: Row): string {
  if (r.rps == null) return '<span class="dim">–</span>'
  const regions = (r.regions ?? []).filter((g) => g.share != null)
  const split = regions.length >= 2
    ? `<span class="rg"><span class="rbar">${regions.map((g, i) => `<i class="r${i % 2}" style="width:${g.share}%"></i>`).join('')}</span><span class="rl">${regions.map((g) => `${esc(g.label)} ${Math.round(g.share ?? 0)}%`).join(' · ')}</span></span>`
    : ''
  return `<b>${num(r.rps, r.rps < 10 ? 1 : 0)}</b><small>req/s</small>${split}`
}

function errorCell(r: Row): string {
  if (r.errorPct == null) return '<span class="dim">–</span>'
  return `<span class="${r.errorPct > 0 ? 'err' : 'errok'}">${num(r.errorPct, 1)}%</span>`
}

function latencyCell(r: Row): string {
  if (r.p99 == null) return '<span class="dim">–</span>'
  return `<span class="lat ${r.latency}">${ms(r.p99)}${r.p99 < 1000 ? '<small>ms</small>' : ''}</span>${r.sla != null ? `<span class="sla">SLA ${ms(r.sla)}${r.sla < 1000 ? ' ms' : ''}</span>` : ''}`
}

function loadCell(r: Row): string {
  if (r.type === 'DB') {
    if (r.ru == null) return '<span class="dim">–</span>'
    const max = r.ruMax ? `<span class="mx">max ${num(r.ruMax.limit)} RU/s<i>${esc(r.ruMax.tenant)}</i></span>` : ''
    return loadRow('RU', `${meter(r.ru, RU_AMBER)}${max}`)
  }
  const per = (label: string, whole: number | null, key: 'cpu' | 'memory', amber: number): string => {
    if (r.regions && r.regions.length >= 2) {
      return loadRow(label, r.regions.map((g) => `<span class="rseg" title="${esc(g.label)}"><span class="rt">${esc(g.tag)}</span>${meter(g[key], amber)}</span>`).join(''))
    }
    return whole == null ? '' : loadRow(label, meter(whole, amber))
  }
  const rows = per('CPU', r.cpu, 'cpu', CPU_AMBER) + per('Mem', r.memory, 'memory', MEM_AMBER)
  return rows || '<span class="dim">–</span>'
}

function connectionsLabel(r: Row): string {
  const parts = [r.calledBy.length ? plural(r.calledBy.length, 'caller') : '', r.calls.length ? plural(r.calls.length, 'call') : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : ''
}

function rowHtml(r: Row, ui: UiState): string {
  const tenants = r.tenants
  const open = tenants ? databaseIsOpen(r, ui) : false
  const label = tenants ? `<button class="twist" data-db="${esc(r.id)}" aria-expanded="${open}">${open ? '▾' : '▸'}</button>` : ''
  const count = tenants ? `<span class="test">${plural(tenants.length, 'tenant')}</span>` : ''
  const conn = connectionsLabel(r)
  const showConn = ui.connections.has(r.id)
  const connCell = conn ? `<button class="conn" data-conn="${esc(r.id)}" aria-expanded="${showConn}">${conn}<span class="chev">${showConn ? '▴' : '▾'}</span></button>` : '<span class="dim">–</span>'
  const main = `<tr class="row" data-system="${esc(r.id)}"><td class="ind">${dot(r.level)}<span class="nm">${label}${esc(r.name)}</span>${count}${r.dlq ? `<b class="bad dlq">DLQ ${num(r.dlq)}</b>` : ''}${r.azure ? `<b class="azure ${r.azure.state === 'Unavailable' ? 'down' : 'bad'}" title="${esc(r.azure.cloud)} reports this resource ${esc(r.azure.state.toLowerCase())}. Open Details for when and why.">! ${esc(r.azure.cloud)} incident</b>` : ''}<small>${esc(r.type)}${r.engine ? ` · <b class="engine" title="Database engine and type">${esc(r.engine.name)}<i>${esc(r.engine.type)}</i></b>` : ''}${r.instancesText ? ` · ${esc(r.instancesText)}` : ''}</small></td>
    <td class="n">${trafficCell(r)}</td><td class="n">${errorCell(r)}</td><td class="n">${latencyCell(r)}</td><td class="ld">${loadCell(r)}</td>
    <td>${connCell}</td><td><button class="det" data-details="${esc(r.id)}">Details <b>›</b></button></td></tr>`
  const connRow = showConn && conn
    ? `<tr class="sub cxrow" data-system="${esc(r.id)}"><td></td><td colspan="6"><div class="cx"><div><span class="lbl">Called by</span>${chips(r.calledBy)}</div><div><span class="lbl">Calls</span>${chips(r.calls)}</div></div></td></tr>`
    : ''
  return main + connRow + (tenants && open ? tenants.map(tenantLine).join('') : '')
}

function groupHtml(g: Group, ui: UiState): string {
  const open = groupIsOpen(g, ui)
  const facts = [plural(g.rows.length, 'service'), g.rps != null ? `${num(g.rps, g.rps < 10 ? 1 : 0)} req/s` : ''].filter(Boolean).join(' · ')
  const head = `<tr class="g" data-group="${esc(g.key)}" aria-expanded="${open}"><td colspan="7">${dot(g.level)}<span class="gt">${open ? '▾' : '▸'} <span class="nm">${esc(g.name)}</span></span><small>${facts}</small>${g.dlq ? `<b class="bad dlq">DLQ ${num(g.dlq)}</b>` : ''}</td></tr>`
  return head + (open ? g.rows.map((r) => rowHtml(r, ui)).join('') : '')
}

const HEAD = '<thead><tr><th>Service</th><th class="n">Traffic<small>requests / s</small></th><th class="n">Errors<small>share of requests</small></th><th class="n">Latency<small>p99 · against SLA</small></th><th>Load<small>CPU, memory, DB use</small></th><th>Connections<small>who talks to it</small></th><th></th></tr></thead>'

function jobsHtml(jobs: readonly JobRow[]): string {
  if (!jobs.length) return ''
  const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'no run seen')
  return `<div class="sub-title">Jobs</div><table class="jobs"><tbody>${jobs.map((j) => `<tr><td>${dot(j.status === 'Failed' ? 'bad' : j.status === 'Overdue' ? 'warn' : 'ok')} ${esc(j.name)}${j.region ? ` <span class="dim">${esc(j.region)}</span>` : ''}</td><td>${when(j.lastRun)}</td><td class="${j.status === 'Failed' ? 'bad' : j.status === 'Overdue' ? 'warn' : ''}">${j.status === 'Ok' ? 'Succeeded' : j.status === 'Failed' ? 'Failed' : 'Late'}</td></tr>`).join('')}</tbody></table>`
}

export function pillarHtml(p: Pillar, ui: UiState): string {
  const open = ui.openPillars.has(p.id)
  const affected = p.down + p.degraded
  const level = p.level === 'none' ? 'ok' : p.level
  return `<section class="card ${level}" data-pillar="${esc(p.id)}"><div class="head"><h3>${dot(p.level)}${esc(p.name)}</h3>
    ${affected ? `<div class="m"><span>Services</span><b>${countsText(p.down, p.degraded)}</b></div>` : '<div></div>'}
    ${p.dlq ? `<div class="m"><span>DLQ</span><b class="bad">${num(p.dlq)}</b></div>` : '<div></div>'}
    <div class="acts"><button class="btn" data-toggle="${esc(p.id)}" aria-expanded="${open}">${open ? 'Close' : 'Services'}</button><button class="btn" data-hide="${esc(p.id)}">Hide</button></div></div>
    ${p.configError ? `<div class="issues"><span class="chip bad">${esc(p.configError)}</span></div>` : ''}
    ${p.issues.length ? `<div class="issues">${p.issues.map((i) => issueChip(i, false)).join('')}</div>` : ''}
    ${open ? '' : pillarFlowHtml(p.flow, false, p.trafficSplit)}
    ${open ? `<div class="body">${pillarFlowHtml(p.flow, true, p.trafficSplit)}<div class="tw"><table class="svc">${HEAD}<tbody>${p.groups.map((g) => groupHtml(g, ui)).join('')}</tbody></table></div>${jobsHtml(p.jobs)}</div>` : ''}</section>`
}

export function pillarsHtml(d: Dashboard, ui: UiState): string {
  return d.pillars.map((p) => pillarHtml(p, ui)).join('')
}

export function hiddenHtml(d: Dashboard): string {
  return d.hidden.length ? `Hidden: ${d.hidden.map((p) => `<button class="btn" data-show="${esc(p.id)}">${esc(p.name)} — show</button>`).join(' ')}` : ''
}

/** The Pillars dropdown: one checkbox for each pillar. */
export function pillarMenuHtml(d: Dashboard): string {
  return d.choices.map((c) => `<label class="vb-row"><input type="checkbox" data-pillar-box="${esc(c.id)}" ${c.shown ? 'checked' : ''} /><span>${esc(c.name)}</span></label>`).join('')
}

function sideRowHtml(r: SideRow, columns: 'hub' | 'list'): string {
  const links = [...r.links.map((l) => `<a class="lk" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name)} ↗</a>`), ...(r.drawer && r.id ? [`<button class="lk" data-details="${esc(r.id)}">Details ›</button>`] : [])].join('') || '<span class="dim">–</span>'
  const name = `${dot(r.level)} ${esc(r.name)}`
  const health = r.health ? `<span class="${r.level === 'bad' ? 'bad' : r.level === 'warn' ? 'warn' : ''}">${esc(r.health)}</span>` : '<span class="dim">no health available</span>'
  return columns === 'hub'
    ? `<tr data-side="${esc(r.id ?? r.name)}"><td>${name}</td><td>${r.detail ? esc(r.detail) : '<span class="dim">–</span>'}</td><td>${r.health ? health : '<span class="dim">–</span>'}</td><td>${links}</td></tr>`
    : `<tr data-side="${esc(r.id ?? r.name)}"><td>${name}</td><td>${health}${r.detail ? ` <span class="dim">· ${esc(r.detail)}</span>` : ''}</td><td class="wrapc">${chips(r.calledBy)}</td><td class="wrapc">${chips(r.calls)}</td><td>${links}</td></tr>`
}

export function sectionHtml(x: Section, open: boolean): string {
  const head = x.id === 'hub'
    ? '<thead><tr><th>Resource</th><th>Details</th><th>Health</th><th>Links</th></tr></thead>'
    : '<thead><tr><th>Name</th><th>Health</th><th>Called by</th><th>Calls</th><th>Links</th></tr></thead>'
  return `<details class="sec" data-section="${x.id}" ${open ? 'open' : ''}><summary><b>${esc(x.title)}</b>${x.summary ? `<span>${esc(x.summary)}</span>` : ''}</summary>
    <div class="panel"><table>${head}<tbody>${x.rows.map((r) => sideRowHtml(r, x.id === 'hub' ? 'hub' : 'list')).join('')}</tbody></table></div></details>`
}

export function sectionsHtml(d: Dashboard, ui: UiState): string {
  return d.sections.map((x) => sectionHtml(x, ui.sections.has(x.id))).join('')
}

export function freshnessHtml(lines: readonly SourceLine[]): string {
  if (lines.length === 0) return '<div class="sub-title" style="margin-top:0">Data freshness</div><div class="dim">No source reports its read time.</div>'
  return `<div class="sub-title" style="margin-top:0">Data freshness</div><table><thead><tr><th>Source</th><th>Last read</th><th>Interval</th></tr></thead><tbody>${lines.map((l) => `<tr class="${l.overdue ? 'warn' : ''}"><td>${esc(l.name)}</td><td>${esc(l.lastRead)}</td><td>${esc(l.interval)}${l.overdue ? ' (overdue)' : ''}</td></tr>`).join('')}</tbody></table>`
}
