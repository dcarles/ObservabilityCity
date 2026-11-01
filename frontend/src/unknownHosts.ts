import { escapeHtml } from './picker'
import { scopeParams, type Scope } from './scope'
import type { AddedHostSnapshot, UnknownHostSnapshot } from './types'

type UnknownPath = NonNullable<UnknownHostSnapshot['paths']>[number]

/**
 * A links rule line for one path on a gateway host, to complete: the host and the path are filled in, the target is left for you. A gateway is not a
 * service, so the host gets no vendor entry and no ignore line.
 */
export function pathRule(h: UnknownHostSnapshot, p: UnknownPath): string {
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `- { host: '^${esc(h.host)}$', path: '^${esc(p.path)}', target: <system id>, gateway: true }`
}

const callsText = (n: number) => Math.round(n).toLocaleString('en-GB')

/** One row of the panel: the host, how many calls, who made them and on how many days, with the buttons that add it as a vendor, as one of our own or ignore it. A gateway host lists its unexplained paths instead. */
export function unknownHostRow(h: UnknownHostSnapshot, index: number, showVendors = true): string {
  const head = `<div><b>${escapeHtml(h.host)}</b> <span class="dim">· about ${callsText(h.calls)} calls · ${h.days} day${h.days === 1 ? '' : 's'}</span></div>
    <div class="dim">called by ${escapeHtml(h.callers.join(', '))}</div>`
  if (h.gateway) {
    const paths = (h.paths ?? []).filter((p) => showVendors || !p.vendorsOnly)
    return `<li data-host="${escapeHtml(h.host)}" data-gateway="true">${head}
    <div class="dim">A gateway: no rule explains these paths</div>
    <ul class="paths">${paths.map((p, j) => `<li data-path="${escapeHtml(p.path)}"><span>${escapeHtml(p.path || '(no path)')}</span> <span class="dim">· about ${callsText(p.calls)} calls</span>
      <button data-copy="path" data-i="${index}" data-j="${j}">Copy path rule</button></li>`).join('')}</ul></li>`
  }
  return `<li data-host="${escapeHtml(h.host)}">${head}
    <div class="actions">${h.vendorsOnly ? '' : `<button data-add="vendor" data-i="${index}">Add vendor</button><button data-add="internal" data-i="${index}">Add internal</button>`}<button data-add="ignore" data-i="${index}">Ignore</button></div></li>`
}

/** The words on the panel's button: the unknown hosts on show, and how many were added from the panel. */
export function panelLabel(unknown: number, added: number, open: boolean): string {
  const hosts = `${unknown} unknown host${unknown === 1 ? '' : 's'}`
  return `${added > 0 ? `${hosts} · ${added} added` : hosts} ${open ? '▴' : '▾'}`
}

/** One entry of the "Added from this panel" list, with its Remove button. */
export function addedRow(a: AddedHostSnapshot, index: number): string {
  const kind = a.kind === 'internal' ? 'internal' : a.kind === 'ignore' ? 'ignored' : 'vendor'
  return `<li data-added="${escapeHtml(a.host)}"><b>${escapeHtml(a.host)}</b> <span class="dim">· ${kind}</span> <button data-remove="${index}">Remove</button></li>`
}

/**
 * The Unknown hosts button and its panel: the hosts the town's calls go to that no rule explains, grouped by host. It is read from the server on a slow
 * poll and sits next to the Notices button. A plain host can be added as a vendor, as one of our own or ignored: the server saves that, loads the town
 * again, and the host leaves the list. What was added is listed below with a Remove button, and the button stays while there is anything in either list.
 */
export class UnknownHostsPanel {
  private readonly el = document.getElementById('unknown-hosts')!
  private open = false
  private hosts: UnknownHostSnapshot[] = []
  private added: AddedHostSnapshot[] = []
  private showVendors = false
  private error = ''
  private timer: number | undefined

  constructor(private readonly scope: Scope, private readonly copy: (text: string) => Promise<void> = (t) => navigator.clipboard.writeText(t)) {}

  /** Reads now and then every half minute. */
  start(): void {
    void this.refresh()
    this.timer = window.setInterval(() => void this.refresh(), 30_000)
  }

  stop(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer)
  }

  private url(path: string, extra = ''): string {
    const q = scopeParams(this.scope)
    return `${path}?${[q, extra].filter(Boolean).join('&')}`
  }

  async refresh(): Promise<void> {
    try {
      const [hosts, added] = await Promise.all([fetch(this.url('/api/unknown-hosts')), fetch(this.url('/api/added-hosts'))])
      if (hosts.ok) this.hosts = (await hosts.json()) as UnknownHostSnapshot[]
      if (added.ok) this.added = (await added.json()) as AddedHostSnapshot[]
      this.render()
    } catch {
      /* the lists stay as they were; the next read tries again */
    }
  }

  set(hosts: UnknownHostSnapshot[], added: AddedHostSnapshot[] = this.added): void {
    this.hosts = hosts
    this.added = added
    this.render()
  }

  /** Asks the server to add (or remove) a host; it saves, loads the town again and answers with the list of what was added. */
  private async change(request: () => Promise<Response>): Promise<void> {
    try {
      const r = await request()
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string }
        this.error = body.error ?? `The server refused (${r.status}).`
        this.render()
        return
      }
      this.error = ''
      this.added = (await r.json()) as AddedHostSnapshot[]
      await this.refresh()
    } catch {
      this.error = 'The server could not be reached.'
      this.render()
    }
  }

  private visible(): UnknownHostSnapshot[] {
    return this.hosts.filter((h) => this.showVendors || !h.vendorsOnly)
  }

  private render(): void {
    const shown = this.visible()
    const vendorHosts = this.hosts.filter((h) => h.vendorsOnly).length
    this.el.hidden = this.hosts.length === 0 && this.added.length === 0
    this.el.innerHTML = `<button id="unknown-hosts-toggle">${panelLabel(shown.length, this.added.length, this.open)}</button>
      <div class="panel" ${this.open ? '' : 'hidden'}>
        <label class="dim"><input type="checkbox" id="unknown-hosts-vendors" ${this.showVendors ? 'checked' : ''}> Include calls made by Digital Services and vendors${vendorHosts > 0 ? ` (${vendorHosts} more)` : ''}</label>
        ${this.error ? `<div class="error" id="unknown-hosts-error">${escapeHtml(this.error)}</div>` : ''}
        <ul id="unknown-hosts-list">${shown.map((h, i) => unknownHostRow(h, i, this.showVendors)).join('')}</ul>
        ${this.added.length > 0 ? `<div class="dim">Added from this panel</div><ul id="added-hosts-list">${this.added.map(addedRow).join('')}</ul>` : ''}</div>`
    this.el.querySelector('#unknown-hosts-toggle')!.addEventListener('click', () => { this.open = !this.open; this.render() })
    this.el.querySelector('#unknown-hosts-vendors')!.addEventListener('change', (e) => { this.showVendors = (e.target as HTMLInputElement).checked; this.render() })
    this.el.querySelectorAll<HTMLButtonElement>('button[data-add]').forEach((b) =>
      b.addEventListener('click', () => {
        const h = shown[Number(b.dataset.i)]
        if (!h) return
        void this.change(() => fetch(this.url('/api/added-hosts'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: h.host, kind: b.dataset.add }) }))
      }))
    this.el.querySelectorAll<HTMLButtonElement>('button[data-remove]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = this.added[Number(b.dataset.remove)]
        if (!a) return
        void this.change(() => fetch(this.url('/api/added-hosts', `host=${encodeURIComponent(a.host)}`), { method: 'DELETE' }))
      }))
    this.el.querySelectorAll<HTMLButtonElement>('button[data-copy="path"]').forEach((b) =>
      b.addEventListener('click', async () => {
        const h = shown[Number(b.dataset.i)]
        const path = (h?.paths ?? []).filter((p) => this.showVendors || !p.vendorsOnly)[Number(b.dataset.j)]
        if (!h || !path) return
        await this.copy(pathRule(h, path))
        b.textContent = 'Copied'
        window.setTimeout(() => { b.textContent = 'Copy path rule' }, 1500)
      }))
  }
}
