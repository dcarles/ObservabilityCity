import type { EnvironmentInfo, Snapshot, TenantInfo } from './types'
import { escapeHtml } from './picker'
import { groupTenants, tenantLabel, tenantTrouble, toggleTenant, type TenantView } from './tenants'
import { islandChoices, islandsLabel, searchIslands, type IslandChoice } from './islands'
import { LAYERS, layersLabel, type Layer, type LayerState } from './layers'
import { THEMES, type ThemeInfo } from './themes'
import { QUALITIES, qualityName, type Quality } from './quality'
import type { TownChoice } from './scope'

/** What the view bar needs from the page. */
export interface ViewBarHost {
  /** The towns the server runs (none or one means there is nothing to switch to). */
  towns(): TownChoice[]
  switchTown(town: TownChoice): void
  view(): TenantView
  setView(v: TenantView): void
  switchEnv(id: string): void
  /** The islands chosen (none means all of them). */
  islands(): readonly string[]
  setIslands(ids: string[]): void
  layers(): LayerState
  toggleLayer(layer: Layer): void
  /** The island or vendor the dependency arcs are focused on (empty for all). */
  focus(): string
  setFocus(id: string): void
  theme(): ThemeInfo
  setTheme(id: string): void
  quality(): Quality
  setQuality(q: Quality): void
}

type Open = 'town' | 'env' | 'tenant' | 'islands' | 'layers' | 'theme' | 'quality' | null

/**
 * The dropdowns in the top bar: the town, the environment, the tenants and the islands to look at, the layers to draw, the theme and the quality. It lives outside the
 * halves of the bar that are redrawn with every snapshot, so an open list keeps its place and its typed text, and it only redraws when what it shows
 * has changed.
 */
export class ViewBar {
  private readonly el = document.getElementById('view-bar') as HTMLElement
  private open: Open = null
  private query = ''
  private key = ''
  private environments: EnvironmentInfo[] = []
  private current = ''
  private townId = ''
  private townName = ''
  private tenants: TenantInfo[] = []
  private choices: IslandChoice[] = []
  /** The islands and the vendors, for the dependency focus. */
  private focusChoices: IslandChoice[] = []
  private trouble = new Map<string, 'amber' | 'red'>()

  constructor(private readonly host: ViewBarHost) {
    document.addEventListener('pointerdown', (e) => {
      if (this.open && !(e.target as HTMLElement).closest('#view-bar')) this.close()
    })
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close() })
    this.el.addEventListener('click', (e) => this.click(e.target as HTMLElement))
    this.el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement
      if (t.id !== 'tenant-query' && t.id !== 'island-query') return
      this.query = t.value
      this.render(true)
    })
  }

  /** The tenants the page can follow, in the order the list shows them. For tests. */
  get listed(): TenantInfo[] {
    return this.tenants
  }

  /** Every island of the town, on screen or not. For tests. */
  get islandList(): IslandChoice[] {
    return this.choices
  }

  update(s: Snapshot): void {
    this.environments = s.environments
    this.current = s.environment
    this.townId = s.townId
    this.townName = s.townName
    this.tenants = s.tenants
    this.choices = islandChoices(s)
    this.focusChoices = [...this.choices, ...s.vendors.map((v) => ({ id: v.node.id, name: v.node.name, shown: true }))]
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

  private toggle(which: Exclude<Open, null>): void {
    this.open = this.open === which ? null : which
    this.query = ''
    this.render()
  }

  private click(t: HTMLElement): void {
    const act = t.closest<HTMLElement>('[data-act]')
    if (!act) return
    const view = this.host.view()
    switch (act.dataset.act) {
      case 'open-town': this.toggle('town'); break
      case 'open-env': this.toggle('env'); break
      case 'open-tenant': this.toggle('tenant'); break
      case 'open-islands': this.toggle('islands'); break
      case 'open-layers': this.toggle('layers'); break
      case 'open-theme': this.toggle('theme'); break
      case 'open-quality': this.toggle('quality'); break
      case 'town': {
        this.open = null
        const town = this.host.towns().find((t) => t.id === act.dataset.id)
        if (town && town.id !== this.townId) this.host.switchTown(town)
        else this.render()
        break
      }
      case 'quality': this.open = null; this.host.setQuality(act.dataset.id as Quality); this.render(); break
      case 'env': this.open = null; if (act.dataset.id !== this.current) this.host.switchEnv(act.dataset.id!); else this.render(); break
      case 'tenant': this.host.setView(toggleTenant(view, act.dataset.id!)); break
      case 'all': this.host.setView({ ...view, tenants: [] }); break
      case 'hide-test': this.host.setView({ ...view, hideTest: !view.hideTest }); break
      case 'island': {
        const id = act.dataset.id!
        const now = this.host.islands()
        this.host.setIslands(now.includes(id) ? now.filter((x) => x !== id) : [...now, id])
        break
      }
      case 'all-islands': this.host.setIslands([]); break
      case 'layer': this.host.toggleLayer(act.dataset.id as Layer); break
      case 'focus': this.host.setFocus(act.dataset.id ?? ''); break
      case 'theme': this.open = null; this.host.setTheme(act.dataset.id!); this.render(); break
    }
  }

  private render(keepFocus = false): void {
    const view = this.host.view()
    const islands = this.host.islands()
    const layers = this.host.layers()
    const theme = this.host.theme()
    const towns = this.host.towns()
    const quality = this.host.quality()
    const key = JSON.stringify([this.open, this.query, this.townId, towns, quality, this.current, this.environments, this.tenants.map((t) => t.id + t.kind), view, [...this.trouble], this.choices, this.focusChoices, this.host.focus(), islands, layers, theme.id])
    if (key === this.key) return
    this.key = key
    const envName = this.environments.find((e) => e.id === this.current)?.name ?? this.current
    const button = (act: string, id: string, label: string, title: string, on: boolean) =>
      `<button data-act="${act}" id="${id}" class="vb-btn ${on ? 'on' : ''}" title="${title}">${escapeHtml(label)} <i>▾</i></button>`
    const townBtn = towns.length > 1
      ? `<div class="vb">${button('open-town', 'town-button', this.townName || this.townId, 'Town', this.open === 'town')}
          ${this.open === 'town' ? `<div class="vb-list" id="town-list">${towns.map((t) => `<div class="vb-row ${t.id === this.townId ? 'sel' : ''}" data-act="town" data-id="${escapeHtml(t.id)}"><span>${escapeHtml(t.name)}</span><small>${escapeHtml(t.id)}${t.isDefault ? ' · default' : ''}</small></div>`).join('')}</div>` : ''}</div>`
      : ''
    const envBtn = this.environments.length > 1
      ? `<div class="vb">${button('open-env', 'env-button', envName, 'Environment', this.open === 'env')}
          ${this.open === 'env' ? `<div class="vb-list" id="env-list">${this.environments.map((e) => `<div class="vb-row ${e.id === this.current ? 'sel' : ''}" data-act="env" data-id="${escapeHtml(e.id)}"><span>${escapeHtml(e.name)}</span><small>${escapeHtml(e.id)}${e.isDefault ? ' · default' : ''}</small></div>`).join('')}</div>` : ''}</div>`
      : ''
    const tenantBtn = this.tenants.length > 0
      ? `<div class="vb">${button('open-tenant', 'tenant-button', tenantLabel(view, this.tenants), 'Tenants to show', this.open === 'tenant')}
          ${this.open === 'tenant' ? this.tenantList(view) : ''}</div>`
      : ''
    const islandBtn = this.choices.length > 1
      ? `<div class="vb">${button('open-islands', 'islands-button', islandsLabel(islands, this.choices), 'Islands to show. The numbers in the top bar count only what is on screen', this.open === 'islands')}
          ${this.open === 'islands' ? this.islandRows(islands) : ''}</div>`
      : ''
    const layerBtn = `<div class="vb">${button('open-layers', 'layers-button', layersLabel(layers), 'Layers to draw', this.open === 'layers')}
          ${this.open === 'layers' ? `<div class="vb-list" id="layers-list">${LAYERS.map((l) => `<div class="vb-row" data-act="layer" data-id="${l.id}" id="layer-${l.id}"><input type="checkbox" ${layers[l.id] ? 'checked' : ''} tabindex="-1" /><span>${l.label}<br /><small class="hint">${escapeHtml(l.hint)}</small></span></div>`).join('')}${layers.dependencies ? this.focusRows() : ''}</div>` : ''}</div>`
    const themeBtn = `<div class="vb">${button('open-theme', 'theme-button', theme.name, 'Theme', this.open === 'theme')}
          ${this.open === 'theme' ? `<div class="vb-list" id="theme-list">${THEMES.map((th) => `<div class="vb-row ${th.id === theme.id ? 'sel' : ''}" data-act="theme" data-id="${th.id}"><span>${escapeHtml(th.name)}<br /><small class="hint">${escapeHtml(th.blurb)}</small></span></div>`).join('')}</div>` : ''}</div>`
    const qualityBtn = `<div class="vb">${button('open-quality', 'quality-button', qualityName(quality), 'Quality: how much detail the town is drawn with. Lower it on a weak PC', this.open === 'quality')}
          ${this.open === 'quality' ? `<div class="vb-list" id="quality-list">${QUALITIES.map((q) => `<div class="vb-row ${q.id === quality ? 'sel' : ''}" data-act="quality" data-id="${q.id}"><span>${escapeHtml(q.name)}<br /><small class="hint">${escapeHtml(q.hint)}</small></span></div>`).join('')}</div>` : ''}</div>`
    this.el.innerHTML = townBtn + envBtn + tenantBtn + islandBtn + layerBtn + themeBtn + qualityBtn
    if (keepFocus) {
      const input = this.el.querySelector<HTMLInputElement>('.vb-list input[type=search]')
      if (input) { input.focus(); input.setSelectionRange(this.query.length, this.query.length) }
    } else if (this.open === 'tenant' || this.open === 'islands') this.el.querySelector<HTMLInputElement>('.vb-list input[type=search]')?.focus()
  }

  /** Under the layers: which island or vendor the dependency arcs focus on. Only offered while the arcs are drawn. */
  private focusRows(): string {
    const focus = this.host.focus()
    const row = (id: string, name: string) => `<div class="vb-row ${focus === id ? 'sel' : ''}" data-act="focus" data-id="${escapeHtml(id)}" id="focus-${escapeHtml(id || 'all')}"><span>${escapeHtml(name)}</span></div>`
    return `<div class="vb-group">Dependencies: focus on</div>${row('', 'All islands')}${this.focusChoices.map((c) => row(c.id, c.name)).join('')}`
  }

  private islandRows(selected: readonly string[]): string {
    const rows = searchIslands(this.choices, this.query)
    const row = (c: IslandChoice) => {
      const on = selected.includes(c.id)
      return `<div class="vb-row ${on ? 'sel' : ''}" data-act="island" data-id="${escapeHtml(c.id)}"><input type="checkbox" ${on ? 'checked' : ''} tabindex="-1" /><span>${escapeHtml(c.name)}</span><small>${c.shown ? escapeHtml(c.id) : `${escapeHtml(c.id)} · hidden`}</small></div>`
    }
    return `<div class="vb-list wide" id="islands-list">
      <input id="island-query" type="search" placeholder="Find an island by name or id" value="${escapeHtml(this.query)}" autocomplete="off" spellcheck="false" />
      <div class="vb-row ${selected.length === 0 ? 'sel' : ''}" data-act="all-islands"><span>All islands</span></div>
      ${rows.map(row).join('') || '<div class="vb-none">No island matches.</div>'}
    </div>`
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
