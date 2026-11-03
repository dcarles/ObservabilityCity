import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildDashboard, pillarSelection, worstOf } from '../../src/dashboard/model'
import { databaseIsOpen, groupIsOpen, hiddenHtml, pillarHtml, summaryHtml, type UiState } from '../../src/dashboard/render'
import { ALL_TENANTS } from '../../src/tenants'
import { checkSnapshot } from '../../src/snapshotGuard'
import type { NodeSnapshot, Snapshot } from '../../src/types'

const golden = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}.json`), 'utf8')) as Snapshot
const ui = (over: Partial<UiState> = {}): UiState => ({ openPillars: new Set(), groups: new Map(), databases: new Map(), connections: new Set(), sections: new Set(), ...over })
const node = (s: Snapshot, id: string): NodeSnapshot => s.groups.flatMap((g) => g.nodes).find((n) => n.id === id)!

describe('summary counts', () => {
  it('counts nothing and says all is healthy on a calm town', () => {
    const d = buildDashboard(golden('calm'), ALL_TENANTS)
    expect(d.summary.down).toBe(0)
    expect(d.summary.degraded).toBe(0)
    expect(summaryHtml(d)).toContain('All services are healthy')
    expect(summaryHtml(d)).toContain('0 down · 0 degraded')
  })

  it('counts down and degraded services, names each with its pillar, and never uses an overall health word', () => {
    const s = golden('bad-day')
    const d = buildDashboard(s, ALL_TENANTS)
    expect(d.summary.down).toBe(s.totals.down)
    expect(d.summary.degraded).toBe(s.totals.degraded)
    expect(d.summary.affected).toHaveLength(d.summary.down + d.summary.degraded)
    expect(d.summary.affected[0].level).toBe('bad') // worst first
    const html = summaryHtml(d)
    expect(html).toContain('Payments API')
    expect(html).not.toMatch(/\b(unhealthy|critical|outage)\b/i)
  })

  it('splits traffic into external and internal, and leaves a tile out when no one measures it', () => {
    const s = golden('calm')
    const d = buildDashboard(s, ALL_TENANTS)
    expect(d.summary.traffic!.total).toBeCloseTo(s.totals.requestsPerSecond)
    expect(d.summary.traffic!.external + d.summary.traffic!.internal).toBeCloseTo(d.summary.traffic!.total)
    for (const g of s.groups) for (const n of g.nodes) n.absent = [...n.absent, 'requests', 'deadLetters', 'backlog']
    const bare = buildDashboard(s, ALL_TENANTS)
    expect(bare.summary.traffic).toBeNull()
    expect(bare.summary.deadLetters).toBeNull()
    expect(summaryHtml(bare)).not.toContain('Total traffic')
  })
})

describe('pillar cards', () => {
  it('a green pillar with no dead letters shows only its name and dot', () => {
    const d = buildDashboard(golden('calm'), ALL_TENANTS)
    const html = pillarHtml(d.pillars[0], ui())
    expect(html).toContain('card ok')
    expect(html).not.toContain('class="m"')
    expect(html).not.toContain('class="issues"')
  })

  it('a pillar in trouble shows counts, dead letters and one chip with the reason for each affected service', () => {
    const d = buildDashboard(golden('bad-day'), ALL_TENANTS)
    const pay = d.pillars.find((p) => p.id === 'pay')!
    expect(pay.level).toBe('warn')
    const html = pillarHtml(pay, ui())
    expect(html).toContain('0 down · 1 degraded')
    expect(html).toContain('error rate 21.2%')
    const dsp = d.pillars.find((p) => p.id === 'dsp')!
    expect(dsp.level).toBe('bad')
    expect(dsp.issues.every((i) => i.reason)).toBe(true)
  })

  it('never shows a pillar-level rate, error rate or latency', () => {
    const html = pillarHtml(buildDashboard(golden('bad-day'), ALL_TENANTS).pillars[1], ui())
    expect(html).not.toMatch(/class="m"><span>(rps|Errors?|p99|Latency)/i)
  })

  it('grey (no data) never counts as healthy or as affected', () => {
    const s = golden('calm')
    node(s, 'pay.payments-api').state = 'Stale'
    const d = buildDashboard(s, ALL_TENANTS)
    expect(d.summary.degraded + d.summary.down).toBe(0)
    expect(d.pillars.find((p) => p.id === 'pay')!.groups.flatMap((g) => g.rows).find((r) => r.id === 'pay.payments-api')!.level).toBe('none')
  })
})

describe('groups and rows', () => {
  it('sorts groups worst first, opens a group with a problem by itself and starts the others closed', () => {
    const d = buildDashboard(golden('bad-day'), ALL_TENANTS)
    const frd = d.pillars.find((p) => p.id === 'frd')!
    const levels = frd.groups.map((g) => g.level)
    expect(levels).toEqual([...levels].sort((a, b) => ['none', 'ok', 'warn', 'bad'].indexOf(b) - ['none', 'ok', 'warn', 'bad'].indexOf(a)))
    for (const g of frd.groups) expect(groupIsOpen(g, ui())).toBe(g.level === 'warn' || g.level === 'bad')
    const calm = buildDashboard(golden('calm'), ALL_TENANTS)
    expect(calm.pillars.flatMap((p) => p.groups).some((g) => groupIsOpen(g, ui()))).toBe(false)
  })

  it('what the viewer chose beats the default', () => {
    const g = buildDashboard(golden('bad-day'), ALL_TENANTS).pillars.find((p) => p.id === 'frd')!.groups[0]
    expect(groupIsOpen(g, ui({ groups: new Map([[g.key, false]]) }))).toBe(false)
  })

  it('shows a dash, not a zero, for what nothing measures, and a database has no request rate', () => {
    const s = golden('calm')
    const api = node(s, 'pay.payments-api')
    api.absent = [...api.absent, 'latency', 'cpu']
    const d = buildDashboard(s, ALL_TENANTS)
    const rows = d.pillars.flatMap((p) => p.groups.flatMap((g) => g.rows))
    const r = rows.find((x) => x.id === 'pay.payments-api')!
    expect(r.p99).toBeNull()
    expect(r.cpu).toBeNull()
    expect(rows.filter((x) => x.type === 'DB').every((x) => x.rps === null)).toBe(true)
  })

  it('lists callers and callees from real links only, with the rate when it is measured', () => {
    const s = golden('calm')
    const d = buildDashboard(s, ALL_TENANTS)
    const rows = d.pillars.flatMap((p) => p.groups.flatMap((g) => g.rows))
    for (const r of rows) for (const c of r.calls) {
      const callee = rows.find((x) => x.id === c.id)
      if (callee) expect(callee.calledBy.some((b) => b.id === r.id)).toBe(true)
    }
    const declared = new Set(s.groups.flatMap((g) => g.nodes).flatMap((n) => [...n.calls, ...n.gatewayCalls].map((c) => `${n.id}>${c}`)))
    for (const r of rows) for (const c of r.calls) if (!s.vendors.some((v) => v.node.id === c.id)) expect(declared.has(`${r.id}>${c.id}`)).toBe(true)
  })
})

describe('tenant databases', () => {
  const s = () => golden('tenants-town')

  it('lists one line per tenant, tags test tenants and counts them', () => {
    const d = buildDashboard(s(), ALL_TENANTS)
    const db = d.pillars.flatMap((p) => p.groups.flatMap((g) => g.rows)).find((r) => r.id === 'aa.orders-db')!
    expect(db.tenants!.length).toBe(node(s(), 'aa.orders-db').tenants!.length)
    expect(db.tenants!.some((t) => t.test)).toBe(true)
  })

  it('hide test tenants removes them, and following some tenants keeps only those', () => {
    const base = buildDashboard(s(), ALL_TENANTS).pillars.flatMap((p) => p.groups.flatMap((g) => g.rows)).find((r) => r.id === 'aa.orders-db')!
    const noTest = buildDashboard(s(), { hideTest: true, tenants: [] }).pillars.flatMap((p) => p.groups.flatMap((g) => g.rows)).find((r) => r.id === 'aa.orders-db')!
    expect(noTest.tenants!.some((t) => t.test)).toBe(false)
    expect(noTest.tenants!.length).toBeLessThan(base.tenants!.length)
    const one = base.tenants!.find((t) => !t.test)!.id
    const followed = buildDashboard(s(), { hideTest: false, tenants: [one] }).pillars.flatMap((p) => p.groups.flatMap((g) => g.rows)).find((r) => r.id === 'aa.orders-db')!
    expect(followed.tenants!.map((t) => t.id)).toEqual([one])
  })

  it('opens by itself when a tenant is at its amber line or throttled, not otherwise', () => {
    const calm = s()
    for (const u of node(calm, 'aa.orders-db').tenants!) { u.utilisation = 0.2; u.throttled = 0 }
    const row = (snap: Snapshot) => buildDashboard(snap, ALL_TENANTS).pillars.flatMap((p) => p.groups.flatMap((g) => g.rows)).find((r) => r.id === 'aa.orders-db')!
    expect(databaseIsOpen(row(calm), ui())).toBe(false)
    const hot = structuredClone(calm)
    const n = node(hot, 'aa.orders-db')
    n.tenants![0].utilisation = n.resourceAmber + 0.01
    expect(databaseIsOpen(row(hot), ui())).toBe(true)
    expect(databaseIsOpen(row(hot), ui({ databases: new Map([['aa.orders-db', false]]) }))).toBe(false)
    const throttled = structuredClone(calm)
    node(throttled, 'aa.orders-db').tenants![1].throttled = node(throttled, 'aa.orders-db').throttleAmber + 0.01
    expect(databaseIsOpen(row(throttled), ui())).toBe(true)
  })
})

describe('hiding pillars', () => {
  it('asks for every pillar but the hidden one, and for no filter once all are shown again', () => {
    const s = golden('calm')
    const ids = buildDashboard(s, ALL_TENANTS).choices.map((c) => c.id)
    const without = pillarSelection(s, ids[0], false)
    expect(without).not.toContain(ids[0])
    expect(without).toEqual(expect.arrayContaining(ids.slice(1)))
    const filtered = { ...s, groups: s.groups.filter((g) => g.id !== ids[0]), view: { ...s.view, hidden: [{ id: ids[0], displayName: 'x', vendor: false }] } }
    expect(pillarSelection(filtered, ids[0], true)).toEqual([])
  })

  it('offers hidden pillars back as show buttons', () => {
    const s = golden('calm')
    const first = s.groups.find((g) => !g.isHub)!
    const filtered = { ...s, groups: s.groups.filter((g) => g.id !== first.id), view: { ...s.view, hidden: [{ id: first.id, displayName: first.displayName, vendor: false }] } }
    const d = buildDashboard(filtered, ALL_TENANTS)
    expect(d.hidden).toEqual([{ id: first.id, name: first.displayName }])
    expect(hiddenHtml(d)).toContain(`data-show="${first.id}"`)
    expect(hiddenHtml(buildDashboard(s, ALL_TENANTS))).toBe('')
  })
})

describe('the reason reaches the page', () => {
  it('the snapshot guard keeps the reason line', () => {
    const s = golden('bad-day')
    const { snapshot } = checkSnapshot(s)
    expect(node(snapshot!, 'pay.payments-api').reason).toBe('error rate 21.2%')
  })
})

describe('no convention is built in', () => {
  // A town shaped nothing like the samples: other names, no service codes, nothing grouped, a pillar with only a function, an odd id scheme.
  const odd = (): Snapshot => {
    const s = golden('calm')
    const base = s.groups.find((g) => !g.isHub)!.nodes[0]
    const mk = (id: string, name: string, kind: NodeSnapshot['kind'], over: Partial<NodeSnapshot> = {}): NodeSnapshot => ({ ...base, id, name, kind, service: null, calls: [], gatewayCalls: [], tenants: null, inbound: null, jobs: null, regions: null, queues: null, reason: null, state: 'Healthy', absent: [], ...over })
    return {
      ...s,
      townName: 'Zed Corp',
      vendors: [],
      groups: [
        { ...s.groups[0], isHub: true, nodes: [] },
        { ...s.groups[1], id: 'x-1', displayName: 'Ünïcode Pillar', nodes: [mk('x-1/a', 'Lone thing', 'Function', { state: 'Degraded', reason: 'job nightly late', jobs: [{ name: 'nightly', status: 'Overdue', region: null, lastRun: null, next: null }] }), mk('x-1/b', 'Other', 'Cache')] },
      ],
    }
  }

  it('builds from names and ids that follow no sample convention', () => {
    const d = buildDashboard(odd(), ALL_TENANTS)
    expect(d.townName).toBe('Zed Corp')
    const p = d.pillars.find((x) => x.id === 'x-1')!
    expect(p.name).toBe('Ünïcode Pillar')
    expect(p.groups.map((g) => g.name).sort()).toEqual(['Lone thing', 'Other'])
    expect(p.issues).toEqual([expect.objectContaining({ name: 'Lone thing', level: 'warn', reason: 'job nightly late' })])
    expect(p.jobs).toEqual([expect.objectContaining({ name: 'nightly', status: 'Overdue' })])
    expect(pillarHtml(p, ui({ openPillars: new Set(['x-1']) }))).toContain('Late')
  })

  it('has no company words in the dashboard code', () => {
    for (const f of ['model.ts', 'render.ts', 'dashboard.ts']) {
      const text = readFileSync(resolve(__dirname, '../../src/dashboard', f), 'utf8')
      expect(text).not.toMatch(/\b(acme|newday|multitenant|galactic)\b/i)
    }
  })
})

describe('worstOf', () => {
  it('lets grey count only when nothing else is known', () => {
    expect(worstOf(['none', 'ok'])).toBe('ok')
    expect(worstOf(['none'])).toBe('none')
    expect(worstOf(['ok', 'bad', 'warn'])).toBe('bad')
    expect(worstOf([])).toBe('none')
  })
})
