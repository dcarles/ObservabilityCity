// A history frame draws the town with the links between systems that were known when the frame was made, and the live town with the ones known now (link discovery finds
// more over time). The town is built again whenever those differ, which takes about a second, so going between live and the past froze the page. Every frame of the past
// is therefore drawn with the links of the live town: this keeps them from the live snapshots and puts them on a frame before it is drawn.

interface Links {
  calls: unknown
  gatewayCalls: unknown
}

interface VendorLinks {
  calledBy: unknown
  calls: unknown
}

export interface LiveShape {
  systems: Map<string, Links>
  vendors: Map<string, VendorLinks>
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** What a live snapshot says about the links of each system and each third party. Null when it is not a snapshot with groups. */
export function liveShapeOf(raw: unknown): LiveShape | null {
  if (!isObject(raw) || !Array.isArray(raw.groups)) return null
  const systems = new Map<string, Links>()
  for (const g of raw.groups) {
    if (!isObject(g) || !Array.isArray(g.nodes)) continue
    for (const n of g.nodes) if (isObject(n) && typeof n.id === 'string') systems.set(n.id, { calls: n.calls, gatewayCalls: n.gatewayCalls })
  }
  const vendors = new Map<string, VendorLinks>()
  if (Array.isArray(raw.vendors)) for (const v of raw.vendors) if (isObject(v) && isObject(v.node) && typeof v.node.id === 'string') vendors.set(v.node.id, { calledBy: v.calledBy, calls: v.calls })
  return { systems, vendors }
}

/** The frame with the links of the live town on the systems and third parties both have. A frame that is not a snapshot with groups, or has nothing in common, comes back as it is. */
export function withLiveShape(raw: unknown, shape: LiveShape | null): unknown {
  if (!shape || !isObject(raw) || !Array.isArray(raw.groups)) return raw
  const groups = raw.groups.map((g) => {
    if (!isObject(g) || !Array.isArray(g.nodes)) return g
    return { ...g, nodes: g.nodes.map((n) => (isObject(n) && typeof n.id === 'string' && shape.systems.has(n.id) ? { ...n, ...shape.systems.get(n.id) } : n)) }
  })
  const vendors = Array.isArray(raw.vendors)
    ? raw.vendors.map((v) => (isObject(v) && isObject(v.node) && typeof v.node.id === 'string' && shape.vendors.has(v.node.id) ? { ...v, ...shape.vendors.get(v.node.id) } : v))
    : raw.vendors
  return { ...raw, groups, vendors }
}
