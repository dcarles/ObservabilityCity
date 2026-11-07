import { LEGEND_TABS, type LegendEntry, type TabId } from './legend'
import { iconHtml } from './legendIcons'
import { legendFor } from './legendWords'
import { escapeHtml } from './picker'

const entryHtml = (e: LegendEntry): string => `
  <div class="entry" data-id="${e.id}">
    <i class="swatch ${e.tone}">${iconHtml(e.icon)}</i>
    <div class="words">
      <b>${escapeHtml(e.sees)}</b>
      <span>${escapeHtml(e.means)}</span>
      ${e.more ? `<details><summary>more</summary><p>${escapeHtml(e.more)}</p></details>` : ''}
    </div>
  </div>`

/** The card that says what everything in the town means, in tabs. Opened by the "?" button, and by itself the first time a browser visits. */
export class LegendCard {
  private readonly el = document.getElementById('legend') as HTMLElement
  private tab: TabId = 'problems'

  constructor(private readonly onChange: (open: boolean) => void = () => {}, themeId = 'harbour-town') {
    const sections = legendFor(themeId)
    this.el.innerHTML = `
      <div class="head"><b>What you are looking at</b><button id="legend-close" title="Close (Esc)" aria-label="Close">✕</button></div>
      <div class="tabs" role="tablist" aria-label="Legend">${LEGEND_TABS.map((t) => `
        <button class="tab" role="tab" id="legend-tab-${t.id}" data-tab="${t.id}" aria-controls="legend-panel-${t.id}" aria-selected="false" tabindex="-1"><span class="ti" aria-hidden="true">${t.icon}</span><span>${escapeHtml(t.title)}</span></button>`).join('')}
      </div>
      ${LEGEND_TABS.map((t) => `
        <div class="panel-tab scroll" role="tabpanel" id="legend-panel-${t.id}" data-panel="${t.id}" aria-labelledby="legend-tab-${t.id}" hidden>
          <p class="blurb">${escapeHtml(t.blurb)}</p>
          <div class="cols">${sections.filter((s) => s.tab === t.id).map((s) => `
            <section data-section="${s.id}"><h4>${escapeHtml(s.title)}</h4>${s.entries.map(entryHtml).join('')}</section>`).join('')}
          </div>
        </div>`).join('')}`
    this.el.querySelector('#legend-close')!.addEventListener('click', () => this.close())
    const tabs = [...this.el.querySelectorAll<HTMLButtonElement>('.tab')]
    for (const b of tabs) b.addEventListener('click', () => this.select(b.dataset.tab as TabId, false))
    this.el.querySelector('.tabs')!.addEventListener('keydown', (ev) => {
      const k = (ev as KeyboardEvent).key
      if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'Home' && k !== 'End') return
      ev.preventDefault()
      const at = tabs.findIndex((b) => b.dataset.tab === this.tab)
      const next = k === 'Home' ? 0 : k === 'End' ? tabs.length - 1 : (at + (k === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      this.select(tabs[next].dataset.tab as TabId, true)
    })
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen) this.close() })
    this.select('problems', false)
  }

  get isOpen(): boolean {
    return !this.el.hidden
  }

  get current(): TabId {
    return this.tab
  }

  /** Shows one tab. The card always opens on the first one (Problems). */
  select(id: TabId, focus: boolean): void {
    this.tab = id
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.tab')) {
      const on = b.dataset.tab === id
      b.setAttribute('aria-selected', String(on))
      b.tabIndex = on ? 0 : -1
      if (on && focus) b.focus()
    }
    for (const p of this.el.querySelectorAll<HTMLElement>('.panel-tab')) p.hidden = p.dataset.panel !== id
  }

  open(): void {
    if (this.isOpen) return
    this.select('problems', false)
    this.el.hidden = false
    this.onChange(true)
  }

  close(): void {
    if (!this.isOpen) return
    this.el.hidden = true
    this.onChange(false)
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else this.open()
  }
}
