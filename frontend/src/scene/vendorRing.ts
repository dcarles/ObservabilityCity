import type { NodeSnapshot, Snapshot } from '../types'

/**
 * The part of a third party's traffic that one island sends: what the town systems on it are measured sending, over the whole. Before the traffic is
 * measured the calls are shared evenly between the islands that call it.
 */
export function vendorShare(node: NodeSnapshot | null, callers: readonly string[], islands: number): number {
  const total = node?.requestsPerSecond ?? 0
  if (!node?.inbound || !(total > 0)) return 1 / Math.max(1, islands)
  return Math.min(1, node.inbound.filter((i) => callers.includes(i.from)).reduce((a, i) => a + i.requestsPerSecond, 0) / total)
}

/** The town systems the services of third parties' islands were seen calling, by system id, with the ids of the calling buildings. */
export function vendorCallersOf(s: Snapshot): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const v of s.vendors) for (const target of v.calls ?? []) out.set(target, [...(out.get(target) ?? []), v.node.id])
  return out
}
