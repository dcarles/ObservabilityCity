import { absentEverywhere, isAbsent, isUnmonitored, QUIET_TEXT, type Signal } from './signals'
import type { Snapshot, NodeSnapshot } from './types'
import type { ConnectionState } from './connection'
import { formatMs, formatRate } from './visuals'
import { escapeHtml, Picker, type PickItem } from './picker'
import { tenantFigures, yardSummary, type TenantView } from './tenants'
import { systemNumbers, type ServiceSummary } from './scene/service'
import { assetWhere, type AssetSummary } from './scene/assets'
import { viewTotals } from './viewTotals'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/** The states the top bar's counters can list. */
export type ListedState = 'Degraded' | 'Down' | 'Stale' | 'Incidents'

export class TopBar {
  private readonly el = $('topbar')
  private status: ConnectionState = 'connecting'
  private snap: Snapshot | null = null

  constructor(
    private readonly onList: (state: ListedState, anchor: DOMRect) => void,
    private readonly view: () => TenantView,
  ) {
    // the bar is redrawn with every snapshot, so one listener on the bar itself serves the chips
    this.el.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-list]')
      if (chip) this.onList(chip.dataset.list as ListedState, chip.getBoundingClientRect())
    })
    this.render()
  }

  setStatus(s: ConnectionState): void {
    this.status = s
    this.render()
  }

  setSnapshot(s: Snapshot): void {
    this.snap = s
    this.render()
  }

  /** Draws the numbers again after the tenant choice changed. */
  refresh(): void {
    this.render()
  }

  private render(): void {
    const s = this.snap
    const t = s ? viewTotals(s, this.view()) : null
    const label = { connecting: 'Connecting…', live: s?.mode === 'demo' ? 'Live (demo data)' : 'Live', reconnecting: 'Reconnecting…', offline: 'Backend offline', badData: 'Bad data, showing the last good town' }[this.status]
    const dot = this.status === 'live' ? 'live' : this.status === 'offline' || this.status === 'badData' ? '' : 'wait'
    const day = s ? clock(s.dayFraction) : ''
    // what the numbers count, in words, for the tooltips
    const filtered = (s?.view?.islands.length ?? 0) > 0
    const scope = filtered ? 'Counts only the islands on screen. ' : ''
    const share = t && t.tenantShare < 1 ? `${Math.round(t.tenantShare * 100)}% of the environment's traffic, for the tenants chosen. ` : ''
    const wide = t && (t.tenantShare < 1 || this.view().hideTest || this.view().tenants.length > 0) ? 'Not split by tenant: counts all tenants. ' : ''
    $('topbar-left').innerHTML = `
      ${s ? `<span class="town" id="town-name" title="${escapeHtml(s.townName)}">${escapeHtml(s.townName)}</span>` : ''}`
    $('topbar-right').innerHTML = `
      <span class="spacer"></span>
      ${t ? `
        ${absentEverywhere(s!, 'requests') ? '' : `<div class="chip" id="chip-requests" title="${escapeHtml(scope + share)}"><b>${formatRate(t.requestsPerSecond)}</b><span>req/s</span></div>`}
        ${absentEverywhere(s!, 'errors') ? '' : `<div class="chip ${t.errorRate >= 0.05 ? 'bad' : t.errorRate >= 0.01 ? 'warn' : ''}" title="${escapeHtml(scope + wide)}"><b>${(t.errorRate * 100).toFixed(1)}%</b><span>errors</span></div>`}
        ${absentEverywhere(s!, 'latency') ? '' : `<div class="chip p99" title="${escapeHtml(scope + wide)}"><b>${formatMs(t.p99Ms)}</b><span>p99</span></div>`}
        ${absentEverywhere(s!, 'deadLetters') ? '' : `<div class="chip dlq ${t.deadLetters > 0 ? 'bad' : ''}" title="${escapeHtml(`Messages in dead-letter queues. ${scope}${wide}`)}"><b>${formatRate(t.deadLetters)}</b><span>DLQ</span></div>`}
        <button class="chip clickable ${t.degraded ? 'warn' : ''}" data-list="Degraded" title="Show the degraded systems"><b>${t.degraded}</b><span>degraded</span></button>
        <button class="chip clickable ${t.down ? 'bad' : ''}" data-list="Down" title="Show the systems that are down"><b>${t.down}</b><span>down</span></button>
        <button class="chip clickable ${t.stale ? 'stale' : ''}" data-list="Stale" title="Show the systems with no fresh data"><b>${t.stale}</b><span>no data</span></button>
        <button class="chip clickable ${t.incidents ? 'warn' : ''}" data-list="Incidents" title="Show the islands with open incidents"><b>${t.incidents}</b><span>incidents</span></button>
        <div class="chip time"><b>${day}</b><span>town time</span></div>` : ''}
      <span class="status" title="${label}"><i class="dot ${dot}"></i><span class="label">${label}</span></span>`
  }
}

/**
 * Configuration problems that did not stop the town: a pillar file that was skipped, a reload that failed. They sit in a small
 * panel under the top bar, so a broken file is noticed without opening the logs.
 */
export class NoticesPanel {
  private readonly el = $('notices')
  private open = false
  private notices: string[] = []
  private notes: string[] = []

  /** `notes` are things worth knowing that are not mistakes (a pillar the town does not have yet): listed apart and never counted as problems. */
  show(notices: string[], notes: string[] = []): void {
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((n, i) => n === b[i])
    if (same(notices, this.notices) && same(notes, this.notes)) return
    this.notices = notices
    this.notes = notes
    this.render()
  }

  private render(): void {
    this.el.hidden = this.notices.length === 0 && this.notes.length === 0
    const n = this.notices.length
    const m = this.notes.length
    const label = [n > 0 ? `${n} config problem${n === 1 ? '' : 's'}` : '', m > 0 ? `${m} note${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
    this.el.classList.toggle('only-notes', n === 0)
    this.el.innerHTML = `
      <button id="notices-toggle">${label} ${this.open ? '▴' : '▾'}</button>
      <ul ${this.open ? '' : 'hidden'}>${this.notices.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}${this.notes.map((t) => `<li class="note">${escapeHtml(t)}</li>`).join('')}</ul>`
    this.el.querySelector('#notices-toggle')!.addEventListener('click', () => { this.open = !this.open; this.render() })
  }
}

export { staleCount } from './viewTotals'

function clock(fraction: number): string {
  const minutes = Math.floor(fraction * 24 * 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** The tenant lines of a data store with a database for each tenant: the sign's words and the units that are not fine. */
function tenantRows(n: NodeSnapshot, view: TenantView): string {
  if (!n.tenants) return ''
  const sum = yardSummary(n.tenants, view, n.throttleAmber)
  const shown = n.tenants.filter((u) => !(view.hideTest && u.kind === 'Test'))
  const worst = [...shown].sort((a, b) => (b.utilisation ?? 0) - (a.utilisation ?? 0)).slice(0, 4)
  return `<div class="row tenants"><span>tenants</span><span>${escapeHtml(sum.text)}${sum.note ? ` · ${escapeHtml(sum.note)}` : ''}</span></div>` +
    worst.map((u) => `<div class="row"><span>${escapeHtml(u.name)}${u.kind === 'Test' ? ' (test)' : u.kind === 'Unknown' ? ' (unknown)' : ''}</span><span>${tenantFigures(u)}</span></div>`).join('')
}

export function showTooltip(n: NodeSnapshot | null, x: number, y: number, view: TenantView = { hideTest: false, tenants: [] }): void {
  const el = $('tooltip')
  if (!n) { el.hidden = true; return }
  const cls = n.state === 'Healthy' ? 'ok' : n.state === 'Degraded' ? 'warn' : n.state === 'Down' ? 'bad' : 'stale'
  const slow = n.p99Ms > n.slaP99Ms
  const none = isUnmonitored(n)
  const row = (signal: Signal, html: string) => (isAbsent(n, signal) ? '' : html)
  el.innerHTML = `
    <b>${n.name}</b> <span class="${none ? '' : cls}">· ${none ? 'no source' : n.state}</span>
    <div class="row"><span>id</span><span>${n.id}</span></div>
    ${row('instances', `<div class="row"><span>instances</span><span>${n.instancesHealthy}/${n.instancesTotal} healthy</span></div>`)}
    ${row('requests', `<div class="row"><span>requests</span><span>${formatRate(n.requestsPerSecond)}/s</span></div>`)}
    ${row('errors', n.quiet ? `<div class="row"><span>errors</span><span>${QUIET_TEXT}</span></div>` : `<div class="row"><span>errors</span><span class="${n.errorRate >= n.errorRed ? 'bad' : n.errorRate >= n.errorAmber ? 'warn' : ''}">${(n.errorRate * 100).toFixed(2)}%</span></div>`)}
    ${row('latency', n.quiet ? `<div class="row"><span>p99 / SLA</span><span>${QUIET_TEXT}</span></div>` : `<div class="row"><span>p99 / SLA</span><span class="${slow ? 'warn' : ''}">${formatMs(n.p99Ms)} / ${formatMs(n.slaP99Ms)}</span></div>`)}
    ${isAbsent(n, 'requests') || isAbsent(n, 'instances') ? '' : `<div class="row"><span>load</span><span>${Math.round(n.load * 100)}%</span></div>`}${tenantRows(n, view)}`
  el.hidden = false
  const w = el.offsetWidth, h = el.offsetHeight
  el.style.left = `${Math.min(x + 16, window.innerWidth - w - 8)}px`
  el.style.top = `${Math.min(y + 16, window.innerHeight - h - 8)}px`
}

/** The name of the island under the pointer, in the same box as a building's numbers. Null hides it. */
export function showIslandTooltip(name: string | null, third: boolean, x: number, y: number): void {
  const el = $('tooltip')
  if (!name) { el.hidden = true; return }
  el.innerHTML = `<b>${escapeHtml(name)}</b> <span class="stale">· ${third ? 'third party island' : 'island'}</span>`
  el.hidden = false
  const w = el.offsetWidth, h = el.offsetHeight
  el.style.left = `${Math.min(x + 16, window.innerWidth - w - 8)}px`
  el.style.top = `${Math.min(y + 16, window.innerHeight - h - 8)}px`
}

export type SearchItem = PickItem

/**
 * Search box over every island and building. Typing filters, arrow keys and Enter pick, "/" focuses it. It lives outside the
 * top bar, which redraws with every snapshot and would take focus away.
 */
export class Search {
  private readonly input = $<HTMLInputElement>('search-input')

  constructor(items: () => SearchItem[], onPick: (item: SearchItem) => void) {
    new Picker(this.input, $('search-results'), { items, onPick, limit: 8 })
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== this.input) { e.preventDefault(); this.input.focus() }
    })
  }
}

/**
 * The list under a top bar counter: the systems in that state right now. Clicking one picks it, and the page glides to it.
 * It stays up, and follows the numbers, until it is closed or something is picked.
 */
export class StateList {
  private readonly el = $('state-list')
  private state: ListedState | null = null
  private key = ''
  private anchor: DOMRect | null = null

  constructor(private readonly systems: (state: ListedState) => PickItem[], private readonly onPick: (item: PickItem) => void) {
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement
      if (!this.el.hidden && !t.closest('#state-list') && !t.closest('[data-list]')) this.close()
    })
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close() })
  }

  /** Opens the list for a state, or closes it if that one is already open. */
  toggle(state: ListedState, anchor: DOMRect): void {
    if (this.state === state && !this.el.hidden) { this.close(); return }
    this.state = state
    this.anchor = anchor
    this.key = ''
    this.refresh()
  }

  /** Redraws the list when the systems in that state have changed. */
  refresh(): void {
    if (!this.state) return
    const items = this.systems(this.state).sort((a, b) => a.name.localeCompare(b.name))
    const key = `${this.state}|${items.map((i) => i.id).join(',')}`
    if (key === this.key) return
    this.key = key
    const word = { Down: 'down', Degraded: 'degraded', Stale: 'with no data', Incidents: 'with open incidents' }[this.state]
    const none = this.state === 'Incidents' ? 'No incidents are open right now.' : `Nothing is ${word} right now.`
    this.el.innerHTML = `
      <div class="head"><b>${items.length} ${word}</b><button id="state-list-close" title="Close">✕</button></div>
      ${items.length === 0 ? `<p class="none">${none}</p>` : items.map((m, i) => `<div class="hit" data-i="${i}"><b>${escapeHtml(m.name)}</b><span>${escapeHtml(m.where)}</span></div>`).join('')}`
    this.el.querySelector('#state-list-close')!.addEventListener('click', () => this.close())
    this.el.querySelectorAll<HTMLElement>('.hit').forEach((row) =>
      row.addEventListener('click', () => { const item = items[Number(row.dataset.i)]; this.close(); this.onPick(item) }))
    this.el.hidden = false
    if (this.anchor) {
      const w = this.el.offsetWidth
      this.el.style.left = `${Math.max(8, Math.min(this.anchor.left, window.innerWidth - w - 8))}px`
      this.el.style.top = `${this.anchor.bottom + 8}px`
    }
  }

  close(): void {
    this.state = null
    this.key = ''
    this.el.hidden = true
  }
}

/**
 * What a click on a service's sign or hedge opens: the service, the island it stands on, and each of its systems with its numbers.
 * A data store with a database for each tenant adds how many tenants it has and how many are throttled.
 */
export class ServicePanel {
  private readonly el = $('service-panel')

  constructor(private readonly onPick: (systemId: string) => void) {
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close() })
  }

  get open(): boolean {
    return !this.el.hidden
  }

  /** The key of the service shown, or null. */
  get key(): string | null {
    return this.el.hidden ? null : this.el.dataset.key ?? null
  }

  show(sv: ServiceSummary): void {
    const cls = sv.state === 'Healthy' ? 'ok' : sv.state === 'Degraded' ? 'warn' : sv.state === 'Down' ? 'bad' : 'stale'
    this.el.dataset.key = sv.key
    this.el.dataset.state = sv.state
    this.el.innerHTML = `
      <div class="head"><div><b>${escapeHtml(sv.name)}</b> <span class="${sv.monitored ? cls : ''}">· ${sv.monitored ? sv.state : 'no source'}</span><div class="where">Service on ${escapeHtml(sv.groupName)}</div></div><button id="service-close" title="Close">✕</button></div>
      ${sv.systems.map((m) => {
        const mc = m.unmonitored ? '' : m.state === 'Healthy' ? 'ok' : m.state === 'Degraded' ? 'warn' : m.state === 'Down' ? 'bad' : 'stale'
        return `<div class="sys" data-id="${escapeHtml(m.id)}">
          <div class="line"><b>${escapeHtml(m.name)}</b><span class="${mc}">${m.unmonitored ? 'no source' : m.state}</span></div>
          <div class="nums">${systemNumbers(m)}</div>
        </div>`
      }).join('')}`
    this.el.hidden = false
    this.el.querySelector('#service-close')!.addEventListener('click', () => this.close())
    this.el.querySelectorAll<HTMLElement>('.sys').forEach((row) => row.addEventListener('click', () => this.onPick(row.dataset.id!)))
  }

  /** A resource building: what it is, where it belongs and its addresses. No health, no numbers: it is not monitored. */
  showAsset(a: AssetSummary): void {
    this.el.dataset.key = `asset:${a.id}`
    delete this.el.dataset.state
    const links = a.links.map((l) => `<div class="line"><span>${escapeHtml(l.name)}</span><a class="out" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a></div>`).join('')
    this.el.innerHTML = `
      <div class="head"><div><b>${escapeHtml(a.name)}</b> <span class="stale">· ${escapeHtml(a.label)}</span><div class="where">${escapeHtml(assetWhere(a))}</div></div><button id="service-close" title="Close">✕</button></div>
      ${a.region ? `<div class="sys"><div class="line"><span>Region</span><span>${escapeHtml(a.region)}</span></div></div>` : ''}
      <div class="sys"><div class="nums">Not monitored: it stands in the town so the pillar's resources can be found.</div></div>
      ${links}`
    this.el.hidden = false
    this.el.querySelector('#service-close')!.addEventListener('click', () => this.close())
  }

  close(): void {
    this.el.hidden = true
    delete this.el.dataset.key
  }
}
