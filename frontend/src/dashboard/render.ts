// The dashboard's markup, as strings made from the model. The page draws them; tests read them. Words follow the plan: counts and names, never an
// overall verdict, and nothing about towns, islands or buildings.

import { escapeHtml as esc } from '../picker'
import type { Chip, Dashboard, Group, Issue, JobRow, Level, Pillar, PartRow, Row, Section, SideRow, TenantRow } from './model'
import type { HistoryLine, SourceLine } from './freshness'
import { busiest, windowText, type Flow } from './flows'
import { formatRate } from '../visuals'
import { groupWords } from '../groupLabel'
import type { VendorChoice } from '../vendorFilter'

/** What the viewer has opened or closed. A group or a database that is not in the maps follows its own default. */
export interface UiState {
  openPillars: ReadonlySet<string>
  groups: ReadonlyMap<string, boolean>
  databases: ReadonlyMap<string, boolean>
  /** The services whose called-by and calls chips the viewer has opened. */
  connections: ReadonlySet<string>
  /** The lists under the pillars the viewer has opened; all start closed. */
  sections: ReadonlySet<string>
}

const num = (v: number | null, digits = 0): string => (v == null ? '–' : v.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits }))
const ms = (v: number | null): string => (v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)}`)
const dot = (l: Level): string => `<span class="dot ${l}" title="${l === 'none' ? 'No fresh data' : ''}"></span>`
/** A share in percent for a bar and its figure; null draws a dash. */
const meter = (v: number | null, amber: number): string => (v == null
  ? '<span class="dim">–</span>'
  : `<span class="meter${v >= amber ? ' hot' : ''}"><i style="width:${Math.min(100, Math.max(0, v))}%"></i></span><span class="mv">${Math.round(v)}%</span>`)
const loadRow = (label: string, bars: string, title = ''): string => `<div class="lrow"><span class="lt"${title ? ` title="${title}"` : ''}>${label}</span>${bars}</div>`
/** A database's load: the share of its provisioned capacity it uses. No unit: the source sends none, and engines measure capacity differently. */
const capacityRow = (bars: string): string => loadRow('Cap', bars, 'Capacity used')
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

/** One box of the top row. `tone` colours the box and its number: red, amber or crimson while the count is above zero, green at zero; traffic and flow keep their own colours. */
const box = (id: string, tone: string, title: string, big: string, under: string): string => `<div class="kpi ${tone}" id="kpi-${id}"><span>${title}</span><b>${big}</b>${under}</div>`

/** The six boxes at the top: Down, Degraded, Dead letters, Total traffic, Message flow and Incidents, all the same height and with no lists. A box is left out when nothing measures it. */
export function summaryHtml(d: Dashboard): string {
  const s = d.summary
  const t = s.traffic
  return [
    box('down', s.down > 0 ? 'bad' : 'ok', 'Down', num(s.down), '<small>services</small>'),
    box('degraded', s.degraded > 0 ? 'warn' : 'ok', 'Degraded', num(s.degraded), '<small>services</small>'),
    s.deadLetters != null ? box('dlq', s.deadLetters > 0 ? 'dlq' : 'ok', 'Dead letters', num(s.deadLetters), '<small>messages</small>') : '',
    t ? box('traffic', 'traffic', 'Total traffic', `${num(t.total)} <u>rps</u>`, `<div class="bar"><i style="width:${t.total > 0 ? (t.external / t.total) * 100 : 0}%"></i></div><small>External ${num(t.external)} · Internal ${num(t.internal)}</small>`) : '',
    s.messageFlow != null ? box('flow', 'flow', 'Message flow', `${formatRate(s.messageFlow)} <u>msg/s</u>`, '<small>taken in by the queues</small>') : '',
    s.incidents != null ? box('incidents', s.incidents > 0 ? 'bad' : 'ok', 'Incidents', num(s.incidents), '<small>open</small>') : '',
  ].join('')
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

/** The line under the tile's list and in an open card: the time the rates average over, from the source's window. Nothing when the window is not known. */
const windowNote = (seconds: number): string => (windowText(seconds) ? `<small class="fwin">Average over the last ${windowText(seconds)}</small>` : '')

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

const CPU_AMBER = 80
const MEM_AMBER = 85
const CAPACITY_AMBER = 85

/** A part of a tenant's database that is in trouble, under the tenant line: the shared pool or the piece by name, with its own capacity and throttling. */
function partLine(p: PartRow, label: string): string {
  const throttled = (p.throttled ?? 0) > 0
  return `<tr class="sub part" data-part="${esc(p.name)}"><td class="ind3">${dot(p.level)}<span class="tn">${esc(p.name)}</span>${p.shared ? '' : `<span class="test">${esc(label)}</span>`}</td><td></td><td></td><td></td>
    <td class="ld">${capacityRow(`${meter(p.ru, CAPACITY_AMBER)}${p.limit != null ? `<span class="mx">max ${num(p.limit)}</span>` : ''}`)}</td>
    <td colspan="2">${throttled ? `<span class="thr">${num(p.throttled, 1)}% throttled</span>` : '<span class="dim">no throttling</span>'}</td></tr>`
}

function tenantLine(t: TenantRow, label: string): string {
  const throttled = (t.throttled ?? 0) > 0
  const fine = t.partsFine > 0 && t.parts.length > 0 ? `<tr class="sub part"><td class="ind3"><span class="dim">${t.partsFine} other ${esc(label)}${t.partsFine === 1 ? '' : 's'} fine</span></td><td></td><td></td><td></td><td></td><td colspan="2"></td></tr>` : ''
  return `<tr class="sub" data-tenant="${esc(t.id)}"><td class="ind2">${dot(t.level)}<span class="tn">${esc(t.name)}</span>${t.test ? '<span class="test">test</span>' : ''}${t.unknown ? '<span class="test">unknown</span>' : ''}</td><td></td><td></td><td></td>
    <td class="ld">${capacityRow(`${meter(t.ru, CAPACITY_AMBER)}${t.limit != null ? `<span class="mx">max ${num(t.limit)}</span>` : ''}`)}</td>
    <td colspan="2">${throttled ? `<span class="thr">${num(t.throttled, 1)}% throttled</span>` : '<span class="dim">no throttling</span>'}</td></tr>${t.parts.map((p) => partLine(p, label)).join('')}${fine}`
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
    const max = r.ruMax ? `<span class="mx">max ${num(r.ruMax.limit)}<i>${esc(r.ruMax.tenant)}</i></span>` : ''
    return capacityRow(`${meter(r.ru, CAPACITY_AMBER)}${max}`)
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

/** A tag on the Scheduler's row while a job is late or failed. */
const lateJobs = (r: Row): string => {
  const n = r.jobs.filter((j) => j.status !== 'Ok').length
  return n ? `<b class="warn jobtag">${plural(n, 'job')} ${r.jobs.some((j) => j.status === 'Failed') ? 'failed or late' : 'late'}</b>` : ''
}

function rowHtml(r: Row, ui: UiState): string {
  const tenants = r.tenants
  const open = tenants ? databaseIsOpen(r, ui) : false
  const label = tenants ? `<button class="twist" data-db="${esc(r.id)}" aria-expanded="${open}">${open ? '▾' : '▸'}</button>` : ''
  const count = tenants ? `<span class="test">${plural(tenants.length, 'tenant')}</span>` : ''
  const conn = connectionsLabel(r)
  const showConn = ui.connections.has(r.id)
  const connCell = conn ? `<button class="conn" data-conn="${esc(r.id)}" aria-expanded="${showConn}">${conn}<span class="chev">${showConn ? '▴' : '▾'}</span></button>` : '<span class="dim">–</span>'
  const main = `<tr class="row" data-system="${esc(r.id)}"><td class="ind">${dot(r.level)}<span class="nm">${label}${esc(r.name)}</span>${count}${r.dlq ? `<b class="bad dlq">DLQ ${num(r.dlq)}</b>` : ''}${lateJobs(r)}${r.cloudHealth ? `<b class="cloud-health ${r.cloudHealth.state === 'Unavailable' ? 'down' : 'bad'}" title="${esc(r.cloudHealth.cloud)} reports this resource ${esc(r.cloudHealth.state.toLowerCase())}. Open Details for when and why.">! ${esc(r.cloudHealth.cloud)} incident</b>` : ''}<small>${esc(r.type)}${r.engine ? ` · <b class="engine" title="Database engine and type">${esc(r.engine.name)}<i>${esc(r.engine.type)}</i></b>` : ''}${r.instancesText ? ` · ${esc(r.instancesText)}` : ''}</small></td>
    <td class="n">${trafficCell(r)}</td><td class="n">${errorCell(r)}</td><td class="n">${latencyCell(r)}</td><td class="ld">${loadCell(r)}</td>
    <td>${connCell}</td><td><button class="det" data-details="${esc(r.id)}">Details <b>›</b></button></td></tr>`
  const connRow = showConn && conn
    ? `<tr class="sub cxrow" data-system="${esc(r.id)}"><td></td><td colspan="6"><div class="cx"><div><span class="lbl">Called by</span>${chips(r.calledBy)}</div><div><span class="lbl">Calls</span>${chips(r.calls)}</div></div></td></tr>`
    : ''
  return main + connRow + (tenants && open ? tenants.map((t) => tenantLine(t, r.partLabel)).join('') : '') + jobLines(r.jobs, r.id)
}

function groupHtml(g: Group, ui: UiState): string {
  const open = groupIsOpen(g, ui)
  const facts = [plural(g.rows.length, 'system'), g.rps != null ? `${num(g.rps, g.rps < 10 ? 1 : 0)} req/s` : ''].filter(Boolean).join(' · ')
  const head = `<tr class="g" data-group="${esc(g.key)}" aria-expanded="${open}"><td colspan="7">${dot(g.level)}<span class="gt">${open ? '▾' : '▸'} <span class="nm">${esc(g.name)}</span></span><small>${facts}</small>${g.dlq ? `<b class="bad dlq">DLQ ${num(g.dlq)}</b>` : ''}</td></tr>`
  return head + (open ? g.rows.map((r) => rowHtml(r, ui)).join('') : '')
}

const HEAD = '<thead><tr><th>Service</th><th class="n">Traffic<small>requests / s</small></th><th class="n">Errors<small>share of requests</small></th><th class="n">Latency<small>p99 · against SLA</small></th><th>Load<small>CPU, memory, DB use</small></th><th>Connections<small>who talks to it</small></th><th></th></tr></thead>'

const jobStatus = (j: JobRow): 'bad' | 'warn' | 'ok' => (j.status === 'Failed' ? 'bad' : j.status === 'Overdue' ? 'warn' : 'ok')

/** The Scheduler's jobs under its row: name, last run and result. The row itself turns amber when one is late or failed. */
function jobLines(jobs: readonly JobRow[], id: string): string {
  const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'no run seen')
  return jobs.map((j) => `<tr class="sub jobrow" data-system="${esc(id)}"><td colspan="7"><div class="jl">${dot(jobStatus(j))}<span class="jn">${esc(j.name)}${j.region ? ` <span class="dim">${esc(j.region)}</span>` : ''}</span><span class="jw">${when(j.lastRun)}</span><span class="jr ${jobStatus(j) === 'ok' ? '' : jobStatus(j)}">${j.status === 'Ok' ? 'Succeeded' : j.status === 'Failed' ? 'Failed' : 'Late'}</span></div></td></tr>`).join('')
}

export function pillarHtml(p: Pillar, ui: UiState): string {
  const open = ui.openPillars.has(p.id)
  const affected = p.down + p.degraded
  const level = p.level === 'none' ? 'ok' : p.level
  return `<section class="card ${level}" data-pillar="${esc(p.id)}"><div class="head"><h3>${dot(p.level)}${esc(p.name)}</h3>
    <div class="m"><span class="sc"><b>${p.services}</b> ${p.services === 1 ? 'service' : 'services'}</span>${affected ? `<small>${countsText(p.down, p.degraded)}</small>` : ''}</div>
    ${p.dlq ? `<div class="m"><span>DLQ</span><b class="bad">${num(p.dlq)}</b></div>` : '<div></div>'}
    <div class="acts"><button class="btn" data-toggle="${esc(p.id)}" aria-expanded="${open}">${open ? 'Close' : 'Services'}</button><button class="btn" data-hide="${esc(p.id)}">Hide</button></div></div>
    ${p.configError ? `<div class="issues"><span class="chip bad">${esc(p.configError)}</span></div>` : ''}
    ${p.issues.length ? `<div class="issues">${p.issues.map((i) => issueChip(i, false)).join('')}</div>` : ''}
    ${open ? '' : pillarFlowHtml(p.flow, false, p.trafficSplit)}
    ${open ? `<div class="body">${pillarFlowHtml(p.flow, true, p.trafficSplit)}<div class="tw"><table class="svc">${HEAD}<tbody>${p.groups.map((g) => groupHtml(g, ui)).join('')}</tbody></table></div></div>` : ''}</section>`
}

export function pillarsHtml(d: Dashboard, ui: UiState): string {
  return d.pillars.map((p) => pillarHtml(p, ui)).join('')
}

export function hiddenHtml(d: Dashboard): string {
  return d.hidden.length ? `Hidden: ${d.hidden.map((p) => `<button class="btn" data-show="${esc(p.id)}">${esc(p.name)} — show</button>`).join(' ')}` : ''
}

/** The Pillars dropdown: one checkbox for each pillar. */
/**
 * The Pillars list: an "All pillars" row, a row for each pillar, then the third parties and the internal services outside the platform, each with a tick.
 * Ticking "All" shows every pillar and every third party again.
 */
export function pillarMenuHtml(d: Dashboard, vendors: readonly VendorChoice[] = [], internalLabel = 'Internal services'): string {
  const row = (attr: string, id: string, name: string, on: boolean): string => `<label class="vb-row"><input type="checkbox" ${attr}="${esc(id)}" ${on ? 'checked' : ''} /><span>${esc(name)}</span></label>`
  const many = groupWords(d.groupLabel).many.toLowerCase()
  const outside = vendors.filter((v) => !v.internal)
  const internal = vendors.filter((v) => v.internal)
  const allOn = d.choices.every((c) => c.shown) && vendors.every((v) => v.shown)
  return [
    row('data-pillar-all', 'all', `All ${many}`, allOn),
    ...d.choices.map((c) => row('data-pillar-box', c.id, c.name, c.shown)),
    ...(outside.length ? [`<div class="vb-group">Third parties</div>`, ...outside.map((v) => row('data-vendor-box', v.id, v.name, v.shown))] : []),
    ...(internal.length ? [`<div class="vb-group">${esc(internalLabel)}</div>`, ...internal.map((v) => row('data-vendor-box', v.id, v.name, v.shown))] : []),
  ].join('')
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

export function freshnessHtml(lines: readonly SourceLine[], history: readonly HistoryLine[] = []): string {
  const hist = history.length === 0 ? '' : `<div class="sub-title" id="fresh-history">History</div><table><tbody>${history.map((h) => `<tr><td>${esc(h.label)}</td><td>${esc(h.value)}</td></tr>`).join('')}</tbody></table>`
  if (lines.length === 0) return `<div class="sub-title" style="margin-top:0">Data freshness</div><div class="dim">No source reports its read time.</div>${hist}`
  return `<div class="sub-title" style="margin-top:0">Data freshness</div><table><thead><tr><th>Source</th><th>Last read</th><th>Interval</th></tr></thead><tbody>${lines.map((l) => `<tr class="${l.overdue ? 'warn' : ''}"><td>${esc(l.name)}</td><td>${esc(l.lastRead)}</td><td>${esc(l.interval)}${l.overdue ? ' (overdue)' : ''}</td></tr>`).join('')}</tbody></table>${hist}`
}
