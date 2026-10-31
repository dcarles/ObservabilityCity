import type { GroupSnapshot, LogLine, NodeSnapshot, ScopeResource, Snapshot, SystemDetail } from './types'
import { escapeHtml } from './picker'
import { scopeParams, type Scope } from './scope'
import { tenantListOrder, tenantFigures, yardSummary, type TenantView } from './tenants'
import { regionFigures, regionOptions, validChoice, WORST, type RegionChoice } from './regions'
import { ago, clockTime, configOrder, filterLogs, incidentSummary, jobRows, LAYER_WORD, linkSections, originLabel, type LinkItem, overviewLinks, overviewRows, reasons, resourceLinks, scopeView, SEVERITY_WORD, stateTone, type LogFilter } from './inspectorModel'

export type InspectorTab = 'overview' | 'links' | 'logs' | 'config'
const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'links', label: 'Links' },
  { id: 'logs', label: 'Logs' },
  { id: 'config', label: 'Config' },
]

/** What the drawer needs from the page. */
export interface InspectorHost {
  /** The town and environment the page asked for (null for the defaults). */
  scope: Scope
  /** Whether the system is drawn: a link to one the island filter hides cannot be followed. */
  onScreen(id: string): boolean
  /** Go to a linked system. */
  go(id: string): void
  view(): TenantView
  /** Which region of a service in several the building shows, and a way to change it. */
  regionChoice(id: string): RegionChoice
  setRegion(id: string, choice: RegionChoice): void
  /** The drawer was closed or its system left the town. */
  closed(): void
}

const LOG_POLL_MS = 2000
const LOG_LINES = 120

/**
 * The drawer on the right: one system, with its numbers (Overview), who it talks to (Links), what it says (Logs) and what it is set to (Config, with
 * where each value comes from). The numbers follow the snapshots; the links and the settings are fetched once when it opens; the log lines are fetched
 * again every couple of seconds while that tab is up.
 */
export class Inspector {
  private readonly el = document.getElementById('inspector') as HTMLElement
  private id: string | null = null
  private tab: InspectorTab = 'overview'
  private snap: Snapshot | null = null
  private detail: SystemDetail | null = null
  private detailState: 'loading' | 'ready' | 'missing' = 'loading'
  private logs: LogLine[] = []
  private logsState: 'loading' | 'ready' | 'failed' = 'loading'
  private filter: LogFilter = 'all'
  private timer: number | undefined
  private key = ''
  private seq = 0

  constructor(private readonly host: InspectorHost) {
    this.el.addEventListener('click', (e) => this.click(e.target as HTMLElement))
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.id) this.close() })
  }

  get openId(): string | null {
    return this.id
  }

  get activeTab(): InspectorTab {
    return this.tab
  }

  /** Opens the drawer on a system (on Overview), or keeps it where it is when that system is already shown. */
  open(id: string, tab: InspectorTab = 'overview'): void {
    if (this.id !== id) {
      this.id = id
      this.detail = null
      this.detailState = 'loading'
      this.logs = []
      this.logsState = 'loading'
      void this.loadDetail(id)
    }
    this.setTab(tab)
  }

  close(): void {
    if (!this.id) return
    this.id = null
    this.stopLogs()
    this.seq++
    this.el.hidden = true
    this.key = ''
    this.host.closed()
  }

  /** The newest snapshot: the numbers on Overview follow it. A system that left the town closes the drawer. */
  update(s: Snapshot): void {
    this.snap = s
    if (!this.id) return
    if (!this.find(this.id)) { this.close(); return }
    this.render()
  }

  private setTab(tab: InspectorTab): void {
    this.tab = tab
    const body = this.el.querySelector('.body')
    if (body) body.scrollTop = 0
    this.stopLogs()
    if (tab === 'logs' && this.id) {
      void this.loadLogs()
      this.timer = window.setInterval(() => void this.loadLogs(), LOG_POLL_MS)
    }
    this.render()
  }

  private stopLogs(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer)
    this.timer = undefined
  }

  private get query(): string {
    return scopeParams(this.host.scope)
  }

  private async loadDetail(id: string): Promise<void> {
    const seq = ++this.seq
    try {
      const r = await fetch(`/api/systems/${encodeURIComponent(id)}${this.query ? `?${this.query}` : ''}`)
      if (seq !== this.seq || this.id !== id) return
      if (!r.ok) { this.detailState = 'missing'; this.render(); return }
      this.detail = (await r.json()) as SystemDetail
      this.detailState = 'ready'
    } catch {
      if (seq !== this.seq || this.id !== id) return
      this.detailState = 'missing'
    }
    this.render()
  }

  private async loadLogs(): Promise<void> {
    const id = this.id
    if (!id) return
    try {
      const r = await fetch(`/api/systems/${encodeURIComponent(id)}/logs?limit=${LOG_LINES}${this.query ? `&${this.query}` : ''}`)
      if (this.id !== id) return
      if (!r.ok) { this.logsState = 'failed'; this.render(); return }
      this.logs = (await r.json()) as LogLine[]
      this.logsState = 'ready'
    } catch {
      if (this.id !== id) return
      this.logsState = 'failed'
    }
    this.render()
  }

  private find(id: string): { node: NodeSnapshot; group: GroupSnapshot | null } | null {
    const s = this.snap
    if (!s) return null
    for (const g of s.groups) {
      const node = g.nodes.find((n) => n.id === id)
      if (node) return { node, group: g }
    }
    const v = s.vendors.find((x) => x.node.id === id)
    return v ? { node: v.node, group: null } : null
  }

  private click(t: HTMLElement): void {
    if (t.closest('#inspector-close')) { this.close(); return }
    const tab = t.closest<HTMLElement>('[data-tab]')
    if (tab) { this.setTab(tab.dataset.tab as InspectorTab); return }
    const level = t.closest<HTMLElement>('[data-level]')
    if (level) { this.filter = level.dataset.level as LogFilter; this.render(); return }
    const region = t.closest<HTMLElement>('[data-region]')
    if (region && this.id) { this.host.setRegion(this.id, region.dataset.region as RegionChoice); this.render(); return }
    const link = t.closest<HTMLElement>('[data-go]')
    if (link && !link.classList.contains('off')) this.host.go(link.dataset.go!)
  }

  private render(): void {
    const id = this.id
    const found = id ? this.find(id) : null
    if (!id || !found) return
    const { node: n, group } = found
    const body = { overview: () => this.overview(n, group), links: () => this.links(), logs: () => this.logLines(n), config: () => this.config() }[this.tab]()
    const html = `
      <div class="head">
        <div><b>${escapeHtml(n.name)}</b> <span class="${stateTone(n.state)}">· ${n.state}</span>
          <div class="where">${escapeHtml(n.kind)} · ${escapeHtml(group?.displayName ?? 'Third party')}${this.detail?.service ? ` · service ${escapeHtml(this.detail.service)}` : ''}</div></div>
        <button id="inspector-close" title="Close (Esc)">✕</button>
      </div>
      <div class="tabs" role="tablist">${TABS.map((t) => `<button role="tab" data-tab="${t.id}" class="${t.id === this.tab ? 'on' : ''}">${t.label}</button>`).join('')}</div>
      <div class="body">${body}</div>`
    // the same words are not drawn again: a redraw would throw away the scroll position every half second
    const key = `${id}|${this.tab}|${html}`
    this.el.dataset.id = id
    this.el.dataset.view = this.tab
    this.el.hidden = false
    if (key === this.key) return
    this.key = key
    const scroll = this.el.querySelector('.body')?.scrollTop ?? 0
    this.el.innerHTML = html
    const fresh = this.el.querySelector('.body')
    if (fresh) fresh.scrollTop = scroll
  }

  private overview(n: NodeSnapshot, group: GroupSnapshot | null): string {
    const why = reasons(n, this.snap?.cloud)
    const tenants = this.tenantBlock(n)
    const incidents = group?.incidents ?? []
    return `
      ${why.length === 0 ? '<p class="fine">Nothing to flag: every number is inside its lines.</p>' : `<ul class="why">${why.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`}
      <div class="rows">${overviewRows(n, (id) => this.find(id)?.node.name ?? id, this.snap?.cloud).map((r) => `<div class="row"><span>${r.label}</span><span class="${r.tone}">${escapeHtml(r.value)}</span></div>`).join('')}</div>
      ${this.jobs(n)}
      ${this.regions(n)}
      ${tenants}
      ${this.openIn()}
      ${incidents.length === 0 ? '' : `<h4>Incidents on this island <small>${escapeHtml(incidentSummary(incidents))}</small></h4>
        ${incidents.map((i) => `<div class="row"><span>${escapeHtml(i.title)}</span><span class="warn">sev ${i.severity}${SEVERITY_WORD[i.severity] ? ` · ${SEVERITY_WORD[i.severity]}` : ''} · since ${escapeHtml(clockTime(i.startedAt))}</span></div>`).join('')}`}`
  }

  /** A function building's scheduled jobs, one row for each job in each region. Nothing for a building without jobs. */
  private jobs(n: NodeSnapshot): string {
    const rows = jobRows(n)
    if (rows.length === 0) return ''
    return `<h4>Jobs</h4><div class="jobs">${rows.map((r) => `<div class="row job" data-job="${escapeHtml(r.label)}"><span>${escapeHtml(r.label)}</span><span class="${r.tone}">${escapeHtml(r.value)}</span></div>`).join('')}</div>`
  }

  /**
   * A service in two or more regions: the switch for what its building shows (the worst region by default, all of them, or one) and every region side by
   * side, whatever the switch says. Nothing for a service in one region.
   */
  private regions(n: NodeSnapshot): string {
    const options = regionOptions(n)
    if (options.length === 0) return ''
    const chosen = validChoice(n, this.host.regionChoice(n.id))
    const rows = (n.regions ?? []).map((r) => `<div class="row region${r.skewed ? ' skewed' : ''}" data-region-row="${escapeHtml(r.region)}"><span>${r.skewed ? '⚠ ' : ''}${escapeHtml(r.label)}</span><span class="${r.skewed ? 'warn' : ''}">${escapeHtml(regionFigures(r))}</span></div>`).join('')
    const skewed = (n.regions ?? []).find((r) => r.skewed)
    const note = skewed ? `<p class="note region-skew">${escapeHtml(skewed.label)} takes more of the requests than the environment allows while another region is running. Check the routing, or whether the other region is down.</p>` : ''
    return `<h4>Regions <small>the building shows ${chosen === WORST ? 'the worst region' : escapeHtml(options.find((o) => o.id === chosen)?.label ?? '')}</small></h4>
      <div class="levels regions" role="group" aria-label="Region shown on the building">${options.map((o) => `<button data-region="${escapeHtml(o.id)}" class="${o.id === chosen ? 'on' : ''}">${escapeHtml(o.label)}</button>`).join('')}</div>
      ${rows}${note}`
  }

  /** Links that open the system's resources in a portal or console, from the environment's link rules. Nothing without them. */
  private openIn(): string {
    const v = overviewLinks(this.detail?.scope)
    if (!v) return ''
    const rows = v.items.map((i) => `<div class="row open-in" data-resource="${escapeHtml(i.resource)}"><span>${escapeHtml(i.resource)}</span><span>${this.anchor(i.link.name, i.link.url)}</span></div>`).join('')
    const tenants = v.tenantResources === 0 ? '' : `<p class="note">${v.tenantResources} tenant ${v.tenantResources === 1 ? 'resource has its' : 'resources have their'} own link${v.tenantResources === 1 ? '' : 's'} on the Config tab.</p>`
    const more = v.more === 0 ? '' : `<p class="note">${v.more} more on the Config tab.</p>`
    return `<h4>Open in</h4>${rows}${more}${tenants}`
  }

  private anchor(name: string, url: string): string {
    return `<a class="out" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)} ↗</a>`
  }

  private tenantBlock(n: NodeSnapshot): string {
    if (!n.tenants) return ''
    const view = this.host.view()
    const sum = yardSummary(n.tenants, view, n.throttleAmber)
    const shown = n.tenants.filter((u) => !(view.hideTest && u.kind === 'Test'))
    const worst = tenantListOrder(shown).slice(0, 8)
    return `<h4>Tenants <small>${escapeHtml(sum.text)}${sum.note ? ` · ${escapeHtml(sum.note)}` : ''}</small></h4>` +
      worst.map((u) => `<div class="row"><span>${escapeHtml(u.name)}${u.kind === 'Test' ? ' (test)' : u.kind === 'Unknown' ? ' (unknown)' : ''}</span><span class="${u.state === 'Down' ? 'bad' : u.state === 'Degraded' ? 'warn' : ''}">${tenantFigures(u)}</span></div>`).join('')
  }

  private links(): string {
    if (this.detailState === 'loading') return '<p class="none">Loading…</p>'
    if (!this.detail) return '<p class="none">No link details for this one: it is not in the registry files.</p>'
    const sections = linkSections(this.detail)
    if (sections.length === 0) return '<p class="none">No links: nothing calls this system and it calls nothing.</p>'
    return sections.map((s) => `<h4>${escapeHtml(s.title)}</h4>${s.items.map((i) => {
      if (i.id === null) return `<div class="link plain"><b>${escapeHtml(i.name)}</b><span>${escapeHtml(i.where)}</span></div>`
      const on = this.host.onScreen(i.id)
      return `<div class="link ${on ? '' : 'off'}" data-go="${escapeHtml(i.id)}" ${on ? '' : 'title="Not on screen: the island filter hides it"'}><b>${escapeHtml(i.name)}</b><span>${this.originTag(i.origin)}${escapeHtml(i.where)}${on ? '' : ' · not on screen'}</span></div>`
    }).join('')}`).join('')
  }

  private originTag(origin: LinkItem['origin']): string {
    if (!origin) return ''
    const { text, title } = originLabel(origin)
    return `<i class="origin ${origin.found ? 'found' : 'declared'}" title="${escapeHtml(title)}">${escapeHtml(text)}</i> `
  }

  private logLines(n: NodeSnapshot): string {
    const levels: { id: LogFilter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'warn', label: 'Warnings' }, { id: 'error', label: 'Errors' }]
    const bar = `<div class="levels">${levels.map((l) => `<button data-level="${l.id}" class="${l.id === this.filter ? 'on' : ''}">${l.label}</button>`).join('')}</div>`
    if (this.logsState === 'loading') return `${bar}<p class="none">Loading…</p>`
    if (this.logsState === 'failed') return `${bar}<p class="none">The log lines could not be fetched.</p>`
    const lines = filterLogs(this.logs, this.filter)
    if (this.logs.length === 0) return `${bar}<p class="none">${n.state === 'Stale' ? 'No fresh data, so no log lines.' : 'No log lines yet.'}</p>`
    if (lines.length === 0) return `${bar}<p class="none">No ${this.filter === 'error' ? 'errors' : 'warnings or errors'} in the last ${this.logs.length} lines.</p>`
    return `${bar}<div class="logs">${lines.map((l) => `<div class="log ${l.level.toLowerCase()}"><time>${escapeHtml(clockTime(l.at))}</time><span>${escapeHtml(l.message)}</span></div>`).join('')}</div>
      <p class="note">Latest first, ${ago(this.logs[0]?.at, Date.now())}. Logs are read on demand and do not decide the colours.</p>`
  }

  private config(): string {
    if (this.detailState === 'loading') return '<p class="none">Loading…</p>'
    if (!this.detail) return '<p class="none">No configuration for this one: it is not in the registry files.</p>'
    const d = this.detail
    return `
      <p class="note">Defined in <code>${escapeHtml(d.file)}</code>. Each value says which file layer it comes from.</p>
      <div class="cfg">${configOrder(d.config).map((c) => `<div class="cfg-row" data-key="${escapeHtml(c.key)}"><span class="k">${escapeHtml(c.key)}</span><span class="v">${escapeHtml(c.value)}</span><span class="o ${c.layer.toLowerCase()}" title="${escapeHtml(c.source)}">${LAYER_WORD[c.layer]}</span></div>`).join('')}</div>${this.scope(d)}`
  }

  private resourceLinkRow(r: ScopeResource): string {
    const links = resourceLinks(r)
    return links.length === 0 ? '' : `<span class="rlinks">${links.map((l) => this.anchor(l.name, l.url)).join(' ')}</span>`
  }

  /** Where the system lives and what its telemetry calls it, when the environment has scope rules. A town without them shows nothing here. */
  private scope(d: SystemDetail): string {
    const v = scopeView(d.scope)
    if (!v) return ''
    const rows = v.rows.map((r) => `<div class="cfg-row" data-key="${escapeHtml(r.key)}"><span class="k">${escapeHtml(r.key)}</span><span class="v">${escapeHtml(r.value)}</span><span class="o">${escapeHtml(r.note)}</span></div>`).join('')
    const resources = v.resources.map((r) => `<div class="cfg-row res" data-resource="${escapeHtml(r.name)}"><span class="k">${escapeHtml(r.name)}</span><span class="v">${escapeHtml([r.tenant, r.region, r.instances == null ? '' : `${r.instances} ${r.instances === 1 ? 'instance' : 'instances'}`].filter(Boolean).join(' · '))}</span><span class="o">${escapeHtml(r.type)}</span>${this.resourceLinkRow(r)}</div>`).join('')
    return `<h4 class="scope-title">Where it lives</h4>
      ${v.status ? `<p class="note scope-status">${escapeHtml(v.status)}</p>` : ''}
      <div class="cfg scope-rows">${rows}${resources}</div>
      ${v.problems.map((p) => `<p class="note scope-problem">${escapeHtml(p)}</p>`).join('')}`
  }
}
