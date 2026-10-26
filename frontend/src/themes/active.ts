// The theme the page is showing. A theme is chosen once, when the page opens (a different theme is a fresh page, like a different town), so
// the rest of the scene reads the live colours and builders from here while it is built.

import { LIGHTING } from '../lighting'
import type { NodeKind } from '../types'
import type { BuildingModel } from '../buildings/model'
import { harbourPalette } from './harbour-town/palette'
import type { BridgeStyle, Palette, ThemeKit, VehicleKit } from './types'

/** The colours of the theme in use. Changed in place when a theme is activated, so everything that imports it follows. */
export const palette: Palette = structuredClone(harbourPalette)

let current: ThemeKit | null = null

/** Copies `from` into `into` without replacing any object `into` already holds, so a module that kept `palette.building` still sees the new colours. */
function assign(into: any, from: any): void {
  for (const key of Object.keys(from)) {
    const v = from[key]
    if (v && typeof v === 'object' && !Array.isArray(v) && into[key] && typeof into[key] === 'object') assign(into[key], v)
    else into[key] = Array.isArray(v) ? [...v] : v
  }
}

/** Makes this theme the one the scene is built from. Call before the stage and the town are made. */
export function activateTheme(kit: ThemeKit): void {
  current = kit
  assign(palette, kit.palette)
  assign(LIGHTING, kit.lighting)
}

export function activeKit(): ThemeKit {
  if (!current) throw new Error('No theme is active yet')
  return current
}

export const activeThemeId = (): string | null => current?.id ?? null

export const buildModel = (kind: NodeKind, accent: string, opts: { tenanted?: boolean; name?: string } = {}): BuildingModel => activeKit().buildModel(kind, accent, opts)
export const vehicles = (): VehicleKit => activeKit().vehicles
export const bridgeStyle = (): BridgeStyle => activeKit().bridge
