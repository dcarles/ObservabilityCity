import type { Snapshot, NodeSnapshot } from './types'
import type { ConnectionState } from './connection'
import { formatMs, formatRate } from './visuals'
import { escapeHtml, Picker, type PickItem } from './picker'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/** The states the top bar's counters can list. */
export type ListedState = 'Degraded' | 'Down' | 'Stale' | 'Incidents'

export class TopBar {
  private readonly el = $('topbar')
  private status: ConnectionState = 'connecting'
  private snap: Snapshot | null = null
  private deps = false

  constructor(
    private readonly onHome: () => void,
    private readonly onList: (state: ListedState, anchor: DOMRect) => void,
    private readonly onDependencies: (on: boolean) => void,
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

  private render(): void {
    const s = this.snap
    const t = s?.totals
    const label = { connecting: 'Connecting…', live: 'Live (demo data)', reconnecting: 'Reconnecting…', offline: 'Backend offline', badData: 'Bad data, showing the last good town' }[this.status]
    const dot = this.status === 'live' ? 'live' : this.status === 'offline' || this.status === 'badData' ? '' : 'wait'
    const day = s ? clock(s.dayFraction) : ''
    const stale = s ? staleCount(s) : 0
    $('topbar-left').innerHTML = `
      <span class="brand">Observability City</span>
      ${s ? `<span class="town">${escapeHtml(s.townName)}</span>` : ''}`
    $('topbar-right').innerHTML = `
      <span class="spacer"></span>
      ${t ? `
        <div class="chip"><b>${formatRate(t.requestsPerSecond)}</b><span>req/s</span></div>
        <div class="chip ${t.errorRate >= 0.05 ? 'bad' : t.errorRate >= 0.01 ? 'warn' : ''}"><b>${(t.errorRate * 100).toFixed(1)}%</b><span>errors</span></div>
        <div class="chip p99"><b>${formatMs(t.p99Ms)}</b><span>p99</span></div>
        <div class="chip dlq ${t.deadLetters > 0 ? 'bad' : ''}" title="Messages in dead-letter queues, town-wide"><b>${formatRate(t.deadLetters)}</b><span>DLQ</span></div>
        <button class="chip clickable ${t.degraded ? 'warn' : ''}" data-list="Degraded" title="Show the degraded systems"><b>${t.degraded}</b><span>degraded</span></button>
        <button class="chip clickable ${t.down ? 'bad' : ''}" data-list="Down" title="Show the systems that are down"><b>${t.down}</b><span>down</span></button>
        <button class="chip clickable ${stale ? 'stale' : ''}" data-list="Stale" title="Show the systems with no fresh data"><b>${stale}</b><span>no data</span></button>
        <button class="chip clickable ${t.incidents ? 'warn' : ''}" data-list="Incidents" title="Show the islands with open incidents"><b>${t.incidents}</b><span>incidents</span></button>
        <div class="chip time"><b>${day}</b><span>town time</span></div>` : ''}
      <span class="status" title="${label}"><i class="dot ${dot}"></i><span class="label">${label}</span></span>
      <button id="deps" class="${this.deps ? 'on' : ''}" title="Draw an arc between islands that call each other, thicker for more traffic">Dependencies</button>
      <button id="home" title="Frame the whole town">Home</button>`
    this.el.querySelector('#home')!.addEventListener('click', this.onHome)
    this.el.querySelector('#deps')!.addEventListener('click', () => {
      this.deps = !this.deps
      this.onDependencies(this.deps)
      this.render()
    })
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

  show(notices: string[]): void {
    const same = notices.length === this.notices.length && notices.every((n, i) => n === this.notices[i])
    if (same) return
    this.notices = notices
    this.render()
  }

  private render(): void {
    this.el.hidden = this.notices.length === 0
    const n = this.notices.length
    this.el.innerHTML = `
      <button id="notices-toggle">${n} config problem${n === 1 ? '' : 's'} ${this.open ? '▴' : '▾'}</button>
      <ul ${this.open ? '' : 'hidden'}>${this.notices.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
    this.el.querySelector('#notices-toggle')!.addEventListener('click', () => { this.open = !this.open; this.render() })
  }
}

/** Systems (and third parties) whose readings are too old or missing: shown grey, never healthy. */
export function staleCount(s: Snapshot): number {
  return s.groups.reduce((a, g) => a + g.nodes.filter((n) => n.state === 'Stale').length, 0) + s.vendors.filter((v) => v.node.state === 'Stale').length
}

function clock(fraction: number): string {
  const minutes = Math.floor(fraction * 24 * 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export function showTooltip(n: NodeSnapshot | null, x: number, y: number): void {
  const el = $('tooltip')
  if (!n) { el.hidden = true; return }
  const cls = n.state === 'Healthy' ? 'ok' : n.state === 'Degraded' ? 'warn' : n.state === 'Down' ? 'bad' : 'stale'
  const slow = n.p99Ms > n.slaP99Ms
  el.innerHTML = `
    <b>${n.name}</b> <span class="${cls}">· ${n.state}</span>
    <div class="row"><span>id</span><span>${n.id}</span></div>
    <div class="row"><span>instances</span><span>${n.instancesHealthy}/${n.instancesTotal} healthy</span></div>
    <div class="row"><span>requests</span><span>${formatRate(n.requestsPerSecond)}/s</span></div>
    <div class="row"><span>errors</span><span class="${n.errorRate >= n.errorRed ? 'bad' : n.errorRate >= n.errorAmber ? 'warn' : ''}">${(n.errorRate * 100).toFixed(2)}%</span></div>
    <div class="row"><span>p99 / SLA</span><span class="${slow ? 'warn' : ''}">${formatMs(n.p99Ms)} / ${formatMs(n.slaP99Ms)}</span></div>
    <div class="row"><span>load</span><span>${Math.round(n.load * 100)}%</span></div>`
  el.hidden = false
  const w = el.offsetWidth, h = el.offsetHeight
  el.style.left = `${Math.min(x + 16, window.innerWidth - w - 8)}px`
  el.style.top = `${Math.min(y + 16, window.innerHeight - h - 8)}px`
}

interface FxState { calm: boolean; effects: { id: string; target: string; kind: string; intensity: number }[] }

/**
 * Temporary controls for slice 1: they poke the fake generator so the look can be judged while things
 * break. The real Break things panel and story bar replace this in a later slice.
 */
export class PreviewPanel {
  private readonly el = $('preview')
  private collapsed = false
  private state: FxState = { calm: false, effects: [] }
  private target = '*'

  constructor(private targets: () => PickItem[]) {}

  async refresh(): Promise<void> {
    try {
      this.state = (await (await fetch('/api/fake')).json()) as FxState
    } catch { /* backend not up yet */ }
    this.render()
  }

  private async send(path: string, method: string, body?: unknown): Promise<void> {
    await fetch(`/api/fake${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    await this.refresh()
  }

  render(): void {
    this.el.dataset.collapsed = String(this.collapsed)
    this.el.innerHTML = `
      <div class="head"><h3>Try it (preview)</h3><button id="fold">${this.collapsed ? '▾' : '▴'}</button></div>
      <p class="note">Temporary controls for this slice. The final Break things panel comes later.</p>
      <label>Target</label>
      <div class="combo"><input id="target" type="text" placeholder="Type to find a target" autocomplete="off" spellcheck="false" /><div id="target-results" class="picker-results" hidden></div></div>
      <div class="grid">
        <button data-fx="Traffic" data-i="0.8">Traffic spike</button>
        <button data-fx="Latency" data-i="0.6">Slow</button>
        <button data-fx="Errors" data-i="0.4">Errors</button>
        <button data-fx="UnhealthyInstances" data-i="0.5">Sick instances</button>
        <button data-fx="HighCpu" data-i="1">High CPU</button>
        <button data-fx="HighMemory" data-i="1">High memory</button>
        <button data-fx="Saturate" data-i="1">DB saturated</button>
        <button data-fx="Backlog" data-i="1">Queue backs up</button>
        <button data-fx="Poison" data-i="1">Dead letters</button>
        <button data-fx="Down" data-i="1">Down</button>
        <button data-fx="Stale" data-i="1">Go quiet</button>
        <button data-fx="Incident" data-i="1" title="Storm over the island">Sev 1 storm</button>
        <button data-fx="Incident" data-i="0.7" title="Rain over the island">Sev 2 rain</button>
        <button data-fx="Incident" data-i="0.45" title="Overcast over the island">Sev 3 overcast</button>
        <button data-fx="Incident" data-i="0.2" title="A few light clouds over the island">Sev 4 clouds</button>
        <button id="reset">Reset all</button>
      </div>
      <button class="wide ${this.state.calm ? 'on' : ''}" id="calm">Calm (freeze noise and day)</button>
      <div class="chips">${this.state.effects.map((e) => `<span class="fxchip" data-id="${e.id}" title="Click to clear">${e.kind} · ${e.target} ✕</span>`).join('')}</div>`
    this.el.querySelector('#fold')!.addEventListener('click', () => { this.collapsed = !this.collapsed; this.render() })
    const named = () => this.targets().find((t) => t.id === this.target)?.name ?? 'Whole town'
    new Picker(this.el.querySelector<HTMLInputElement>('#target')!, this.el.querySelector<HTMLElement>('#target-results')!, {
      items: () => this.targets(), limit: 200, showAll: true, label: named, onPick: (t) => { this.target = t.id },
    })
    this.el.querySelectorAll<HTMLButtonElement>('[data-fx]').forEach((b) =>
      b.addEventListener('click', () => void this.send('/effects', 'POST', { target: this.target, kind: b.dataset.fx, intensity: Number(b.dataset.i) })))
    this.el.querySelector('#reset')!.addEventListener('click', () => void this.send('/effects', 'DELETE'))
    this.el.querySelector('#calm')!.addEventListener('click', () => void this.send('/calm', 'POST', { on: !this.state.calm }))
    this.el.querySelectorAll<HTMLElement>('.fxchip').forEach((c) => c.addEventListener('click', () => void this.send(`/effects/${c.dataset.id}`, 'DELETE')))
  }
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
