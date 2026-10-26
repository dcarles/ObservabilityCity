// The showcase loop for a healthy town: what the wall shows when nothing needs attention. Pure: a snapshot in, a list of scenes out.

import type { NodeSnapshot, Snapshot } from '../types'
import { formatRate } from '../visuals'
import type { Focus } from './attention'
import { sinceIncidentText } from './since'

export interface Scene {
  key: string
  focus: Focus
  caption: string
}

/** The words for the whole town when it is healthy. */
export function healthyCaption(s: Snapshot): string {
  const since = sinceIncidentText(s)
  return since ? `All systems healthy, ${since}` : 'All systems healthy'
}

const busiest = (nodes: readonly NodeSnapshot[], count: number): NodeSnapshot[] =>
  [...nodes].filter((n) => n.requestsPerSecond > 0).sort((a, b) => b.requestsPerSecond - a.requestsPerSecond || a.id.localeCompare(b.id)).slice(0, count)

/**
 * The loop: the whole town with the healthy line, the hub, then the islands in the order they stand round it, with a visit to one of the
 * busiest systems after every third island, and the hub wide shot again to close. Islands are what the snapshot shows (a team's view has only its own).
 */
export function calmScenes(s: Snapshot, busiestCount = 3): Scene[] {
  const scenes: Scene[] = [{ key: 'town', focus: { kind: 'home', id: '' }, caption: healthyCaption(s) }]
  const hub = s.groups.find((g) => g.isHub)
  const islands = s.groups.filter((g) => !g.isHub && g.nodes.length > 0)
  if (hub) {
    const broker = hub.nodes.find((n) => n.kind === 'Broker')
    const rate = hub.nodes.find((n) => n.kind === 'Gateway')?.requestsPerSecond
    scenes.push({
      key: 'hub', focus: { kind: 'island', id: hub.id },
      caption: `${hub.displayName}: ${hub.nodes.length} shared systems${broker ? `, with ${broker.name} carrying the messages` : ''}${rate ? ` and ${formatRate(rate)} req/s through the gateway` : ''}`,
    })
  }
  const visits = busiest(islands.flatMap((g) => g.nodes), busiestCount)
  let next = 0
  islands.forEach((g, i) => {
    const rate = g.nodes.reduce((a, n) => a + n.requestsPerSecond, 0)
    scenes.push({
      key: `island:${g.id}`, focus: { kind: 'island', id: g.id },
      caption: `${g.displayName}: ${g.nodes.length} system${g.nodes.length === 1 ? '' : 's'}, ${formatRate(rate)} req/s, all healthy`,
    })
    if ((i + 1) % 3 === 0 && next < visits.length) {
      const n = visits[next++]
      scenes.push({ key: `busy:${n.id}`, focus: { kind: 'building', id: n.id }, caption: `${n.name} is one of the busiest: ${formatRate(n.requestsPerSecond)} req/s` })
    }
  })
  // a small town may not have reached a third island: the busiest still get their visit
  while (next < visits.length && islands.length < 3 * (next + 1)) {
    const n = visits[next++]
    scenes.push({ key: `busy:${n.id}`, focus: { kind: 'building', id: n.id }, caption: `${n.name} is one of the busiest: ${formatRate(n.requestsPerSecond)} req/s` })
  }
  if (hub) scenes.push({ key: 'hub-end', focus: { kind: 'island', id: hub.id }, caption: `${hub.displayName}: where every island meets` })
  return scenes
}
