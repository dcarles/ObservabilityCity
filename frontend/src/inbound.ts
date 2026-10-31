import type { NodeSnapshot } from './types'

/**
 * Where an API's traffic comes from, as shares of its own request rate (0 to 1 each).
 * `outside` arrives at the airport, `caller(id)` is what one town system sends, and `standIn` is the part for a caller the town cannot name.
 */
export interface InboundMix {
  outside: number
  caller: (id: string) => number
  standIn: number
}

const NONE: InboundMix = { outside: 0, caller: () => 0, standIn: 0 }

/** Whether the server measured this API's traffic (links.traffic): it says how much is outside and how much each town system sends. */
export function isMeasured(node: NodeSnapshot): boolean {
  return node.kind === 'Api' && node.outsideRequestsPerSecond != null && node.inbound != null
}

/**
 * The shares for one API. Measured, they are what the server says: the part no town system explains is outside whichever building it is,
 * each town system sends what the telemetry shows, and nobody else sends anything. Not measured, nothing says who sends what, so the rate is
 * shared evenly between everything that can be seen to call it: each declared caller, and the outside when the API is marked external or an
 * outside caller reaches it (`callers` are the ids of the declared ones). With none of those, the API is called by a stand-in so the road is not left silent.
 */
export function inboundMix(node: NodeSnapshot | null, callers: ReadonlySet<string>, outsideReaches: boolean): InboundMix {
  if (!node) return NONE
  if (isMeasured(node)) {
    const rps = node.requestsPerSecond
    if (!(rps > 0)) return NONE
    const sends = new Map(node.inbound!.map((l) => [l.from, l.requestsPerSecond]))
    return { outside: clamp01((node.outsideRequestsPerSecond ?? 0) / rps), caller: (id) => clamp01((sends.get(id) ?? 0) / rps), standIn: 0 }
  }
  const slots = callers.size + (outsideReaches ? 1 : 0)
  if (slots === 0) return { outside: 0, caller: () => 0, standIn: 1 }
  return { outside: outsideReaches ? 1 / slots : 0, caller: (id) => (callers.has(id) ? 1 / slots : 0), standIn: 0 }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** "64% outside · 28% merchant · 8% offers": the split the inspector shows for a measured API, biggest first. Null when nothing is measured or the API is idle. */
export function inboundSplitText(node: NodeSnapshot, nameOf: (id: string) => string): string | null {
  if (!isMeasured(node) || !(node.requestsPerSecond > 0)) return null
  const rps = node.requestsPerSecond
  const parts = [{ name: 'outside', share: (node.outsideRequestsPerSecond ?? 0) / rps }, ...node.inbound!.map((l) => ({ name: nameOf(l.from), share: l.requestsPerSecond / rps }))]
    .filter((p) => p.share >= 0.005)
    .sort((a, b) => b.share - a.share)
  return parts.map((p) => `${Math.round(p.share * 100)}% ${p.name}`).join(' · ')
}
