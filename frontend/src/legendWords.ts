// What the legend calls things in each theme. The harbour town's words are the legend's own (legend.ts); a theme here only renames what it draws
// differently, so the meaning, the colour tone and the list of entries stay the same in every theme.

import { LEGEND, type LegendEntry, type LegendSection } from './legend'

type Words = Record<string, Partial<Pick<LegendEntry, 'sees' | 'means' | 'icon'>>>

export const THEME_WORDS: Record<string, Words> = {
  space: {
    api: { sees: 'Habitat module', icon: '🛰️' },
    worker: { sees: 'Fabricator with stacks', icon: '⚙️', means: 'A worker: it reads messages. Its plasma plume thickens with CPU' },
    database: { sees: 'Data vault', icon: '🗄️', means: 'A database. One storage unit for each tenant where each has its own' },
    cache: { sees: 'Fusion sphere', icon: '🔮' },
    function: { sees: 'Chrono spire with spinning rings', icon: '⏳' },
    hub: { sees: 'The platform in the middle', icon: '🛸', means: 'The platform hub: API gateway, message broker spaceport (Service Bus, Kafka), central egress, shared database' },
    car: { sees: 'Hover pod with a cyan canopy', icon: '🚀' },
    taxi: { sees: 'Amber hover pod', icon: '🛩️' },
    bridge: { sees: 'Light bridge', icon: '🌈' },
    boat: { sees: 'Cargo shuttles from the spaceport to a docking gantry', icon: '🚀' },
    crates: { sees: 'Crates piling up on a docking gantry' },
    vendor: { sees: 'Small platform out in the void', icon: '🪐' },
    airport: { sees: 'Spaceport', icon: '🛸', means: 'Callers from outside. Flying saucers follow the inbound traffic' },
  },
  factory: {
    api: { sees: 'Office block' },
    worker: { sees: 'Production hall with chimneys', means: 'A worker: it reads messages. Its chimney smoke thickens with CPU' },
    database: { sees: 'Warehouse', means: 'A database. One storage unit for each tenant where each has its own' },
    cache: { sees: 'Pressure tank' },
    function: { sees: 'Tower with a clock and a siren' },
    hub: { sees: 'The yard in the middle', means: 'The platform hub: API gateway, message broker depot (Service Bus, Kafka), central egress, shared database' },
    car: { sees: 'Blue-cab van', icon: '🚐' },
    taxi: { sees: 'Yellow-cab van', icon: '🚚' },
    bridge: { sees: 'Steel truss bridge', icon: '🏗️' },
    boat: { sees: 'Container barges from the depot to a loading dock', icon: '🚢' },
    crates: { sees: 'Containers piling up on a loading dock' },
    vendor: { sees: 'Small yard out on the canal' },
    airport: { sees: 'Air freight field', means: 'Callers from outside. Cargo planes follow the inbound traffic' },
  },
}

/** The legend as one theme words it. Same sections, same entries, same tones and meanings unless the theme says the thing works differently. */
export function legendFor(themeId: string): readonly LegendSection[] {
  const words = THEME_WORDS[themeId]
  if (!words) return LEGEND
  return LEGEND.map((s) => ({ ...s, entries: s.entries.map((e) => ({ ...e, ...words[e.id] })) }))
}
