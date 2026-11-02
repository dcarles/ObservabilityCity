// The dashboard's markup, as strings made from the model. The page draws them; tests read them. Words follow the plan: counts and names, never an
// overall verdict, and nothing about towns, islands or buildings.

import { escapeHtml as esc } from '../picker'
import type { Chip, Dashboard, Group, Issue, JobRow, Level, Pillar, Row, TenantRow } from './model'

/** What the viewer has opened or closed. A group or a database that is not in the maps follows its own default. */
export interface UiState {
  openPillars: ReadonlySet<string>
  groups: ReadonlyMap<string, boolean>
  databases: ReadonlyMap<string, boolean>
}

const num = (v: number | null, digits = 0): string => (v == null ? '–' : v.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits }))
const ms = (v: number | null): string => (v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)}`)
const dot = (l: Level): string => `<span class="dot ${l}" title="${l === 'none' ? 'No fresh data' : ''}"></span>`
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

export function summaryHtml(d: Dashboard): string {
  const s = d.summary
  const services = `<div class="kpi wide" id="kpi-services"><span>Services</span><b>${countsText(s.down, s.degraded)}</b>
    <div class="lst">${s.affected.length ? s.affected.map((i) => `<span class="ch" data-system="${esc(i.id)}">${dot(i.level)} ${esc(i.name)} <i>${esc(i.where)} · ${i.level === 'bad' ? 'down' : 'degraded'}</i></span>`).join('') : '<small>All services are healthy</small>'}</div></div>`
  const t = s.traffic
  const traffic = t ? `<div class="kpi" id="kpi-traffic"><span>Total traffic</span><b>${num(t.total)} rps</b>
    <div class="bar"><i style="width:${t.total > 0 ? (t.external / t.total) * 100 : 0}%"></i></div><small>External ${num(t.external)} · Internal ${num(t.internal)}</small></div>` : ''
  const dlq = s.deadLetters != null ? `<div class="kpi" id="kpi-dlq"><span>Dead letters</span><b>${num(s.deadLetters)}</b>${s.backlog != null ? `<small>Backlog ${num(s.backlog)} messages</small>` : ''}</div>` : ''
  return services + traffic + dlq
}

function tenantLine(t: TenantRow): string {
  return `<tr class="sub" data-tenant="${esc(t.id)}"><td class="ind2">${dot(t.level)} ${esc(t.name)}${t.test ? '<span class="test">test</span>' : ''}${t.unknown ? '<span class="test">unknown</span>' : ''}</td><td>Tenant</td><td></td><td></td><td></td><td></td><td></td>
    <td class="n ${t.hot && (t.ru ?? 0) > 0 ? 'warn' : ''}">${num(t.ru)}</td><td class="${(t.throttled ?? 0) > 0 ? 'warn' : 'dim'}" style="white-space:nowrap">${(t.throttled ?? 0) > 0 ? `${num(t.throttled, 1)}% throttled` : 'no throttling'}</td><td></td><td></td><td></td><td></td></tr>`
}

function rowHtml(r: Row, ui: UiState): string {
  const tenants = r.tenants
  const open = tenants ? databaseIsOpen(r, ui) : false
  const label = tenants ? `<button class="twist" data-db="${esc(r.id)}" aria-expanded="${open}">${open ? '▾' : '▸'}</button>` : ''
  const count = tenants ? `<span class="test">${plural(tenants.length, 'tenant')}</span>` : ''
  const main = `<tr class="row" data-system="${esc(r.id)}"><td class="ind">${dot(r.level)} ${label}${esc(r.name)}${count}</td><td>${esc(r.type)}</td>
    <td class="n">${num(r.rps, r.rps != null && r.rps < 10 ? 1 : 0)}</td><td class="n">${num(r.errorPct, 1)}</td><td class="n">${ms(r.p99)}</td><td class="n">${r.instances ?? '–'}</td>
    <td class="n">${num(r.cpu)}</td><td class="n">${num(r.ru)}</td><td class="n">${num(r.backlog)}</td><td class="n ${(r.dlq ?? 0) > 0 ? 'bad' : ''}">${num(r.dlq)}</td>
    <td class="wrapc">${chips(r.calledBy)}</td><td class="wrapc">${chips(r.calls)}</td><td><button class="lk" data-details="${esc(r.id)}">Details ›</button></td></tr>`
  return main + (tenants && open ? tenants.map(tenantLine).join('') : '')
}

function groupHtml(g: Group, ui: UiState): string {
  const open = groupIsOpen(g, ui)
  const head = `<tr class="g" data-group="${esc(g.key)}" aria-expanded="${open}"><td>${dot(g.level)} ${open ? '▾' : '▸'} ${esc(g.name)}</td><td>${plural(g.rows.length, 'service')}</td>
    <td class="n">${num(g.rps)}</td><td></td><td></td><td></td><td></td><td></td><td></td><td class="n ${(g.dlq ?? 0) > 0 ? 'bad' : ''}">${num(g.dlq)}</td><td></td><td></td><td></td></tr>`
  return head + (open ? g.rows.map((r) => rowHtml(r, ui)).join('') : '')
}

const HEAD = '<thead><tr><th>Service</th><th>Type</th><th class="n">rps</th><th class="n">Err %</th><th class="n">p99 ms</th><th class="n">Inst</th><th class="n">CPU %</th><th class="n">%RU</th><th class="n">Backlog</th><th class="n">DLQ</th><th>Called by</th><th>Calls</th><th>Links</th></tr></thead>'

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
    ${open ? `<div class="body"><div class="tw"><table class="svc">${HEAD}<tbody>${p.groups.map((g) => groupHtml(g, ui)).join('')}</tbody></table></div>${jobsHtml(p.jobs)}</div>` : ''}</section>`
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
