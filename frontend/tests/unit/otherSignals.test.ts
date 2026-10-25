import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { distanceToSegment, placeAirport, placeVendors, type Disc } from '../../src/scene/layout'
import { worstSeverity } from '../../src/scene/weather'
import { arcWidth } from '../../src/scene/overlay'
import { planeRate } from '../../src/scene/airport'
import { staleCount } from '../../src/ui'
import { checkSnapshot } from '../../src/snapshotGuard'
import type { Snapshot } from '../../src/types'

const calm = () => JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/calm.json'), 'utf8')) as Snapshot

const hub: Disc = { id: 'hub', x: 0, z: 0, r: 40 }
const ring = (n: number, radius = 150): Disc[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    return { id: `p${i}`, x: Math.cos(a) * radius, z: Math.sin(a) * radius, r: 30, back: 28 }
  })

describe('worstSeverity', () => {
  it('is null for a clear sky and the lowest number otherwise', () => {
    expect(worstSeverity([])).toBeNull()
    expect(worstSeverity([{ severity: 3 }, { severity: 2 }, { severity: 4 }])).toBe(2)
    expect(worstSeverity([{ severity: 1 }])).toBe(1)
  })
})

describe('arcWidth', () => {
  it('grows with traffic but stays within a readable range', () => {
    expect(arcWidth(0)).toBeLessThan(arcWidth(10))
    expect(arcWidth(10)).toBeLessThan(arcWidth(1000))
    expect(arcWidth(1e9)).toBeLessThan(3)
    expect(arcWidth(-5)).toBe(arcWidth(0))
  })
})

describe('planeRate', () => {
  it('is zero without traffic and bounded with a lot', () => {
    expect(planeRate(0)).toBe(0)
    expect(planeRate(1)).toBeGreaterThanOrEqual(0.02)
    expect(planeRate(1e7)).toBeLessThanOrEqual(0.4)
  })
})

describe('distanceToSegment', () => {
  it('measures to the nearest point of the segment, ends included', () => {
    expect(distanceToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(3)
    expect(distanceToSegment(-4, 3, 0, 0, 10, 0)).toBeCloseTo(5)
    expect(distanceToSegment(1, 1, 2, 2, 2, 2)).toBeCloseTo(Math.SQRT2)
  })
})

describe('placeVendors', () => {
  const specs = [
    { id: 'v1', callers: ['p0', 'p3'], front: 15, r: 18 },
    { id: 'v2', callers: ['p0'], front: 15, r: 18 },
    { id: 'v3', callers: ['p5'], front: 15, r: 18 },
    { id: 'v4', callers: [], front: 15, r: 18 },
  ]

  it('stands every vendor clear of every island, the hub and the other vendors', () => {
    const islands = ring(8)
    const out = placeVendors(islands, hub, specs)
    expect(out).toHaveLength(specs.length)
    const discs = [hub, ...islands, ...out.map((o) => ({ id: o.id, x: o.x, z: o.z, r: 18 }))]
    for (const a of discs) for (const b of discs) if (a.id < b.id) expect(Math.hypot(a.x - b.x, a.z - b.z), `${a.id} / ${b.id}`).toBeGreaterThan(a.r + b.r)
  })

  it('puts a vendor outward of its main caller and gives that caller the bridge', () => {
    const islands = ring(8)
    const [v1] = placeVendors(islands, hub, specs)
    expect(v1.primary).toBe('p0')
    expect(v1.bridges[0]).toBe('p0')
    expect(Math.hypot(v1.x, v1.z)).toBeGreaterThan(150 + 30)
  })

  it('leaves a vendor nobody with an island calls without a primary or bridge', () => {
    const v4 = placeVendors(ring(8), hub, specs).find((o) => o.id === 'v4')!
    expect(v4.primary).toBeNull()
    expect(v4.bridges).toEqual([])
  })

  it('still places everything in a crowded 24-island town', () => {
    const inner = ring(12, 220), outer = ring(12, 380).map((d) => ({ ...d, id: `o${d.id}` }))
    const islands = [...inner, ...outer]
    const many = islands.slice(0, 10).map((d, i) => ({ id: `v${i}`, callers: [d.id], front: 15, r: 18 }))
    const out = placeVendors(islands, hub, many)
    expect(out).toHaveLength(10)
    for (const o of out) for (const i of islands) expect(Math.hypot(o.x - i.x, o.z - i.z)).toBeGreaterThan(i.r + 18)
  })
})

describe('placeAirport', () => {
  it('stands north of everything and connects when the corridor is clear', () => {
    const a = placeAirport(ring(6).filter((d) => d.x !== 0 && Math.abs(d.x) > 60), hub, -40, 20)
    expect(a.z).toBeLessThan(-150)
    expect(a.connected).toBe(true)
  })

  it('has no bridge when an island stands in the corridor, but is still placed', () => {
    const a = placeAirport([{ id: 'n', x: 0, z: -140, r: 30 }], hub, -40, 20)
    expect(a.connected).toBe(false)
    expect(a.z).toBeLessThan(-170)
  })
})

describe('snapshot signals', () => {
  it('counts stale systems and stale vendors', () => {
    const s = calm()
    const before = staleCount(s)
    s.groups[0].nodes[0].state = 'Stale'
    if (s.vendors[0]) s.vendors[0].node.state = 'Stale'
    expect(staleCount(s)).toBe(before + 1 + (s.vendors[0] ? 1 : 0))
  })

  it('accepts a snapshot without the new fields and fills them in', () => {
    const raw = JSON.parse(JSON.stringify(calm())) as Record<string, unknown>
    delete raw.vendors
    delete raw.externalCallers
    delete raw.dependencies
    for (const g of raw.groups as Record<string, unknown>[]) delete g.incidents
    const { snapshot } = checkSnapshot(raw)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.vendors).toEqual([])
    expect(snapshot!.dependencies).toEqual([])
    expect(snapshot!.groups.every((g) => g.incidents.length === 0)).toBe(true)
  })

  it('drops malformed incidents and vendors instead of refusing the snapshot', () => {
    const raw = JSON.parse(JSON.stringify(calm())) as Record<string, unknown>
    raw.vendors = [42, null, { node: 'x' }]
    ;(raw.groups as Record<string, unknown>[])[0].incidents = [7, null]
    const { snapshot } = checkSnapshot(raw)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.vendors).toEqual([])
  })
})
