// Which scripted event belongs to which theme, and how to build it.

import { buildPirates } from './pirates'
import { buildZombies } from './zombies'
import { buildAliens } from './aliens'
import type { BuildContext, EventScene } from './types'

export type EventId = EventScene['id']

/** The raid that suits each theme: pirates land in the harbour town, zombies overrun the factory, aliens invade the space colony. */
export const EVENT_FOR_THEME: Record<string, EventId> = {
  'harbour-town': 'pirates',
  factory: 'zombies',
  space: 'aliens',
}

export const eventForTheme = (themeId: string): EventId | null => EVENT_FOR_THEME[themeId] ?? null

const BUILDERS: Record<EventId, (c: BuildContext) => Promise<EventScene>> = {
  pirates: buildPirates,
  zombies: buildZombies,
  aliens: buildAliens,
}

export const buildEvent = (id: EventId, c: BuildContext): Promise<EventScene> => BUILDERS[id](c)
