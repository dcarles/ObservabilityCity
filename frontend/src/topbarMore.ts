// The "⋯" button in the top bar: when the bar is so full that it has to give up buttons (the last fit step), Wall, Dashboard and Day/Dusk move into this
// menu instead of disappearing. The items press the real buttons, so nothing here knows what they do.

/** The buttons the menu stands in for, in the order it lists them. */
export const MORE_ITEMS = ['wall-button', 'view-switch', 'lighting'] as const

export function startMoreMenu(): { open(): void; close(): void } {
  const button = document.getElementById('more-button') as HTMLButtonElement
  const menu = document.getElementById('more-menu') as HTMLDivElement
  const close = (): void => { menu.hidden = true; button.setAttribute('aria-expanded', 'false') }
  const open = (): void => {
    menu.replaceChildren(...MORE_ITEMS.flatMap((id) => {
      const source = document.getElementById(id)
      if (!source) return []
      const item = document.createElement('button')
      item.type = 'button'
      item.dataset.for = id
      item.textContent = source.textContent
      item.title = source.title
      item.addEventListener('click', () => { close(); source.click() })
      return [item]
    }))
    const r = button.getBoundingClientRect()
    menu.style.top = `${r.bottom + 4}px`
    menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`
    menu.hidden = false
    button.setAttribute('aria-expanded', 'true')
  }
  button.addEventListener('click', () => (menu.hidden ? open() : close()))
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !(e.target as HTMLElement).closest('#more-menu, #more-button')) close() })
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) close() })
  window.addEventListener('resize', close)
  return { open, close }
}
