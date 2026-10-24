import type { Snapshot, NodeSnapshot } from './types'
import type { ConnectionState } from './connection'
import { formatMs, formatRate } from './visuals'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

export class TopBar {
  private readonly el = $('topbar')
  private status: ConnectionState = 'connecting'
  private snap: Snapshot | null = null

  constructor(private readonly onHome: () => void) {
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
    const label = { connecting: 'Connecting…', live: 'Live (demo data)', reconnecting: 'Reconnecting…', offline: 'Backend offline' }[this.status]
    const dot = this.status === 'live' ? 'live' : this.status === 'offline' ? '' : 'wait'
    const day = s ? clock(s.dayFraction) : ''
    this.el.innerHTML = `
      <span class="brand">Observability City</span>
      ${s ? `<span class="town">${s.townName}</span>` : ''}
      <span class="spacer"></span>
      ${t ? `
        <div class="chip"><b>${formatRate(t.requestsPerSecond)}</b><span>req/s</span></div>
        <div class="chip ${t.errorRate >= 0.05 ? 'bad' : t.errorRate >= 0.01 ? 'warn' : ''}"><b>${(t.errorRate * 100).toFixed(1)}%</b><span>errors</span></div>
        <div class="chip"><b>${formatMs(t.p99Ms)}</b><span>p99</span></div>
        <div class="chip ${t.degraded ? 'warn' : ''}"><b>${t.degraded}</b><span>degraded</span></div>
        <div class="chip ${t.down ? 'bad' : ''}"><b>${t.down}</b><span>down</span></div>
        <div class="chip"><b>${day}</b><span>town time</span></div>` : ''}
      <span class="status"><i class="dot ${dot}"></i>${label}</span>
      <button id="home" title="Frame the whole town">Home</button>`
    this.el.querySelector('#home')!.addEventListener('click', this.onHome)
  }
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

  constructor(private nodes: () => { id: string; name: string; group: string }[]) {}

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
    const options = [{ id: '*', name: 'Whole town' }, ...[...new Set(this.nodes().map((n) => n.group))].map((g) => ({ id: g, name: `Island: ${g}` })), ...this.nodes().map((n) => ({ id: n.id, name: n.name }))]
    this.el.dataset.collapsed = String(this.collapsed)
    this.el.innerHTML = `
      <div class="head"><h3>Try it (preview)</h3><button id="fold">${this.collapsed ? '▾' : '▴'}</button></div>
      <p class="note">Temporary controls for this slice. The final Break things panel comes later.</p>
      <label>Target</label>
      <select id="target">${options.map((o) => `<option value="${o.id}" ${o.id === this.target ? 'selected' : ''}>${o.name}</option>`).join('')}</select>
      <div class="grid">
        <button data-fx="Traffic" data-i="0.8">Traffic spike</button>
        <button data-fx="Latency" data-i="0.6">Slow</button>
        <button data-fx="Errors" data-i="0.4">Errors</button>
        <button data-fx="UnhealthyInstances" data-i="0.5">Sick instances</button>
        <button data-fx="HighCpu" data-i="1">High CPU</button>
        <button data-fx="HighMemory" data-i="1">High memory</button>
        <button data-fx="Saturate" data-i="1">DB saturated</button>
        <button data-fx="Down" data-i="1">Down</button>
        <button id="reset">Reset all</button>
      </div>
      <button class="wide ${this.state.calm ? 'on' : ''}" id="calm">Calm (freeze noise and day)</button>
      <div class="chips">${this.state.effects.map((e) => `<span class="fxchip" data-id="${e.id}" title="Click to clear">${e.kind} · ${e.target} ✕</span>`).join('')}</div>`
    this.el.querySelector('#fold')!.addEventListener('click', () => { this.collapsed = !this.collapsed; this.render() })
    this.el.querySelector('#target')!.addEventListener('change', (ev) => { this.target = (ev.target as HTMLSelectElement).value })
    this.el.querySelectorAll<HTMLButtonElement>('[data-fx]').forEach((b) =>
      b.addEventListener('click', () => void this.send('/effects', 'POST', { target: this.target, kind: b.dataset.fx, intensity: Number(b.dataset.i) })))
    this.el.querySelector('#reset')!.addEventListener('click', () => void this.send('/effects', 'DELETE'))
    this.el.querySelector('#calm')!.addEventListener('click', () => void this.send('/calm', 'POST', { on: !this.state.calm }))
    this.el.querySelectorAll<HTMLElement>('.fxchip').forEach((c) => c.addEventListener('click', () => void this.send(`/effects/${c.dataset.id}`, 'DELETE')))
  }
}
