import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pillarTraffic } from '../../src/trafficFlow'
import { pillarFlowHtml } from '../../src/dashboard/render'
import type { Snapshot } from '../../src/types'

const golden = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}.json`), 'utf8')) as Snapshot

/** The calm town where the pillars `a` and `b` take in 100 and 40 requests a second, with only the links we say: [from, to, requests a second]. */
function withLinks(links: [string, string, number][], outside = 0): Snapshot {
  const s = golden('calm')
  for (const g of s.groups) for (const n of g.nodes) { n.requestsPerSecond = 0; n.outsideRequestsPerSecond = null }
  const [a, b] = s.groups.filter((g) => !g.isHub)
  a.nodes[0].requestsPerSecond = 100
  a.nodes[0].outsideRequestsPerSecond = outside
  b.nodes[0].requestsPerSecond = 40
  s.dependencies = links.map(([from, to, requestsPerSecond]) => ({ from, to, requestsPerSecond }))
  return s
}

describe('traffic in, out and inside a pillar', () => {
  const pillars = golden('calm').groups.filter((g) => !g.isHub)
  const [a, b, c] = pillars

  it('counts a call from another pillar as in for the callee and out for the caller, a call from outside as in, and the rest of what it takes in as inside', () => {
    const t = pillarTraffic(withLinks([[b.id, a.id, 30], ['hub', a.id, 20]], 10))
    expect(t.get(a.id)).toEqual({ id: a.id, in: 60, out: 0, internal: 40 })
    expect(t.get(b.id)).toEqual({ id: b.id, in: 0, out: 30, internal: 40 })
  })

  it('does not count what goes to the hub or a third party as out, nor a link inside the pillar', () => {
    const t = pillarTraffic(withLinks([[a.id, 'hub', 50], [a.id, 'some-vendor', 5], [a.id, a.id, 9]]))
    expect(t.get(a.id)).toEqual({ id: a.id, in: 0, out: 0, internal: 100 })
  })

  it('has nothing for a pillar that takes in and sends no request', () => {
    const t = pillarTraffic(withLinks([]))
    expect(t.has(c.id)).toBe(false)
  })

  it('shows traffic in and out on the card, closed and open', () => {
    const split = { in: 144, out: 60, internal: 20 }
    expect(pillarFlowHtml(null, false, split)).toContain('traffic in <i>144 rps</i> · out <i>60 rps</i>')
    const open = pillarFlowHtml(null, true, split)
    expect(open).toContain('Requests in')
    expect(open).toContain('Requests inside')
    expect(pillarFlowHtml(null, false, { in: 0, out: 0, internal: 0 })).toBe('')
  })
})
