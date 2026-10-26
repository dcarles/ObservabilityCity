// The drawn themes, by id. Kept apart from themes.ts, which the picker and the address use and which must not pull in the renderer.

import type { ThemeKit } from './types'
import { harbourTown } from './harbour-town'
import { spaceColony } from './space'
import { factoryWorks } from './factory'

export const KITS: Record<string, ThemeKit> = {
  'harbour-town': harbourTown,
  space: spaceColony,
  factory: factoryWorks,
}

export const kitById = (id: string): ThemeKit => KITS[id] ?? harbourTown
