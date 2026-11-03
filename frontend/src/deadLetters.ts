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
        if ((q.deadLetters ?? 0) > 0) items.push({ nodeId: n.id, nodeName: n.name, groupId: g.id, groupName: g.displayName, queue: q.name, count: q.deadLetters as number })
      }
    }
  }
  return items.sort((a, b) => b.count - a.count || a.groupName.localeCompare(b.groupName) || a.nodeName.localeCompare(b.nodeName) || a.queue.localeCompare(b.queue))
}
