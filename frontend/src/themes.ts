// The themes the picker offers. A theme is listed here (what the picker and the address need) and drawn by its kit in themes/<id>/, which
// themes/kits.ts registers. Adding a theme does not touch the top bar.

import { browserStore, type Store } from './lighting'

export interface ThemeInfo {
  id: string
  name: string
  /** One line for the picker. */
  blurb: string
}

export const THEMES: readonly ThemeInfo[] = [
  { id: 'harbour-town', name: 'Harbour town', blurb: 'Islands on a sea, buildings by role, boats and cars' },
  { id: 'space', name: 'Space colony', blurb: 'Platforms in a violet void, light bridges, hover pods and cargo shuttles' },
  { id: 'factory', name: 'Works', blurb: 'Concrete yards and brick halls by a canal, steel bridges, vans and barges' },
]

export const DEFAULT_THEME = THEMES[0].id
export const THEME_KEY = 'oc.theme'

export const themeById = (id: string | null | undefined): ThemeInfo | undefined => THEMES.find((t) => t.id === id)

export interface ThemeChoice {
  theme: ThemeInfo
  /** The id asked for in the address that no theme has, so the page can say so. */
  unknown: string | null
}

/** The theme the page opens with: ?theme= in the address, else what this browser last chose, else the default. An unknown name falls back to the default. */
export function startTheme(search: string, store: Store | null = browserStore()): ThemeChoice {
  const asked = new URLSearchParams(search).get('theme')
  const fromAddress = themeById(asked)
  if (fromAddress) return { theme: fromAddress, unknown: null }
  let saved: ThemeInfo | undefined
  try { saved = themeById(store?.getItem(THEME_KEY)) } catch { /* storage blocked */ }
  return { theme: saved ?? THEMES[0], unknown: asked ? asked : null }
}

export function saveTheme(id: string, store: Store | null = browserStore()): void {
  try { store?.setItem(THEME_KEY, id) } catch { /* storage blocked */ }
}
