import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildDashboard, byRate, groupTitle, latencyLevel, regionTags, type Row } from '../../src/dashboard/model'
import { pillarHtml, type UiState } from '../../src/dashboard/render'
import { headShift } from '../../src/dashboard/sticky'
import { ALL_TENANTS } from '../../src/tenants'
import type { NodeSnapshot, Snapshot } from '../../src/types'

const golden = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}.json`), 'utf8')) as Snapshot
const node = (s: Snapshot, id: string): NodeSnapshot => s.groups.flatMap((g) => g.nodes).find((n) => n.id === id)!
const rowsOf = (s: Snapshot): Row[] => buildDashboard(s, ALL_TENANTS).pillars.flatMap((p) => p.groups.flatMap((g) => g.rows))
const row = (s: Snapshot, id: string): Row => rowsOf(s).find((r) => r.id === id)!
/** The table of one pillar with every group and the listed services' connections open. */
function table(s: Snapshot, pillar: string, connections: string[] = []): string {
  const p = buildDashboard(s, ALL_TENANTS).pillars.find((x) => x.id === pillar)!
  const ui: UiState = { openPillars: new Set([pillar]), groups: new Map(p.groups.map((g) => [g.key, true])), databases: new Map(), connections: new Set(connections), sections: new Set() }
  return pillarHtml(p, ui)
}
const twoRegions = (n: NodeSnapshot): void => {
  n.regions = [
    { region: 'neu', label: 'North', instances: 2, cpu: 0.35, memory: 0.6, share: 0.62, skewed: false },
    { region: 'weu', label: 'West', instances: 1, cpu: 0.41, memory: 0.66, share: 0.38, skewed: false },
  ]
}

describe('latency against the target', () => {
  it('is green under the target, amber from 90% of it, red over it, and has no colour without a target or a number', () => {
    expect(latencyLevel(80, 100)).toBe('ok')
    expect(latencyLevel(89.9, 100)).toBe('ok')
    expect(latencyLevel(90, 100)).toBe('warn')
    expect(latencyLevel(100, 100)).toBe('warn')
    expect(latencyLevel(100.1, 100)).toBe('bad')
    expect(latencyLevel(50, null)).toBe('none')
    expect(latencyLevel(50, 0)).toBe('none')
    expect(latencyLevel(null, 100)).toBe('none')
  })

  it('shows the p99 coloured, with the SLA below it, and the SLA line only when there is a target', () => {
    const s = golden('calm')
    const n = node(s, 'pay.payments-api')
    n.p99Ms = 400; n.slaP99Ms = 500
    expect(row(s, 'pay.payments-api').latency).toBe('ok')
    expect(table(s, 'pay')).toContain('class="lat ok"')
    expect(table(s, 'pay')).toContain('SLA 500 ms')
    n.p99Ms = 520
    expect(row(s, 'pay.payments-api').latency).toBe('bad')
    expect(table(s, 'pay')).toContain('class="lat bad"')
    n.slaP99Ms = 0
    expect(row(s, 'pay.payments-api').sla).toBeNull()
    const html = table(s, 'pay')
    const mine = html.slice(html.indexOf('data-system="pay.payments-api"'), html.indexOf('data-system="pay.payments-worker"'))
    expect(mine).not.toContain('class="sla"')
    expect(mine).toContain('class="lat none"')
  })
})

describe('errors', () => {
  it('are green at 0 and red above 0', () => {
    const s = golden('calm')
    node(s, 'pay.payments-api').errorRate = 0
    const clean = table(s, 'pay')
    expect(clean).toMatch(/class="errok">0\.0%/)
    node(s, 'pay.payments-api').errorRate = 0.004
    expect(table(s, 'pay')).toMatch(/class="err">0\.4%/)
  })
})

describe('regions', () => {
  it('names the instances per region under the service, and the plain count for one region', () => {
    const s = golden('calm')
    twoRegions(node(s, 'pay.payments-api'))
    expect(row(s, 'pay.payments-api').instancesText).toBe('2 North · 1 West')
    expect(table(s, 'pay')).toContain('API · 2 North · 1 West')
    const one = row(s, 'pay.payments-worker')
    expect(one.regions).toBeNull()
    expect(one.instancesText).toMatch(/^\d+ instances?$/)
  })

  it('splits the traffic by region only for a service in two regions', () => {
    const s = golden('calm')
    twoRegions(node(s, 'pay.payments-api'))
    const html = table(s, 'pay')
    expect(html).toContain('North 62% · West 38%')
    expect(html.match(/class="rg"/g)).toHaveLength(1)
  })

  it('shows CPU and memory as one bar and one figure for each region, and a single bar for one region', () => {
    const s = golden('calm')
    twoRegions(node(s, 'pay.payments-api'))
    const r = row(s, 'pay.payments-api')
    expect(r.regions!.map((g) => [g.tag, g.cpu, g.memory])).toEqual([['N', 35, 60], ['W', 41, 66]])
    const html = table(s, 'pay')
    const rseg = html.match(/class="rseg"/g) ?? []
    expect(rseg).toHaveLength(4) // CPU and Mem, each for two regions
    const single = row(s, 'pay.payments-worker')
    expect(single.cpu).not.toBeNull()
  })

  it('gives each region its own tag, with two letters where the first letters match', () => {
    expect(regionTags(['North', 'West'])).toEqual(['N', 'W'])
    expect(regionTags(['North Europe', 'North America'])).toEqual(['No', 'No'])
    expect(regionTags(['East', 'North', 'West'])).toEqual(['E', 'N', 'W'])
  })
})

describe('databases', () => {
  it('shows the max throughput of the worst tenant, named, not the largest limit', () => {
    const s = golden('tenants-town')
    const db = node(s, 'aa.orders-db')
    const [a, b, c] = db.tenants!
    a.utilisation = 0.3; a.limit = 8000
    b.utilisation = 0.9; b.limit = 4000
    c.utilisation = 0.5; c.limit = 1000
    const r = row(s, 'aa.orders-db')
    expect(r.ruMax).toEqual({ limit: 4000, tenant: b.name })
    const html = table(s, 'aa')
    expect(html).toContain('max 4,000 RU/s')
  })

  it('shows no max when the worst tenant has no limit, and each tenant line its own max', () => {
    const s = golden('tenants-town')
    const db = node(s, 'aa.orders-db')
    for (const u of db.tenants!) u.limit = null
    expect(row(s, 'aa.orders-db').ruMax).toBeNull()
    const other = db.tenants![1]
    other.limit = 7777
    expect(row(s, 'aa.orders-db').tenants!.find((t) => t.id === other.id)!.limit).toBe(7777)
    expect(table(s, 'aa')).toContain('max 7,777 RU/s') // on that tenant's own line
  })
})

describe('connections', () => {
  it('says how many callers and calls, keeps the chips closed until asked, and lists the busiest first', () => {
    const s = golden('calm')
    const id = rowsOf(s).find((r) => r.calledBy.length > 0 && r.calls.length > 0)?.id ?? rowsOf(s).find((r) => r.calledBy.length > 0)!.id
    const r = row(s, id)
    const pillar = id.split('.')[0]!
    const closed = table(s, pillar)
    expect(closed).toContain(`data-conn="${id}"`)
    expect(closed).toContain(`${r.calledBy.length} caller`)
    expect(closed).not.toContain('class="cx"')
    expect(table(s, pillar, [id])).toContain('class="cx"')
  })

  it('orders chips by the rate they send, a chip with no rate last', () => {
    const chips = [{ id: 'a', name: 'A', rps: null }, { id: 'b', name: 'B', rps: 3 }, { id: 'c', name: 'C', rps: 30 }]
    expect(byRate(chips).map((c) => c.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('queues stay out of the table', () => {
  it('shows no backlog or dead letters in the service table, only the pillar card keeps its dead letter count', () => {
    const s = golden('bad-day')
    const html = table(s, 'dsp')
    const tbl = html.slice(html.indexOf('<table class="svc"'), html.indexOf('</table>'))
    expect(tbl).not.toMatch(/Backlog|DLQ|dead|waiting/i)
  })
})

describe('names', () => {
  it('turns a service id into words for the group header and leaves capitals alone', () => {
    expect(groupTitle('merchant-gateway')).toBe('Merchant Gateway')
    expect(groupTitle('rate-card')).toBe('Rate Card')
    expect(groupTitle('sca')).toBe('Sca')
    expect(groupTitle('API')).toBe('API')
    expect(groupTitle('my_service.v2')).toBe('My Service V2')
    expect(groupTitle('')).toBe('')
  })
})

describe('sticky column titles', () => {
  it('do not move while the last service row is below them, then leave with it', () => {
    expect(headShift(56, 52, 500)).toBe(0)
    expect(headShift(56, 52, 108)).toBe(0)
    expect(headShift(56, 52, 100)).toBe(-8)
    expect(headShift(56, 52, 60)).toBe(-48)
    expect(headShift(56, 52, -300)).toBe(-408)
  })
})
