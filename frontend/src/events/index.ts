// Which scripted event belongs to which theme, and how to build it.

import type { BuildContext, EventScene } from './types'

export type EventId = EventScene['id']

/** The raid that suits each theme: pirates land in the harbour town, zombies overrun the factory, aliens invade the space colony. */
export const EVENT_FOR_THEME: Record<string, EventId> = {
  'harbour-town': 'pirates',
  factory: 'zombies',
  space: 'aliens',
}

export const eventForTheme = (themeId: string): EventId | null => EVENT_FOR_THEME[themeId] ?? null

// Each event's script and drawing is loaded only when it plays (the Konami code): the town page does not carry the three of them.
const BUILDERS: Record<EventId, (c: BuildContext) => Promise<EventScene>> = {
  pirates: async (c) => (await import('./pirates')).buildPirates(c),
  zombies: async (c) => (await import('./zombies')).buildZombies(c),
  aliens: async (c) => (await import('./aliens')).buildAliens(c),
}

export const buildEvent = (id: EventId, c: BuildContext): Promise<EventScene> => BUILDERS[id](c)
