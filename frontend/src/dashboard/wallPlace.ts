// Where the wall dashboard looks when the tour stops somewhere: a pillar's card, and a service row inside it. Pure: no page needed.

import type { Focus } from '../wall/attention'

/** A pillar to open and, when the tour is on one service, the service to bring to the middle of the screen. */
export interface DashPlace {
  pillar: string
  system: string | null
}

/**
 * The place for a stop. An island is a pillar; a building is a service inside the pillar that has it. The hub, a vendor island or anything the page
 * does not show as a pillar has no place (null): the wall goes back to the top of the page instead of staying half-way.
 */
export function dashPlaceOf(
  focus: Focus,
  groups: readonly { id: string; nodes: readonly { id: string }[] }[],
  pillars: readonly string[],
): DashPlace | null {
  if (focus.kind === 'home') return null
  const shown = new Set(pillars)
  if (focus.kind === 'island') return shown.has(focus.id) ? { pillar: focus.id, system: null } : null
  const group = groups.find((g) => g.nodes.some((n) => n.id === focus.id))
  return group && shown.has(group.id) ? { pillar: group.id, system: focus.id } : null
}
