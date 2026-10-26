// Day and Dusk: two lighting presets over the same town. Colours and intensities only; the stage applies them.

export type Lighting = 'day' | 'dusk'

export interface LightingPreset {
  name: string
  sky: { top: string; horizon: string }
  fog: string
  sea: { deep: string; shallow: string }
  hemisphere: { sky: string; ground: string; intensity: number }
  sun: { color: string; intensity: number }
  exposure: number
  /** The page behind the canvas, seen before the first frame. */
  page: string
}

export const LIGHTING: Record<Lighting, LightingPreset> = {
  day: {
    name: 'Day',
    sky: { top: '#5eb8f2', horizon: '#e4f4ff' },
    fog: '#d9efff',
    sea: { deep: '#2b8fc4', shallow: '#4fc3d9' },
    hemisphere: { sky: '#d6ecff', ground: '#c9b88f', intensity: 1.15 },
    sun: { color: '#fff0d6', intensity: 2.6 },
    exposure: 1.05,
    page: '#cfe9fb',
  },
  dusk: {
    name: 'Dusk',
    sky: { top: '#1d2b57', horizon: '#f2a36b' },
    fog: '#7a6f94',
    sea: { deep: '#14375c', shallow: '#2d5f86' },
    hemisphere: { sky: '#6f7fc4', ground: '#53436b', intensity: 0.75 },
    sun: { color: '#ffb36b', intensity: 1.5 },
    exposure: 0.95,
    page: '#2b3260',
  },
}

export const LIGHTING_KEY = 'oc.lighting'

export const isLighting = (v: unknown): v is Lighting => v === 'day' || v === 'dusk'

/** The other one. */
export const otherLighting = (l: Lighting): Lighting => (l === 'day' ? 'dusk' : 'day')

/** Where the choice is remembered. A browser that cannot store things (a private window) just forgets it. */
export interface Store {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The lighting the page opens with: ?light= in the address, else what this browser last chose, else Day. */
export function startLighting(search: string, store: Store | null): Lighting {
  const asked = new URLSearchParams(search).get('light')
  if (isLighting(asked)) return asked
  try {
    const saved = store?.getItem(LIGHTING_KEY)
    if (isLighting(saved)) return saved
  } catch { /* storage blocked */ }
  return 'day'
}

export function saveLighting(store: Store | null, l: Lighting): void {
  try { store?.setItem(LIGHTING_KEY, l) } catch { /* storage blocked */ }
}

/** The browser's storage, or null when the browser will not give it out. */
export function browserStore(): Store | null {
  try { return window.localStorage } catch { return null }
}
