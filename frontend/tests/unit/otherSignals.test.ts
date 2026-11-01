import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { backBridgeClear, distanceToSegment, loopArc, meanDirection, placeVendorsOnRing, ringRoadRadius, VENDOR_SPUR, type Disc } from '../../src/scene/layout'
import { worstSeverity } from '../../src/scene/weather'
import { arcDim, arcLinks, arcWidth } from '../../src/scene/overlay'
import { planeRate } from '../../src/scene/airport'
import { staleCount } from '../../src/ui'
import { checkSnapshot } from '../../src/snapshotGuard'
import type { Snapshot } from '../../src/types'

const calm = () => JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/calm.json'), 'utf8')) as Snapshot

const ring = (n: number, radius = 150): Disc[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    return { id: `p${i}`, x: Math.cos(a) * radius, z: Math.sin(a) * radius, r: 30 }
  })

describe('worstSeverity', () => {
  it('is null for a clear sky and the lowest number otherwise', () => {
    expect(worstSeverity([])).toBeNull()
    expect(worstSeverity([{ severity: 3 }, { severity: 2 }, { severity: 4 }])).toBe(2)
    expect(worstSeverity([{ severity: 1 }])).toBe(1)
  })
})

describe('arcLinks', () => {
  const stands = (id: string) => ['a', 'b', 'c'].includes(id)
  it('keeps every link between two things in the town, however little traffic it carries', () => {
    const links = [{ from: 'a', to: 'b', requestsPerSecond: 12 }, { from: 'a', to: 'c', requestsPerSecond: 0.0004 }, { from: 'b', to: 'c', requestsPerSecond: 0 }]
    expect(arcLinks(links, stands)).toEqual(links)
  })
  it('drops a link whose end is not in the town', () => {
    expect(arcLinks([{ from: 'a', to: 'z', requestsPerSecond: 50 }, { from: 'y', to: 'b', requestsPerSecond: 50 }], stands)).toEqual([])
  })
})

describe('arcDim', () => {
  it('fades nothing when there is no focus', () => {
    expect(arcDim({ from: 'a', to: 'b' }, '')).toBe(false)
  })
  it('keeps the arcs into and out of the focus bright and fades the rest', () => {
    expect(arcDim({ from: 'a', to: 'b' }, 'a')).toBe(false)
    expect(arcDim({ from: 'c', to: 'a' }, 'a')).toBe(false)
    expect(arcDim({ from: 'b', to: 'c' }, 'a')).toBe(true)
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

describe('the ring road', () => {
  it('circles outside every island with room for the landings', () => {
    const islands = ring(8)
    const r = ringRoadRadius(islands)
    for (const i of islands) expect(Math.hypot(i.x, i.z) + i.r).toBeLessThan(r)
    expect(r).toBeGreaterThan(150 + 30 + 20)
  })

  it('lets an island build a bridge straight out to it unless a neighbour stands in the way', () => {
    const islands = ring(8)
    const loopR = ringRoadRadius(islands)
    expect(backBridgeClear(islands[0], 28, islands, loopR)).toBe(true)
    // an island parked right behind it blocks the bridge
    const blocker: Disc = { id: 'b', x: islands[0].x * 1.35, z: islands[0].z * 1.35, r: 30 }
    expect(backBridgeClear(islands[0], 28, [...islands, blocker], loopR)).toBe(false)
  })
})

describe('meanDirection', () => {
  it('is the side most directions lie on, and null when they cancel out', () => {
    expect(meanDirection([0.1, -0.1, 0])).toBeCloseTo(0)
    expect(meanDirection([Math.PI / 2, Math.PI / 2])).toBeCloseTo(Math.PI / 2)
    expect(meanDirection([0, Math.PI])).toBeNull()
  })
})

describe('placeVendorsOnRing', () => {
  const specs = [
    { id: 'v1', callerAngles: [0.1, 0.3, -0.2], front: 15 },
    { id: 'v2', callerAngles: [Math.PI, Math.PI - 0.3], front: 15 },
    { id: 'v3', callerAngles: [], front: 15 },
    { id: 'v4', callerAngles: [-Math.PI / 2, -2], front: 15 },
  ]

  it('stands every vendor outside the loop, on a spur the length of the spur road', () => {
    const out = placeVendorsOnRing(500, specs)
    expect(out.map((v) => v.id)).toEqual(['v1', 'v2', 'v3', 'v4'])
    for (const v of out) {
      expect(Math.hypot(v.loopX, v.loopZ)).toBeCloseTo(500)
      expect(Math.hypot(v.x, v.z)).toBeCloseTo(500 + VENDOR_SPUR + 15)
    }
  })

  it('gives each vendor a place of its own, spread round the loop', () => {
    const out = placeVendorsOnRing(500, specs)
    for (let a = 0; a < out.length; a++)
      for (let b = a + 1; b < out.length; b++) expect(Math.hypot(out[a].x - out[b].x, out[a].z - out[b].z)).toBeGreaterThan(300)
  })

  it('puts a vendor on the side its callers are on', () => {
    const out = placeVendorsOnRing(500, specs)
    const side = (id: string) => out.find((v) => v.id === id)!.angle
    expect(Math.abs(side('v1'))).toBeLessThan(1.2)
    expect(Math.abs(Math.abs(side('v2')) - Math.PI)).toBeLessThan(1.2)
  })

  it('places nothing for no vendors', () => {
    expect(placeVendorsOnRing(500, [])).toEqual([])
  })
})

describe('loopArc', () => {
  it('goes the short way round, on the loop, from one direction to the other', () => {
    const arc = loopArc(400, 0.2, -0.4)
    expect(arc[0].x).toBeCloseTo(Math.sin(0.2) * 400)
    expect(arc[arc.length - 1].z).toBeCloseTo(-Math.cos(-0.4) * 400)
    for (const p of arc) expect(Math.hypot(p.x, p.z)).toBeCloseTo(400)
    // across the seam at south the short way is through +-pi, not the long way round
    const seam = loopArc(400, 3, -3)
    expect(seam.length).toBeLessThan(10)
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
