import { escapeHtml } from './picker'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

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

