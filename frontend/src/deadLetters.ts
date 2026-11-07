import type { GroupSnapshot } from './types'
import { isAbsent, isUnmonitored } from './signals'

/** One queue with dead letters, and the service that reads it. */
export interface DeadLetterItem {
  /** The system that reads the queue (it carries the queue in its drawer). */
  nodeId: string
  nodeName: string
  groupId: string
  groupName: string
  queue: string
  count: number
  /** The region the dead letters are in (as North, West or the raw name), when the broker spans several; null otherwise. */
  region: string | null
}

/** A region as a short word: North and West Europe become North and West; any other name is shown as it is. */
export function regionLabel(region: string): string {
  const r = region.toLowerCase()
  return r.includes('north') ? 'North' : r.includes('west') ? 'West' : region
}

/**
 * Every queue with dead letters, worst first: which island, which service reads it, which queue, how many. Optionally only one island's.
 * A system with no fresh data or no dead-letter signal is left out, as everywhere else: its numbers are not to be believed.
 */
export function deadLetterItems(groups: readonly Pick<GroupSnapshot, 'id' | 'displayName' | 'nodes'>[], island?: string | null): DeadLetterItem[] {
  const items: DeadLetterItem[] = []
  for (const g of groups) {
    if (island && g.id !== island) continue
    for (const n of g.nodes) {
      if (n.state === 'Stale' || isUnmonitored(n) || isAbsent(n, 'deadLetters')) continue
      for (const q of n.queues ?? []) {
        if ((q.deadLetters ?? 0) <= 0) continue
        const base = { nodeId: n.id, nodeName: n.name, groupId: g.id, groupName: g.displayName, queue: q.name }
        // a broker in several regions says where each queue's dead letters are: one row for each region that holds some
        const regions = (q.deadLetterRegions ?? []).filter((r) => r.count > 0)
        if (regions.length === 0) items.push({ ...base, count: q.deadLetters as number, region: null })
        else for (const r of regions) items.push({ ...base, count: r.count, region: regionLabel(r.region) })
      }
    }
  }
  return items.sort((a, b) => b.count - a.count || a.groupName.localeCompare(b.groupName) || a.nodeName.localeCompare(b.nodeName) || a.queue.localeCompare(b.queue) || (a.region ?? '').localeCompare(b.region ?? ''))
}
