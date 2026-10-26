// Traffic that crosses the edge of the screen when the island filter hides some islands, as pure functions. In a hub-and-spoke town every call
// between islands goes through the hub's gateway, so a call to a hidden island ends at the hub plaza, and a call from one starts there. In a town
// whose islands call each other directly there is no common place for it to go, so each island gets a signpost saying which hidden islands its
// traffic goes to and comes from.

import type { OffscreenLink, Snapshot } from './types'
import { formatRate } from './visuals'

export type EdgeMode = 'plaza' | 'signpost'

/** Hub-and-spoke towns send the traffic to the hub plaza; every other topology gets signposts. */
export function edgeMode(s: Pick<Snapshot, 'topology'>): EdgeMode {
  return s.topology === 'hub-and-spoke' ? 'plaza' : 'signpost'
}

export const edgeLinks = (s: Pick<Snapshot, 'view'>): readonly OffscreenLink[] => s.view?.links ?? []

/** Whether anything is hidden. */
export const isFiltered = (s: Pick<Snapshot, 'view'>): boolean => (s.view?.islands.length ?? 0) > 0 || (s.view?.unknown.length ?? 0) > 0

/** One line on a signpost: a hidden island, and how much traffic goes to it and comes from it. */
export interface SignLine {
  islandId: string
  island: string
  /** Requests per second this island's systems send to the hidden island. */
  out: number
  /** Requests per second the hidden island sends in. */
  in: number
}

/** How many lines a signpost has room for. */
export const SIGN_LINES = 4

/** The lines of the signpost on one island: its links to hidden islands, the busiest first. `nodeIds` are the systems on that island. */
export function signLines(links: readonly OffscreenLink[], nodeIds: ReadonlySet<string>): SignLine[] {
  const by = new Map<string, SignLine>()
  for (const l of links) {
    if (!nodeIds.has(l.nodeId)) continue
    const line = by.get(l.islandId) ?? { islandId: l.islandId, island: l.islandName, out: 0, in: 0 }
    if (l.incoming) line.in += l.requestsPerSecond
    else line.out += l.requestsPerSecond
    by.set(l.islandId, line)
  }
  return [...by.values()].sort((a, b) => b.out + b.in - (a.out + a.in) || a.island.localeCompare(b.island))
}

/** The words on one line: "Alpha  →12/s  ←3.0/s". An arrow is left out when no traffic goes that way. */
export function signText(l: SignLine): string {
  const parts = [l.island]
  if (l.out > 0) parts.push(`→${formatRate(l.out)}/s`)
  if (l.in > 0) parts.push(`←${formatRate(l.in)}/s`)
  return parts.join('  ')
}

/** The lines that fit, and how many islands did not make it. */
export function signBoard(lines: readonly SignLine[]): { shown: SignLine[]; more: number } {
  return { shown: lines.slice(0, SIGN_LINES), more: Math.max(0, lines.length - SIGN_LINES) }
}

/** The key of what the town's layout depends on: which links exist and which islands are hidden, not how busy they are. */
export function edgeKey(s: Pick<Snapshot, 'view' | 'topology'>): string {
  const v = s.view
  if (!v || (v.hidden.length === 0 && v.links.length === 0)) return ''
  return `${s.topology}|${v.hidden.map((h) => h.id).join('+')}|${v.links.map((l) => `${l.nodeId}${l.incoming ? '<' : '>'}${l.islandId}`).join('+')}`
}
