import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { groupVendors } from '../../src/scene/layout'
import { planVendorIsland, vendorSlot } from '../../src/scene/vendors'
import { checkSnapshot } from '../../src/snapshotGuard'
import { vendorWhere } from '../../src/inspectorModel'
import type { NodeSnapshot, Snapshot, VendorSnapshot } from '../../src/types'

const calm = JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/calm.json'), 'utf8')) as Snapshot
const template = calm.vendors[0].node
const node = (id: string): NodeSnapshot => ({ ...template, id, name: id })
const vendor = (id: string, calledBy: string[], island?: string, name?: string, internal = false): VendorSnapshot =>
  ({ node: node(id), calledBy, islandId: island ?? id, islandName: name ?? null, internal })

describe('vendors that share an island', () => {
  it('stand together: one island for the services of a vendor, one each for the others, in the order the snapshot lists them', () => {
    const groups = groupVendors([
      vendor('ext.bureau', ['a.api']),
      vendor('ext.shared-credit', ['a.api', 'b.api'], 'ext.shared', 'Shared services', true),
      vendor('ext.mailer', ['b.api']),
      vendor('ext.shared-identity', ['b.api', 'c.api'], 'ext.shared', 'Shared services', true),
    ])

    expect(groups.map((g) => [g.id, g.members.map((m) => m.node.id)])).toEqual([
      ['ext.bureau', ['ext.bureau']],
      ['ext.shared', ['ext.shared-credit', 'ext.shared-identity']],
      ['ext.mailer', ['ext.mailer']],
    ])
    expect(groups[1].name).toBe('Shared services')
    expect(groups[1].calledBy).toEqual(['a.api', 'b.api', 'c.api']) // every caller of any building, once
    expect(groups[0].name).toBe('ext.bureau') // a plain vendor keeps its own name
  })

  it('treat a vendor with no island id as its own island', () => {
    const plain = { node: node('ext.x'), calledBy: [] } as unknown as VendorSnapshot

    expect(groupVendors([plain]).map((g) => g.id)).toEqual(['ext.x'])
  })

  it('arrive from the snapshot with their island, name and internal flag, and a snapshot from before them still draws', () => {
    const raw = structuredClone(calm) as unknown as Record<string, unknown>
    const first = (raw.vendors as Record<string, unknown>[])[0]
    Object.assign(first, { islandId: 'ext.shared', islandName: 'Shared services', internal: true })
    const old = (raw.vendors as Record<string, unknown>[])[1]
    delete old.islandId; delete old.islandName; delete old.internal

    const { snapshot, problems } = checkSnapshot(raw)

    expect(problems).toEqual([])
    expect(snapshot!.vendors[0]).toMatchObject({ islandId: 'ext.shared', islandName: 'Shared services', internal: true })
    expect(snapshot!.vendors[1]).toMatchObject({ islandId: null, internal: false })
  })

  it('are labelled as internal or third party, with the island they share', () => {
    expect(vendorWhere({ internal: false })).toBe('Third party')
    expect(vendorWhere({ internal: true, islandName: 'Shared services' })).toBe('Internal service, Shared services')
    expect(vendorWhere(undefined)).toBe('Third party')
  })
})

describe('the buildings of a vendor island', () => {
  it('keep the old plot for a single building: left of the spine, on the first road', () => {
    expect(vendorSlot(0)).toEqual({ x: -8, roadZ: 1, col: 0 })
    expect(planVendorIsland('ext.solo', 1).slots).toEqual([{ x: -8, roadZ: 1, col: 0 }])
  })

  it('fill a row left then right, then the next row up the spine', () => {
    const slots = [0, 1, 2, 3, 4].map(vendorSlot)

    expect(slots.map((s) => s.col)).toEqual([0, 1, 0, 1, 0])
    expect(slots.map((s) => Math.sign(s.x))).toEqual([-1, 1, -1, 1, -1])
    expect(slots[2].roadZ).toBeLessThan(slots[0].roadZ)
    expect(slots[2].roadZ).toBe(slots[3].roadZ)
    expect(slots[4].roadZ).toBeLessThan(slots[2].roadZ)
  })

  it.each([2, 3, 5, 8])('hold %i of them on one island: each plot on land, none sharing a place, the gate beyond the first road', (n) => {
    const plan = planVendorIsland(`ext.many-${n}`, n)

    expect(plan.slots).toHaveLength(n)
    expect(new Set(plan.slots.map((t) => `${t.x}/${t.roadZ}`)).size).toBe(n)
    for (const t of plan.slots) {
      for (const dx of [-6, 6]) for (const z of [t.roadZ + 2, t.roadZ - 14]) expect(plan.outline.contains(t.x + dx, z, 2), `${t.x + dx},${z}`).toBe(true)
    }
    expect(plan.gateZ).toBeGreaterThan(Math.max(...plan.slots.map((t) => t.roadZ)) + 7)
  })

  it('make the island no bigger than the buildings need: one more row, a bigger island', () => {
    const size = (n: number) => planVendorIsland('ext.grow', n).rz
    expect(size(1)).toBeLessThanOrEqual(size(2))
    expect(size(4)).toBeGreaterThan(size(2))
    expect(size(6)).toBeGreaterThan(size(4))
  })
})
