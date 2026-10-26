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
  /** How strongly lit windows glow: 1 is the daytime look, more makes a town readable from far away when the light is low. */
  windowGlow: number
  /** Where the sun stands relative to the middle of the town. A low sun throws long shadows. */
  sunOffset: { x: number; y: number; z: number }
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
    windowGlow: 1,
    sunOffset: { x: -70, y: 110, z: 60 },
    page: '#cfe9fb',
  },
  dusk: {
    name: 'Dusk',
    sky: { top: '#1a2552', horizon: '#f59a6a' },
    fog: '#8a7096',
    sea: { deep: '#14375c', shallow: '#336a94' },
    hemisphere: { sky: '#7586d0', ground: '#5d4a74', intensity: 0.9 },
    sun: { color: '#ffa860', intensity: 1.9 },
    exposure: 1,
    windowGlow: 2.6,
    sunOffset: { x: -125, y: 46, z: 45 },
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

/** The lighting the page opens with: ?light= in the address, else what this browser last chose, else the page's own default (Day; Dusk on a wall). */
export function startLighting(search: string, store: Store | null, fallback: Lighting = 'day'): Lighting {
  const asked = new URLSearchParams(search).get('light')
  if (isLighting(asked)) return asked
  try {
    const saved = store?.getItem(LIGHTING_KEY)
    if (isLighting(saved)) return saved
  } catch { /* storage blocked */ }
  return fallback
}

export function saveLighting(store: Store | null, l: Lighting): void {
  try { store?.setItem(LIGHTING_KEY, l) } catch { /* storage blocked */ }
}

/** The browser's storage, or null when the browser will not give it out. */
export function browserStore(): Store | null {
  try { return window.localStorage } catch { return null }
}
