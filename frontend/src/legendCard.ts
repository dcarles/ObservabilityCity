import { LEGEND } from './legend'
import { escapeHtml } from './picker'

/** The card that says what everything in the town means. Opened by the "?" button, and by itself the first time a browser visits. */
export class LegendCard {
  private readonly el = document.getElementById('legend') as HTMLElement

  constructor(private readonly onChange: (open: boolean) => void = () => {}) {
    this.el.innerHTML = `
      <div class="head"><b>What you are looking at</b><button id="legend-close" title="Close (Esc)">✕</button></div>
      <div class="scroll">${LEGEND.map((s) => `
        <h4>${escapeHtml(s.title)}</h4>
        ${s.entries.map((e) => `<div class="entry" data-id="${e.id}"><i class="swatch ${e.tone}"></i><div><b>${escapeHtml(e.sees)}</b><span>${escapeHtml(e.means)}</span></div></div>`).join('')}`).join('')}
      </div>`
    this.el.querySelector('#legend-close')!.addEventListener('click', () => this.close())
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen) this.close() })
  }

  get isOpen(): boolean {
    return !this.el.hidden
  }

  open(): void {
    if (this.isOpen) return
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
