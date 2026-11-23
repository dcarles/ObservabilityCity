import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { layoutDifferences, layoutKey, layoutParts } from '../../src/scene/townHelpers'
import type { Snapshot } from '../../src/types'

const calm = (): Snapshot => JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/calm.json'), 'utf8')) as Snapshot

describe('what the layout of the town depends on, by part', () => {
  it('has the same parts and key for the same snapshot, and numbers that change the picture do not count', () => {
    const a = calm()
    const b = calm()
    for (const g of b.groups) for (const n of g.nodes) n.instancesTotal = (n.instancesTotal ?? 1) + 3
    expect(layoutKey(a)).toBe(layoutKey(b))
    expect(layoutDifferences(layoutParts(a), layoutParts(b))).toEqual(['the order of the groups or systems'])
  })

  it('names a system whose calls changed, with the old and the new calls', () => {
    const a = calm()
    const b = calm()
    const g = b.groups.find((x) => !x.isHub && x.nodes.length > 0)!
    const n = g.nodes[0]
    n.calls = [...n.calls, 'extra.target']
    expect(layoutKey(a)).not.toBe(layoutKey(b))
    const why = layoutDifferences(layoutParts(a), layoutParts(b))
    expect(why).toHaveLength(1)
    expect(why[0]).toContain(`system ${n.id} changed`)
    expect(why[0]).toContain('extra.target')
  })

  it('names a system that went, one that came, and a group whose bridge or flow changed', () => {
    const a = calm()
    const b = calm()
    const g = b.groups.find((x) => !x.isHub && x.nodes.length > 1)!
    const gone = g.nodes.pop()!
    g.hasBridge = g.hasBridge === false
    expect(layoutDifferences(layoutParts(a), layoutParts(b))).toEqual(expect.arrayContaining([`system ${gone.id} went`, expect.stringContaining(`group ${g.id} changed`)]))
    expect(layoutDifferences(layoutParts(b), layoutParts(a))).toContain(`system ${gone.id} came`)
  })
})
