import { describe, expect, it } from 'vitest'
import { planIsland } from './plan'
import { layoutTown, RING_CAPACITY } from './layout'
import { layoutInvariants } from './layout.testutil'
import { makeOutline } from './island'
import { hashString } from './random'
import type { GroupSnapshot, NodeSnapshot } from '../types'

// The biggest town the design allows: 24 islands, from 2 systems to 25 on one island. The sizes are those of the
// stress-24 registry that the backend and browser tests load, so all three agree on what "the maximum" is.
const SIZES = [2, 25, 3, 18, 5, 12, 4, 22, 6, 9, 2, 15, 7, 20, 3, 11, 8, 25, 4, 14, 6, 10, 2, 16]

function node(id: string, kind: NodeSnapshot['kind'], service: string | null): NodeSnapshot {
  return { id, name: id, kind, service, external: false, state: 'Healthy', calls: [] } as unknown as NodeSnapshot
}

/** n systems in the same shape as the stress registry: whole services (API, worker, database), then a remainder. */
function island(code: string, n: number): GroupSnapshot {
  const nodes: NodeSnapshot[] = []
  const full = Math.floor(n / 3)
  for (let i = 1; i <= full; i++)
    nodes.push(node(`${code}.s${i}-api`, 'Api', `s${i}`), node(`${code}.s${i}-worker`, 'Worker', `s${i}`), node(`${code}.s${i}-db`, 'Database', `s${i}`))
  if (n % 3 === 1) nodes.push(node(`${code}.session-cache`, 'Cache', null))
  if (n % 3 === 2) nodes.push(node(`${code}.s${full + 1}-api`, 'Api', `s${full + 1}`), node(`${code}.s${full + 1}-db`, 'Database', `s${full + 1}`))
  return { id: code, displayName: code, color: '#5aa9ff', isHub: false, isLostFound: false, configError: null, nodes }
}

const groups = SIZES.map((n, i) => island(`p${String(i + 1).padStart(2, '0')}`, n))
const plans = groups.map((g) => planIsland(g))
const sizes = plans.map((p) => ({ rx: p.rx, rz: p.rz }))

describe('the 24-island stress town', () => {
  it('has the sizes the stress registry has', () => {
    expect(groups.map((g) => g.nodes.length)).toEqual(SIZES)
  })

  it('puts every system on its island grid exactly once, however many there are', () => {
    groups.forEach((g, i) => expect(plans[i].placed.map((p) => p.node.id).sort()).toEqual(g.nodes.map((n) => n.id).sort()))
  })

  it('sizes islands to their contents: the 25-system island is clearly bigger than the 2-system one', () => {
    const big = plans[SIZES.indexOf(25)], small = plans[SIZES.indexOf(2)]
    expect(big.rx * big.rz).toBeGreaterThan(small.rx * small.rz * 1.8)
  })

  it('keeps every building inside its island coast', () => {
    plans.forEach((plan, i) => {
      const outline = makeOutline(hashString(groups[i].id), plan.rx, plan.rz, 0.06)
      for (const p of plan.placed) expect(outline.contains(p.x, p.z, 2), `${p.node.id} is off its island`).toBe(true)
    })
  })

  it('stands twelve islands on the first ring and twelve on the second', () => {
    const layout = layoutTown(sizes)
    expect(layout.islands.filter((x) => x.ring === 1)).toHaveLength(RING_CAPACITY)
    expect(layout.islands.filter((x) => x.ring === 2)).toHaveLength(24 - RING_CAPACITY)
  })

  it('keeps the town to a size one camera can frame', () => {
    const layout = layoutTown(sizes)
    const reach = Math.max(...layout.islands.map((x, i) => x.radius + Math.max(sizes[i].rx, sizes[i].rz)))
    expect(reach).toBeLessThan(900) // the orbit camera's default maximum distance
  })
})

// the same rules as every other layout, with the stress sizes
layoutInvariants('layout of the 24-island stress town', sizes)
