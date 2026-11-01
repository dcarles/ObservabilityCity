import { escapeHtml } from './picker'
import { scopeParams, type Scope } from './scope'
import type { UnknownHostSnapshot } from './types'

type UnknownPath = NonNullable<UnknownHostSnapshot['paths']>[number]

/** A third_parties.yaml line for a host: a vendor that owns the host and is called by the systems seen calling it. Nothing is created by itself; this is a copy-paste start. */
export function vendorEntry(h: UnknownHostSnapshot): string {
  const slug = h.host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `- { id: ext.${slug}, name: ${h.host}, domains: [${h.host}], calledBy: [${h.callers.join(', ')}] }`
}

/** An ignoreHosts line that matches exactly this host, for platform noise that should not be listed or drawn. */
export function ignoreLine(h: UnknownHostSnapshot): string {
  return `- '^${h.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$'`
}

/**
 * A links rule line for one path on a gateway host, to complete: the host and the path are filled in, the target is left for you. A gateway is not a
 * service, so the host gets no vendor entry and no ignore line.
 */
export function pathRule(h: UnknownHostSnapshot, p: UnknownPath): string {
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `- { host: '^${esc(h.host)}$', path: '^${esc(p.path)}', target: <system id>, gateway: true }`
}

const callsText = (n: number) => Math.round(n).toLocaleString('en-GB')

/** One row of the panel: the host, how many calls, who made them and on how many days, with the two copy buttons. A gateway host lists its unexplained paths instead. */
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
    <div class="actions"><button data-copy="vendor" data-i="${index}">Copy vendor entry</button><button data-copy="ignore" data-i="${index}">Copy ignore line</button></div></li>`
}

/**
 * The Unknown hosts button and its panel: the hosts the town's calls go to that no rule explains, grouped by host. It is read from the server on a slow
 * poll, shown only when there is something to see, and next to the Notices button. Nothing here changes the config: the two buttons only copy a line.
 */
export class UnknownHostsPanel {
  private readonly el = document.getElementById('unknown-hosts')!
  private open = false
  private hosts: UnknownHostSnapshot[] = []
  private showVendors = false
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

  async refresh(): Promise<void> {
    try {
      const q = scopeParams(this.scope)
      const r = await fetch(`/api/unknown-hosts${q ? `?${q}` : ''}`)
      if (r.ok) this.set((await r.json()) as UnknownHostSnapshot[])
    } catch {
      /* the list stays as it was; the next read tries again */
    }
  }

  set(hosts: UnknownHostSnapshot[]): void {
    this.hosts = hosts
    this.render()
  }

  /** The hosts on screen: those only vendor buildings (such as Digital Services) called are left out until the box is ticked. */
  private visible(): UnknownHostSnapshot[] {
    return this.hosts.filter((h) => this.showVendors || !h.vendorsOnly)
  }

  private render(): void {
    const shown = this.visible()
    const vendorHosts = this.hosts.length - this.hosts.filter((h) => !h.vendorsOnly).length
    this.el.hidden = this.hosts.length === 0
    const n = shown.length
    this.el.innerHTML = `<button id="unknown-hosts-toggle">${n} unknown host${n === 1 ? '' : 's'} ${this.open ? '▴' : '▾'}</button>
      <div class="panel" ${this.open ? '' : 'hidden'}>
        <label class="dim"><input type="checkbox" id="unknown-hosts-vendors" ${this.showVendors ? 'checked' : ''}> Include calls made by Digital Services and vendors${vendorHosts > 0 ? ` (${vendorHosts} more)` : ''}</label>
        <ul>${shown.map((h, i) => unknownHostRow(h, i, this.showVendors)).join('')}</ul></div>`
    this.el.querySelector('#unknown-hosts-toggle')!.addEventListener('click', () => { this.open = !this.open; this.render() })
    this.el.querySelector('#unknown-hosts-vendors')!.addEventListener('change', (e) => { this.showVendors = (e.target as HTMLInputElement).checked; this.render() })
    const labels: Record<string, string> = { vendor: 'Copy vendor entry', ignore: 'Copy ignore line', path: 'Copy path rule' }
    this.el.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        const h = shown[Number(b.dataset.i)]
        if (!h) return
        const kind = b.dataset.copy!
        const path = kind === 'path' ? (h.paths ?? []).filter((p) => this.showVendors || !p.vendorsOnly)[Number(b.dataset.j)] : undefined
        if (kind === 'path' && !path) return
        await this.copy(kind === 'vendor' ? vendorEntry(h) : kind === 'ignore' ? ignoreLine(h) : pathRule(h, path!))
        b.textContent = 'Copied'
        window.setTimeout(() => { b.textContent = labels[kind] }, 1500)
      }))
  }
}
