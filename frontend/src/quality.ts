// Quality presets: how much the town is drawn with. High is for a PC with a graphics card, Low for a weak laptop or a wall screen driven by a small box.
// Numbers only; the stage and the town apply them.

export type Quality = 'high' | 'medium' | 'low'

export interface QualityPreset {
  id: Quality
  name: string
  hint: string
  /** The most device pixels drawn for each page pixel. A sharp screen asks for 2 or 3; every step down draws fewer. */
  pixelRatioCap: number
  /** Shadows are redrawn every frame, a few times a second (buildings never move, so only the cars' shadows lag), or not at all. */
  shadows: 'every-frame' | 'few-per-second' | 'off'
  /** Side of the shadow map in texels. */
  shadowMapSize: number
  /** The share of the usual number of cars and boats that are sent out. */
  traffic: number
}

export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  high: { id: 'high', name: 'High', hint: 'Full detail: sharp, shadows every frame, all the traffic', pixelRatioCap: 2, shadows: 'every-frame', shadowMapSize: 4096, traffic: 1 },
  medium: { id: 'medium', name: 'Medium', hint: 'Lower resolution, shadows a few times a second, most of the traffic', pixelRatioCap: 1.5, shadows: 'few-per-second', shadowMapSize: 2048, traffic: 0.7 },
  low: { id: 'low', name: 'Low', hint: 'For a weak PC: normal resolution, no shadows, less than half the traffic', pixelRatioCap: 1, shadows: 'off', shadowMapSize: 1024, traffic: 0.4 },
}

/** The presets in the order a list shows them, best first. */
export const QUALITIES: QualityPreset[] = [QUALITY_PRESETS.high, QUALITY_PRESETS.medium, QUALITY_PRESETS.low]

export const QUALITY_KEY = 'oc.quality'

export const isQuality = (v: unknown): v is Quality => v === 'high' || v === 'medium' || v === 'low'

export const qualityName = (q: Quality): string => `Quality: ${QUALITY_PRESETS[q].name}`

/** The next level down (Low has none). The page steps down by itself when it cannot keep up. */
export function stepDown(q: Quality): Quality | null {
  const i = QUALITIES.findIndex((p) => p.id === q)
  return QUALITIES[i + 1]?.id ?? null
}

/** The device pixel ratio to draw with on a screen of this sharpness. */
export const pixelRatioFor = (q: Quality, devicePixelRatio: number): number => Math.max(1, Math.min(devicePixelRatio, QUALITY_PRESETS[q].pixelRatioCap))

interface Store {
  getItem(key: string): string | null
}

export interface QualityChoice {
  quality: Quality
  /** True when the level was chosen (in the address or by the viewer): the page then never steps down by itself. */
  chosen: boolean
}

/**
 * The quality the page opens with: ?quality= in the address, else what this browser last chose, else the page's own default (High, or Medium on a wall,
 * where nobody is at the keyboard to turn it down). Only the page's default steps down on its own when frames run long.
 */
export function startQuality(search: string, store: Store | null, fallback: Quality = 'high'): QualityChoice {
  const asked = new URLSearchParams(search).get('quality')
  if (isQuality(asked)) return { quality: asked, chosen: true }
  try {
    const saved = store?.getItem(QUALITY_KEY)
    if (isQuality(saved)) return { quality: saved, chosen: true }
  } catch { /* storage blocked */ }
  return { quality: fallback, chosen: false }
}

export function saveQuality(store: { setItem(key: string, value: string): void } | null, q: Quality): void {
  try { store?.setItem(QUALITY_KEY, q) } catch { /* storage blocked */ }
}
