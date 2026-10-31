import * as THREE from 'three'
import { box, cyl, flat } from '../buildings/mk'
import type { AssetSnapshot, GroupSnapshot } from '../types'

// Resources that are not systems (a key vault, a storage account, a configuration store) stand as small plain buildings: no lights, no beacon, no health.
// The pure part (what the drawer says about one) is separate so it can be tested without a renderer.

/** What a click on a resource building opens: what it is, which island and service it stands with, and its addresses. */
export interface AssetSummary {
  id: string
  name: string
  label: string
  group: string
  groupName: string
  /** The service whose pad it stands behind, null when it belongs to the pillar. */
  service: string | null
  region: string | null
  links: { name: string; url: string }[]
}

/** What the drawer says about a resource building, from the snapshot. Null when the island or the resource has left the snapshot. */
export function summariseAsset(id: string, groups: readonly GroupSnapshot[]): AssetSummary | null {
  for (const g of groups) {
    const a = (g.assets ?? []).find((x) => x.id === id)
    if (a) return { id: a.id, name: a.name, label: a.label, group: g.id, groupName: g.displayName, service: a.service ?? null, region: a.region ?? null, links: (a.links ?? []).map((l) => ({ name: l.name, url: l.url })) }
  }
  return null
}

/** The sentence that says where a resource belongs. */
export function assetWhere(a: Pick<AssetSummary, 'groupName' | 'service'>): string {
  return a.service ? `Resource of the ${a.service} service on ${a.groupName}` : `Resource of ${a.groupName}`
}

/** The look of one resource: a vault is a steel strongroom, a store a warehouse, a settings store a kiosk with a cog, anything else a plain box. */
function shape(kind: string): THREE.Group {
  const g = new THREE.Group()
  switch (kind) {
    case 'vault':
      g.add(
        box(2.6, 2.0, 2.2, flat('#7c8794', { metalness: 0.3 })),
        box(2.8, 0.18, 2.4, flat('#4f5964'), { y: 2.0 }),
        cyl(0.7, 0.7, 0.16, flat('#d4dce5', { metalness: 0.4 }), { y: 1.0, z: 1.13, rx: Math.PI / 2 }, 20),
        box(0.12, 0.12, 0.3, flat('#b9a047'), { y: 1.0, z: 1.3 }),
      )
      break
    case 'store':
      g.add(
        box(3.0, 1.4, 2.4, flat('#c9b58e')),
        box(3.3, 0.2, 2.7, flat('#8b5e3c'), { y: 1.4 }),
        box(0.7, 0.7, 0.7, flat('#a37c4a'), { x: -0.7, z: 1.5 }),
        box(0.6, 0.5, 0.6, flat('#b98f55'), { x: 0.4, z: 1.55 }),
      )
      break
    case 'settings':
      g.add(
        box(1.9, 1.4, 1.9, flat('#6fa8a0')),
        box(2.1, 0.16, 2.1, flat('#42746d'), { y: 1.4 }),
        cyl(0.55, 0.55, 0.22, flat('#e6eef0'), { y: 1.56 }, 8),
        cyl(0.2, 0.2, 0.26, flat('#42746d'), { y: 1.56 }, 8),
      )
      break
    default:
      g.add(box(2.4, 1.6, 2.4, flat('#b9a98a')), box(2.6, 0.16, 2.6, flat('#7a6a4c'), { y: 1.6 }))
  }
  return g
}

/** One resource building: a shape on its spot, with an invisible box over it for picking with the pointer. */
export class AssetBuilding {
  readonly root = new THREE.Group()
  readonly hit: THREE.Mesh

  /** `behindPad` is true when it stands behind its service's pad, false in the island's back yard. */
  constructor(readonly asset: AssetSnapshot, x: number, y: number, z: number, readonly behindPad = false) {
    this.root.add(shape(asset.shape))
    this.root.position.set(x, y, z)
    this.hit = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.8, 3.2), new THREE.MeshBasicMaterial({ visible: false }))
    this.hit.position.set(0, 1.4, 0)
    this.hit.userData.assetId = asset.id
    this.root.add(this.hit)
  }
}
