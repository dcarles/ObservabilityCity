// Third parties and internal services the viewer hid in the dashboard and the architecture view. A third party already goes by itself when every pillar that
// calls it is hidden (the server leaves it out of a filtered snapshot); this is the other half: hiding one on its own. The choice lives in the address
// (?hidevendors=fiserv,provenir), like the pillar choice, and a hidden one is simply taken out of the snapshot the page draws, so every number follows.

import type { Snapshot } from './types'

/** The island ids of third parties in an address: comma lists and repeats allowed, blanks dropped, each once. */
export function parseHiddenVendors(search: string): string[] {
  const q = new URLSearchParams(search)
  return [...new Set(q.getAll('hidevendors').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean))]
}

/** The address value for a choice; empty when nothing is hidden. */
export const hiddenVendorsParam = (ids: readonly string[]): string => [...ids].sort().join(',')

export interface VendorChoice {
  id: string
  name: string
  /** An internal service outside the platform (listed under the town's own word for it), not a third party. */
  internal: boolean
  shown: boolean
}

const islandOf = (v: Snapshot['vendors'][number]): string => v.islandId ?? v.node.id

/** The third parties and internal services in the snapshot (the ones whose callers are all hidden are not in it), by name, each marked shown or hidden. */
export function vendorChoices(s: Pick<Snapshot, 'vendors'>, hidden: readonly string[]): VendorChoice[] {
  const seen = new Map<string, VendorChoice>()
  for (const v of s.vendors) {
    const id = islandOf(v)
    if (!seen.has(id)) seen.set(id, { id, name: v.islandName ?? v.node.name, internal: v.internal, shown: !hidden.includes(id) })
  }
  return [...seen.values()].sort((a, b) => Number(a.internal) - Number(b.internal) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** The snapshot without the hidden third parties. The same object when nothing is hidden, so a page can tell nothing changed. */
export function withoutHiddenVendors(s: Snapshot, hidden: readonly string[]): Snapshot {
  if (hidden.length === 0) return s
  const vendors = s.vendors.filter((v) => !hidden.includes(islandOf(v)))
  return vendors.length === s.vendors.length ? s : { ...s, vendors }
}

/** Hides the third party, or shows it again. */
export function toggleVendor(hidden: readonly string[], id: string, show: boolean): string[] {
  const rest = hidden.filter((h) => h !== id)
  return show ? rest : [...rest, id]
}
