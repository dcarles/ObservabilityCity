import { escapeHtml } from './picker'
import { scopeParams, type Scope } from './scope'
import type { UnknownHostSnapshot } from './types'

/** A third_parties.yaml line for a host: a vendor that owns the host and is called by the systems seen calling it. Nothing is created by itself; this is a copy-paste start. */
export function vendorEntry(h: UnknownHostSnapshot): string {
  const slug = h.host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `- { id: ext.${slug}, name: ${h.host}, domains: [${h.host}], calledBy: [${h.callers.join(', ')}] }`
}

/** An ignoreHosts line that matches exactly this host, for platform noise that should not be listed or drawn. */
export function ignoreLine(h: UnknownHostSnapshot): string {
  return `- '^${h.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$'`
}

/** One row of the panel: the host, how many calls, who made them and on how many days, with the two copy buttons. */
export function unknownHostRow(h: UnknownHostSnapshot, index: number): string {
  const calls = Math.round(h.calls).toLocaleString('en-GB')
  return `<li data-host="${escapeHtml(h.host)}"><div><b>${escapeHtml(h.host)}</b> <span class="dim">· about ${calls} calls · ${h.days} day${h.days === 1 ? '' : 's'}</span></div>
    <div class="dim">called by ${escapeHtml(h.callers.join(', '))}</div>
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

  private render(): void {
    this.el.hidden = this.hosts.length === 0
    const n = this.hosts.length
    this.el.innerHTML = `<button id="unknown-hosts-toggle">${n} unknown host${n === 1 ? '' : 's'} ${this.open ? '▴' : '▾'}</button>
      <ul ${this.open ? '' : 'hidden'}>${this.hosts.map(unknownHostRow).join('')}</ul>`
    this.el.querySelector('#unknown-hosts-toggle')!.addEventListener('click', () => { this.open = !this.open; this.render() })
    this.el.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        const h = this.hosts[Number(b.dataset.i)]
        if (!h) return
        await this.copy(b.dataset.copy === 'vendor' ? vendorEntry(h) : ignoreLine(h))
        b.textContent = 'Copied'
        window.setTimeout(() => { b.textContent = b.dataset.copy === 'vendor' ? 'Copy vendor entry' : 'Copy ignore line' }, 1500)
      }))
  }
}
