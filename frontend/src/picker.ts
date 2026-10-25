/** One line in a search or dropdown list. */
export interface PickItem {
  kind: 'town' | 'island' | 'building'
  id: string
  name: string
  /** The island's name, or the island a building stands on. */
  where: string
  state?: string
}

/**
 * The items that match what was typed, best first. Every word has to appear in the name, id or island; names that start with
 * the text come first, then names that contain every word, then islands before buildings. With nothing typed, `all` decides
 * between everything (a dropdown) and nothing (a search box).
 */
export function rankItems<T extends PickItem>(items: T[], query: string, limit: number, all = false): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return all ? items.slice(0, limit) : []
  const words = q.split(/\s+/)
  const score = (i: T) => {
    const hay = `${i.name} ${i.id} ${i.where}`.toLowerCase()
    if (!words.every((w) => hay.includes(w))) return -1
    const own = `${i.name} ${i.id}`.toLowerCase()
    return (own.startsWith(q) ? 4 : 0) + (words.every((w) => own.includes(w)) ? 2 : 0) + (i.kind === 'island' ? 1 : 0)
  }
  return items
    .map((i) => ({ i, s: score(i) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i.name.localeCompare(b.i.name))
    .slice(0, limit)
    .map((x) => x.i)
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

export interface PickerOptions<T extends PickItem> {
  items: () => T[]
  onPick: (item: T) => void
  /** Rows shown at most. */
  limit: number
  /** A dropdown lists everything while nothing is typed; a search box lists nothing. */
  showAll?: boolean
  /** A search box empties after a pick; a dropdown shows what was picked. */
  label?: () => string
}

/**
 * The type-to-filter list shared by the top bar's search and the Try it panel's Target. Typing filters, arrow keys and Enter
 * pick, Escape closes. The list is a sibling element the page provides, so it sits where the page wants it.
 */
export class Picker<T extends PickItem> {
  private matches: T[] = []
  private active = 0

  constructor(private readonly input: HTMLInputElement, private readonly list: HTMLElement, private readonly o: PickerOptions<T>) {
    input.addEventListener('input', () => this.update())
    input.addEventListener('focus', () => { if (o.label) input.select(); this.update() })
    input.addEventListener('click', () => this.update())
    input.addEventListener('blur', () => window.setTimeout(() => { this.close(); this.reset() }, 120))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { this.active = Math.min(this.matches.length - 1, this.active + 1); this.draw(); e.preventDefault() }
      else if (e.key === 'ArrowUp') { this.active = Math.max(0, this.active - 1); this.draw(); e.preventDefault() }
      else if (e.key === 'Enter' && this.matches[this.active]) { this.pick(this.matches[this.active]); e.preventDefault() }
      else if (e.key === 'Escape') { this.close(); this.reset(); input.blur() }
    })
    this.reset()
  }

  /** Shows the picked label again (a dropdown) or an empty box (a search). */
  private reset(): void {
    this.input.value = this.o.label?.() ?? ''
  }

  private update(): void {
    // a dropdown that was just opened shows everything, even though its box holds the picked name
    const typed = this.o.label && this.input.value === this.o.label() ? '' : this.input.value
    this.matches = rankItems(this.o.items(), typed, this.o.limit, this.o.showAll)
    this.active = 0
    this.draw()
  }

  private draw(): void {
    this.list.hidden = this.matches.length === 0
    this.list.innerHTML = this.matches
      .map((m, i) => `<div class="hit ${i === this.active ? 'active' : ''}" data-i="${i}"><b>${escapeHtml(m.name)}</b><span>${escapeHtml(m.kind === 'island' ? 'island' : m.kind === 'town' ? '' : m.where)}</span></div>`)
      .join('')
    this.list.querySelectorAll<HTMLElement>('.hit').forEach((el) =>
      el.addEventListener('mousedown', (e) => { e.preventDefault(); this.pick(this.matches[Number(el.dataset.i)]) }))
    this.list.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }

  private close(): void {
    this.matches = []
    this.list.hidden = true
  }

  private pick(item: T): void {
    this.o.onPick(item)
    this.close()
    this.reset()
    this.input.blur()
  }
}
