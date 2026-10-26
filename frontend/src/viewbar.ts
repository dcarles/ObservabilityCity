import type { EnvironmentInfo, Snapshot, TenantInfo } from './types'
import { escapeHtml } from './picker'
import { groupTenants, tenantLabel, tenantTrouble, toggleTenant, type TenantView } from './tenants'

/** What the view bar needs from the page. */
export interface ViewBarHost {
  /** The environment the page asked for (null for the default). */
  env: string | null
  view(): TenantView
  setView(v: TenantView): void
  switchEnv(id: string): void
}

type Open = 'env' | 'tenant' | null

/**
 * The two dropdowns in the top bar: the environment, and the tenants to follow. It lives outside the halves of the bar that are redrawn with
 * every snapshot, so an open list keeps its place and its typed text, and it only redraws when what it shows has changed.
 */
export class ViewBar {
  private readonly el = document.getElementById('view-bar') as HTMLElement
  private open: Open = null
  private query = ''
  private key = ''
  private environments: EnvironmentInfo[] = []
  private current = ''
  private tenants: TenantInfo[] = []
  private trouble = new Map<string, 'amber' | 'red'>()

  constructor(private readonly host: ViewBarHost) {
    document.addEventListener('pointerdown', (e) => {
      if (this.open && !(e.target as HTMLElement).closest('#view-bar')) this.close()
    })
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close() })
    this.el.addEventListener('click', (e) => this.click(e.target as HTMLElement))
    this.el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement
      if (t.id !== 'tenant-query') return
      this.query = t.value
      this.render(true)
    })
  }

  /** The tenants the page can follow, in the order the list shows them. For tests. */
  get listed(): TenantInfo[] {
    return this.tenants
  }

  update(s: Snapshot): void {
    this.environments = s.environments
    this.current = s.environment
    this.tenants = s.tenants
    this.trouble = tenantTrouble(s.groups.flatMap((g) => g.nodes))
    this.render()
  }

  /** Redraws after the view was changed from outside. */
  refresh(): void {
    this.render()
  }

  private close(): void {
    if (!this.open) return
    this.open = null
    this.query = ''
    this.render()
  }

  private click(t: HTMLElement): void {
    const act = t.closest<HTMLElement>('[data-act]')
    if (!act) return
    const view = this.host.view()
    switch (act.dataset.act) {
      case 'open-env': this.open = this.open === 'env' ? null : 'env'; this.query = ''; this.render(); break
      case 'open-tenant': this.open = this.open === 'tenant' ? null : 'tenant'; this.query = ''; this.render(); break
      case 'env': this.open = null; if (act.dataset.id !== this.current) this.host.switchEnv(act.dataset.id!); else this.render(); break
      case 'tenant': this.host.setView(toggleTenant(view, act.dataset.id!)); break
      case 'all': this.host.setView({ ...view, tenants: [] }); break
      case 'hide-test': this.host.setView({ ...view, hideTest: !view.hideTest }); break
    }
  }

  private render(keepFocus = false): void {
    const view = this.host.view()
    const key = JSON.stringify([this.open, this.query, this.current, this.environments, this.tenants.map((t) => t.id + t.kind), view, [...this.trouble]])
    if (key === this.key) return
    this.key = key
    const envName = this.environments.find((e) => e.id === this.current)?.name ?? this.current
    const envBtn = this.environments.length > 1
      ? `<div class="vb"><button data-act="open-env" id="env-button" class="vb-btn ${this.open === 'env' ? 'on' : ''}" title="Environment">${escapeHtml(envName)} <i>▾</i></button>
          ${this.open === 'env' ? `<div class="vb-list" id="env-list">${this.environments.map((e) => `<div class="vb-row ${e.id === this.current ? 'sel' : ''}" data-act="env" data-id="${escapeHtml(e.id)}"><span>${escapeHtml(e.name)}</span><small>${escapeHtml(e.id)}${e.isDefault ? ' · default' : ''}</small></div>`).join('')}</div>` : ''}</div>`
      : ''
    const tenantBtn = this.tenants.length > 0
      ? `<div class="vb"><button data-act="open-tenant" id="tenant-button" class="vb-btn ${this.open === 'tenant' ? 'on' : ''}" title="Tenants to show">${escapeHtml(tenantLabel(view, this.tenants))} <i>▾</i></button>
          ${this.open === 'tenant' ? this.tenantList(view) : ''}</div>`
      : ''
    this.el.innerHTML = envBtn + tenantBtn
    if (keepFocus) {
      const input = this.el.querySelector<HTMLInputElement>('#tenant-query')
      if (input) { input.focus(); input.setSelectionRange(this.query.length, this.query.length) }
    } else if (this.open === 'tenant') this.el.querySelector<HTMLInputElement>('#tenant-query')?.focus()
  }

  private tenantList(view: TenantView): string {
    const groups = groupTenants(this.tenants, this.query)
    const row = (t: TenantInfo) => {
      const on = view.tenants.includes(t.id)
      const trouble = this.trouble.get(t.id)
      const same = t.name === t.id
      return `<div class="vb-row ${on ? 'sel' : ''}" data-act="tenant" data-id="${escapeHtml(t.id)}"><input type="checkbox" ${on ? 'checked' : ''} tabindex="-1" /><span>${escapeHtml(t.name)}${trouble ? ` <b class="dot ${trouble}" title="${trouble === 'red' ? 'Throttled right now' : 'Under pressure right now'}"></b>` : ''}</span>${same ? '' : `<small>${escapeHtml(t.id)}</small>`}</div>`
    }
    return `<div class="vb-list wide" id="tenant-list">
      <input id="tenant-query" type="search" placeholder="Find a tenant by name or id" value="${escapeHtml(this.query)}" autocomplete="off" spellcheck="false" />
      <div class="vb-row ${view.tenants.length === 0 ? 'sel' : ''}" data-act="all"><span>All tenants</span></div>
      <label class="vb-row" data-act="hide-test"><input type="checkbox" id="hide-test" ${view.hideTest ? 'checked' : ''} tabindex="-1" /><span>Hide test tenants</span></label>
      ${groups.map((g) => `<div class="vb-group">${g.title}</div>${g.tenants.map(row).join('')}`).join('') || '<div class="vb-none">No tenant matches.</div>'}
    </div>`
  }
}
