import type { GroupSnapshot } from '../types'
import { hasMessaging } from './harbour'

// The connectors an island gets, decided by the registry and carried in the snapshot. Pure, so it can be tested without a renderer.
// Connectors follow real links only: a pier (and the boats that sail to it) only for an island with messaging, a bridge to the hub only
// for an island with an API or a call link over its coast (in a direct town: a call to or from a shared resource of the hub), and a building only for a role the island really has.

export interface Connectors {
  id: string
  /** A bridge to the hub, the road to the island, and the cars that cross it. */
  bridge: boolean
  /** A bridge from the back gate to the outer ring road: how a direct town's islands reach each other, the airport and the third parties. */
  ring: boolean
  /** A pier with its board, crate pile and dead-letter pen, and a sea lane for boats from the hub's port. */
  pier: boolean
  /** Neither: the island stands alone, and the registry has already said so in its notices. */
  standalone: boolean
}

export function connectorsOf(g: GroupSnapshot): Connectors {
  const bridge = !g.isHub && g.hasBridge !== false && !g.configError
  const ring = !g.isHub && g.hasRingBridge === true && !g.configError
  const pier = !g.isHub && hasMessaging(g.messaging) && !g.configError
  return { id: g.id, bridge, ring, pier, standalone: !bridge && !ring && !pier }
}

/** What the Service Bus port reports for the whole town: topics, subscriptions, the piers they land on, and how many reads are the old egress route. */
export interface PortSummary {
  topics: number
  subscriptions: number
  piers: number
  legacy: number
}

export function portSummary(groups: GroupSnapshot[]): PortSummary {
  const out: PortSummary = { topics: 0, subscriptions: 0, piers: 0, legacy: 0 }
  for (const g of groups) {
    out.topics += g.messaging?.topics.length ?? 0
    out.subscriptions += g.messaging?.subscriptions.length ?? 0
    out.legacy += g.messaging?.subscriptions.filter((s) => s.legacy).length ?? 0
    if (connectorsOf(g).pier) out.piers++
  }
  return out
}
