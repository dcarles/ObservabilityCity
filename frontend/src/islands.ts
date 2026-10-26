// The island filter, as pure functions. The viewer picks which islands to show; the backend sends a town with only those (and the hub), and
// counts only what is on screen. The choice lives in the address (?islands=cl,pay). An empty choice means every island.

import type { Snapshot } from './types'

/** The island ids in an address: comma lists and repeats allowed, blanks dropped, each once. */
export function parseIslands(search: string): string[] {
  const q = new URLSearchParams(search)
  return [...new Set(q.getAll('islands').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean))]
}

/** The address value for a choice, or '' when every island is shown. */
export const islandsParam = (ids: readonly string[]): string => [...ids].sort().join(',')

export interface IslandChoice {
  id: string
  name: string
  /** On screen right now. */
  shown: boolean
}

/**
 * Every island of the town, on screen or not, by name. A filtered snapshot lists the islands it left out, so the whole list can always be
 * rebuilt from the snapshot alone. The hub is not a choice: it is always shown.
 */
export function islandChoices(s: Pick<Snapshot, 'groups' | 'view'>): IslandChoice[] {
  const shown = s.groups.filter((g) => !g.isHub).map((g) => ({ id: g.id, name: g.displayName, shown: true }))
  const hidden = (s.view?.hidden ?? []).map((h) => ({ id: h.id, name: h.displayName, shown: false }))
  return [...shown, ...hidden].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** Adds the island to the choice, or takes it out. Taking the last one out shows every island again. */
export function toggleIsland(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]
}

/** Drops chosen islands the town no longer has. Returns the same array when nothing changed. */
export function pruneIslands(selected: readonly string[], choices: readonly IslandChoice[]): readonly string[] {
  const keep = selected.filter((id) => choices.some((c) => c.id === id))
  return keep.length === selected.length ? selected : keep
}

/** The button's label: "All islands", the island's name, or "3 of 14 islands". */
export function islandsLabel(selected: readonly string[], choices: readonly IslandChoice[]): string {
  if (selected.length === 0) return 'All islands'
  if (selected.length === 1) return choices.find((c) => c.id === selected[0])?.name ?? selected[0]
  return `${selected.length} of ${choices.length} islands`
}

/** The islands whose name or id contains every word typed. */
export function searchIslands(choices: readonly IslandChoice[], query: string): IslandChoice[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return choices.filter((c) => words.every((w) => `${c.name} ${c.id}`.toLowerCase().includes(w)))
}
