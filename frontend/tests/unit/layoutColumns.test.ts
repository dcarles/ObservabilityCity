import { describe, expect, it } from 'vitest'
import { COL_X, PAD_PITCH, PAD_W, laneStart, padX, padsPerRow, planIsland, rowEdge } from '../../src/scene/plan'
import { makeOutline } from '../../src/scene/island'
import { hashString } from '../../src/scene/random'
import type { GroupSnapshot, NodeSnapshot } from '../../src/types'

// An island puts more pads on each row road as it gets bigger: 2, 4 or 6 a row, half on each side of the spine.

function node(id: string, kind: NodeSnapshot['kind'], service: string): NodeSnapshot {
  return { id, name: id, kind, service, external: false, state: 'Healthy', calls: [] } as unknown as NodeSnapshot
}

function island(code: string, services: number): GroupSnapshot {
  const nodes: NodeSnapshot[] = []
  for (let i = 1; i <= services; i++)
    nodes.push(node(`${code}.s${i}-api`, 'Api', `s${i}`), node(`${code}.s${i}-worker`, 'Worker', `s${i}`), node(`${code}.s${i}-db`, 'Database', `s${i}`))
  return { id: code, displayName: code, color: '#5aa9ff', isHub: false, isLostFound: false, configError: null, incidents: [], hasBridge: true, hasRingBridge: false, messaging: { topics: [], subscriptions: [] }, nodes }
}

describe('pads on a row', () => {
  it.each([[1, 2], [2, 2], [10, 2], [11, 4], [15, 4], [24, 4], [25, 6], [40, 6]])('%i pads: %i a row', (pads, perRow) => {
    expect(padsPerRow(pads)).toBe(perRow)
  })

  it.each([[1, 1], [2, 1], [5, 3], [10, 5], [11, 3], [15, 4], [24, 6], [25, 5], [30, 5]])('%i services fill %i rows', (services, rows) => {
    expect(planIsland(island('p', services)).rows).toBe(rows)
  })

  it('keeps a small island exactly as it was: pads alternate left and right of the spine', () => {
    const plan = planIsland(island('p', 5))
    expect(plan.pads.map((p) => [p.col, p.ring, p.row])).toEqual([[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1], [0, 0, 2]])
    expect(plan.pads.map(padX)).toEqual([-COL_X, COL_X, -COL_X, COL_X, -COL_X])
  })

  it('fills a row from the spine outwards, one pad each side in turn', () => {
    const plan = planIsland(island('p', 15))
    expect(plan.pads.slice(0, 5).map((p) => [p.col, p.ring])).toEqual([[0, 0], [1, 0], [0, 1], [1, 1], [0, 0]])
    expect(plan.pads.slice(0, 4).map(padX)).toEqual([-COL_X, COL_X, -COL_X - PAD_PITCH, COL_X + PAD_PITCH])
  })

  it('never puts two pads in the same place, and keeps each row road as wide as its outermost pad', () => {
    for (const services of [3, 10, 11, 15, 24, 25, 27, 40]) {
      const plan = planIsland(island('p', services))
      const spots = plan.pads.map((p) => `${padX(p)}/${p.row}`)
      expect(new Set(spots).size, `${services} services`).toBe(spots.length)
      const edge = rowEdge(plan.pads)
      for (const p of plan.pads) expect(Math.abs(padX(p)) + PAD_W / 2, `${services} services`).toBeLessThanOrEqual(edge)
      // neighbouring pads on a row do not touch
      for (const a of plan.pads) for (const b of plan.pads) if (a !== b && a.row === b.row) expect(Math.abs(padX(a) - padX(b))).toBeGreaterThan(PAD_PITCH - 1e-6)
    }
  })

  it('keeps every building inside the coast, for every size up to 40 services', () => {
    for (let services = 1; services <= 40; services++) {
      const g = island('p', services)
      const plan = planIsland(g)
      const outline = makeOutline(hashString(g.id), plan.rx, plan.rz, 0.06)
      for (const p of plan.placed) expect(outline.contains(p.x, p.z, 2), `${p.node.id} of ${services} services is off the island`).toBe(true)
    }
  })

  it('sizes a big island to its grid and no more: bigger islands are bigger, but never by more than the pads need', () => {
    const area = (s: number) => { const p = planIsland(island('p', s)); return p.rx * p.rz }
    // the coast of 15 services was once 52 times too big (the search for its far edge stopped at 90 units)
    expect(planIsland(island('p', 15)).rx).toBeLessThan(110)
    expect(planIsland(island('p', 27)).rx).toBeLessThan(150)
    for (let s = 2; s <= 40; s++) expect(area(s)).toBeLessThan(area(s - 1) * 2)
    // a wide island is about as wide as deep, not a strip
    for (const s of [15, 20, 27, 35]) {
      const p = planIsland(island('p', s))
      expect(p.rx / p.rz, `${s} services`).toBeLessThan(1.4)
    }
  })

  it('starts a service lane beside the spine for the first pad of a row, and at its own pad for the ones further out', () => {
    expect(laneStart({ col: 0, ring: 0 })).toBe(5)
    expect(laneStart({ col: 1, ring: 1 })).toBeCloseTo(COL_X + PAD_PITCH - PAD_W / 2 - 0.4)
  })
})
