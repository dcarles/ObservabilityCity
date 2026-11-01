import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ALL_TENANTS, carShown, fillOf, groupTenants, pickTenant, pruneTenants, shownUnits, tenantLabel, tenantLevel, tenantListOrder, tenantTrouble, limitRange, limitText, tenantFigures, throttleWho, throttledText, throttledUnits, toggleTenant, yardLayout, yardSummary, type TenantView } from '../../src/tenants'
import { planPads, planIsland } from '../../src/scene/plan'
import { summariseService } from '../../src/scene/service'
import { worstState } from '../../src/visuals'
import { checkSnapshot } from '../../src/snapshotGuard'
import type { NodeSnapshot, Snapshot, TenantInfo, TenantUnitSnapshot } from '../../src/types'

// tenants-town.json is written by the backend's tests from a real registry (staging: acme and borealis are customers, qa and smoke are test
// tenants, ghost-co is in the readings but not on the list), so these check the renderer's rules against what the backend really sends.
const staging = JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/tenants-town.json'), 'utf8')) as Snapshot
const node = (id: string) => staging.groups.flatMap((g) => g.nodes).find((n) => n.id === id)!
const unit = (kind: TenantUnitSnapshot['kind'], state: TenantUnitSnapshot['state'], throttled: number | null = 0, utilisation: number | null = 0.5): TenantUnitSnapshot =>
  ({ id: 'x', name: 'X', kind, database: 'merchant-x-db', state, utilisation, throttled, requestsPerSecond: 1 })

describe('the colour of a tenant unit', () => {
  it.each([
    ['Customer', 'Healthy', 'green'],
    ['Customer', 'Degraded', 'amber'],
    ['Customer', 'Down', 'red'],
    ['Unknown', 'Down', 'red'],
    ['Customer', 'Stale', 'grey'],
    ['Test', 'Healthy', 'green'],
    ['Test', 'Degraded', 'amber'],
    // a test tenant's trouble is never an alarm
    ['Test', 'Down', 'amber'],
  ] as const)('%s %s is %s', (kind, state, level) => {
    expect(tenantLevel({ kind, state })).toBe(level)
  })
})

describe('the yard sign', () => {
  const units = [unit('Customer', 'Healthy'), unit('Customer', 'Down', 0.4), unit('Test', 'Degraded', 0.3), unit('Unknown', 'Healthy')]
  it('says how many tenants and how many are throttled', () => {
    const s = yardSummary(units, ALL_TENANTS, 0.05)
    expect(s.text).toBe('4 tenants, 2 throttled')
    expect(s.note).toBe('2 throttled: X, X · 1 unknown')
  })
  it('uses the singular for one tenant', () => {
    expect(yardSummary([unit('Customer', 'Healthy')], ALL_TENANTS, 0.05).text).toBe('1 tenant, 0 throttled')
  })
  it('leaves hidden test tenants out of the counts and says so', () => {
    const s = yardSummary(units, { hideTest: true, tenants: [] }, 0.05)
    expect(s.text).toBe('3 tenants, 1 throttled')
    expect(s.note).toBe('1 throttled: X · 1 unknown · 1 test hidden')
  })
  it('counts nothing as throttled until it reaches the amber threshold', () => {
    expect(yardSummary([unit('Customer', 'Healthy', 0.01)], ALL_TENANTS, 0.05).throttled).toBe(0)
    expect(yardSummary([unit('Customer', 'Healthy', null)], ALL_TENANTS, 0.05).throttled).toBe(0)
  })
  it('hides only test tenants', () => {
    expect(shownUnits(units, { hideTest: true, tenants: [] }).map((u) => u.kind)).toEqual(['Customer', 'Customer', 'Unknown'])
  })
  it('stands a unit as high as the capacity it uses, and low when there is no reading', () => {
    expect(fillOf({ utilisation: 0.8 })).toBe(0.8)
    expect(fillOf({ utilisation: 3 })).toBe(1)
    expect(fillOf({ utilisation: null })).toBe(0)
  })
})

describe('the yard layout', () => {
  it.each([1, 3, 4, 10, 25, 40])('puts %i units inside the yard without overlap', (count) => {
    const slots = yardLayout(count, 9, 5)
    expect(slots.length).toBe(count)
    for (const s of slots) {
      expect(Math.abs(s.x) + s.size / 2).toBeLessThanOrEqual(4.5 + 1e-6)
      expect(Math.abs(s.z) + s.size / 2).toBeLessThanOrEqual(2.5 + 1e-6)
    }
    for (let i = 0; i < slots.length; i++)
      for (let j = i + 1; j < slots.length; j++)
        expect(Math.abs(slots[i].x - slots[j].x) >= (slots[i].size + slots[j].size) / 2 - 1e-6 || Math.abs(slots[i].z - slots[j].z) >= (slots[i].size + slots[j].size) / 2 - 1e-6).toBe(true)
  })
  it('draws nothing for no tenants', () => {
    expect(yardLayout(0, 9, 5)).toEqual([])
  })
})

describe('the tenant of a car', () => {
  const tenants: Pick<TenantInfo, 'id' | 'share'>[] = [{ id: 'a', share: 0.75 }, { id: 'b', share: 0.25 }]
  it('follows the shares', () => {
    expect(pickTenant(tenants, 0)).toBe('a')
    expect(pickTenant(tenants, 0.74)).toBe('a')
    expect(pickTenant(tenants, 0.76)).toBe('b')
    expect(pickTenant(tenants, 1)).toBe('b')
  })
  it('splits evenly when no share is known', () => {
    const even = [{ id: 'a', share: 0 }, { id: 'b', share: 0 }]
    expect(pickTenant(even, 0.1)).toBe('a')
    expect(pickTenant(even, 0.9)).toBe('b')
  })
  it('is null when the environment has no tenants', () => {
    expect(pickTenant([], 0.5)).toBeNull()
  })
  const kinds = new Map<string, TenantInfo['kind']>([['a', 'Customer'], ['q', 'Test']])
  const view = (v: Partial<TenantView>): TenantView => ({ ...ALL_TENANTS, ...v })
  it('draws every car with no filter', () => {
    expect(carShown('a', kinds, ALL_TENANTS)).toBe(true)
    expect(carShown('q', kinds, ALL_TENANTS)).toBe(true)
    expect(carShown(null, kinds, ALL_TENANTS)).toBe(true)
  })
  it('draws the cars of every followed tenant, and of nobody else', () => {
    expect(carShown('a', kinds, view({ tenants: ['a', 'q'] }))).toBe(true)
    expect(carShown('q', kinds, view({ tenants: ['a', 'q'] }))).toBe(true)
    expect(carShown('z', kinds, view({ tenants: ['a', 'q'] }))).toBe(false)
  })
  it('draws only the followed tenant', () => {
    expect(carShown('a', kinds, view({ tenants: ['a'] }))).toBe(true)
    expect(carShown('q', kinds, view({ tenants: ['a'] }))).toBe(false)
    expect(carShown(null, kinds, view({ tenants: ['a'] }))).toBe(false)
  })
  it('leaves out test tenants when they are hidden, even a followed one', () => {
    expect(carShown('q', kinds, view({ hideTest: true }))).toBe(false)
    expect(carShown('a', kinds, view({ hideTest: true }))).toBe(true)
    expect(carShown('q', kinds, view({ hideTest: true, tenants: ['q'] }))).toBe(false)
  })
})

describe('the worst state of a service', () => {
  it.each([
    [['Healthy', 'Healthy'], 'Healthy'],
    [['Healthy', 'Degraded'], 'Degraded'],
    [['Degraded', 'Down', 'Healthy'], 'Down'],
    [['Healthy', 'Stale'], 'Stale'],
    [['Stale', 'Degraded'], 'Degraded'],
    [[], 'Healthy'],
  ] as const)('%j is %s', (states, worst) => {
    expect(worstState(states)).toBe(worst)
  })
})

describe('service pads', () => {
  const n = (id: string, service?: string | null): NodeSnapshot => ({ ...node('aa.orders-api'), id, name: id, service: service ?? null })
  it('puts a service on one pad wherever its systems stand in the file', () => {
    const pads = planPads([n('a1', 'orders'), n('b1', 'billing'), n('a2', 'orders'), n('b2', 'billing')], 'g')
    expect(pads.map((p) => [p.name, p.nodes.map((x) => x.id)])).toEqual([['Orders', ['a1', 'a2']], ['Billing', ['b1', 'b2']]])
  })
  it('gives a system with no service a pad of its own, named for it', () => {
    const pads = planPads([n('solo'), n('other')], 'g')
    expect(pads.map((p) => [p.name, p.service])).toEqual([['solo', null], ['other', null]])
  })
  it('splits a big service over pads that carry its name and a part number', () => {
    const pads = planPads(['1', '2', '3', '4'].map((i) => n(i, 'fraud-cases')), 'g')
    expect(pads.map((p) => p.name)).toEqual(['Fraud cases (1)', 'Fraud cases (2)'])
    expect(new Set(pads.map((p) => p.key)).size).toBe(2)
  })
  it('keeps the keys unique across islands', () => {
    expect(planPads([n('a', 'orders')], 'x')[0].key).not.toBe(planPads([n('a', 'orders')], 'y')[0].key)
  })
  it('lays the sample island out with a pad for each service', () => {
    const aa = staging.groups.find((g) => g.id === 'aa')!
    const plan = planIsland(aa)
    expect(plan.pads.map((p) => p.name)).toEqual(['Orders', 'Audit cache', 'Tools run'])
  })
})

describe('what a service summary says', () => {
  it('is the worst of its systems and counts the throttled tenants', () => {
    const aa = staging.groups.find((g) => g.id === 'aa')!
    const pad = planPads(aa.nodes, 'aa').find((p) => p.service === 'orders')!
    const nodes = new Map(aa.nodes.map((x) => [x.id, x]))
    const sv = summariseService(pad, 'aa', aa.displayName, nodes)
    expect(sv.systems.map((s) => s.id).sort()).toEqual(['aa.orders-api', 'aa.orders-db', 'aa.orders-worker'])
    expect(sv.state).toBe(worstState(sv.systems.map((s) => s.state)))
    const db = sv.systems.find((s) => s.id === 'aa.orders-db')!
    expect(db.tenants?.total).toBe(5)
    expect(sv.systems.find((s) => s.id === 'aa.orders-api')!.tenants).toBeNull()
  })
  it('leaves out a system the snapshot no longer has', () => {
    const aa = staging.groups.find((g) => g.id === 'aa')!
    const pad = planPads(aa.nodes, 'aa').find((p) => p.service === 'orders')!
    const sv = summariseService(pad, 'aa', 'AA', new Map([[aa.nodes[0].id, aa.nodes[0]]]))
    expect(sv.systems.length).toBeLessThanOrEqual(1)
  })
})

describe('the tenants the backend sends (tenants-town)', () => {
  it('passes the snapshot guard', () => {
    const { snapshot, problems } = checkSnapshot(JSON.parse(JSON.stringify(staging)))
    expect(problems).toEqual([])
    expect(snapshot?.environment).toBe('staging')
  })
  it('lists the environments and says which is the default', () => {
    expect(staging.environments.map((e) => e.id)).toEqual(['dev', 'staging', 'prod'])
    expect(staging.environments.filter((e) => e.isDefault).map((e) => e.id)).toEqual(['prod'])
  })
  it('has a unit for each tenant on a tenant database, test ones paler, and the unlisted one as unknown', () => {
    const units = node('aa.orders-db').tenants!
    expect(units.map((u) => u.kind)).toEqual(['Customer', 'Customer', 'Test', 'Test', 'Unknown'])
    expect(node('aa.orders-api').tenants ?? null).toBeNull()
  })
  it('turns a snapshot with tenants of the wrong shape away', () => {
    const bad = JSON.parse(JSON.stringify(staging))
    bad.groups.find((g: { id: string }) => g.id === 'aa').nodes.find((x: { id: string }) => x.id === 'aa.orders-db').tenants = [{ id: 1 }]
    const { snapshot, problems } = checkSnapshot(bad)
    expect(snapshot === null || problems.length > 0).toBe(true)
  })
})

describe('the tenant dropdown', () => {
  const list: TenantInfo[] = [
    { id: '7f3a-guid', name: 'Zed Bank', kind: 'Customer', share: 0.4 },
    { id: 'acme', name: 'Acme', kind: 'Customer', share: 0.4 },
    { id: 'qa', name: 'QA run', kind: 'Test', share: 0.05 },
    { id: 'ghost', name: 'ghost', kind: 'Unknown', share: 0.15 },
  ]
  it('groups customers, then test tenants, then unknown ones, each by name', () => {
    const g = groupTenants(list)
    expect(g.map((x) => x.key)).toEqual(['Customer', 'Test', 'Unknown'])
    expect(g[0].tenants.map((t) => t.name)).toEqual(['Acme', 'Zed Bank'])
  })
  it('finds a tenant by a part of its name or of its id, and leaves empty groups out', () => {
    expect(groupTenants(list, 'zed').flatMap((g) => g.tenants.map((t) => t.id))).toEqual(['7f3a-guid'])
    expect(groupTenants(list, '7f3a').flatMap((g) => g.tenants.map((t) => t.id))).toEqual(['7f3a-guid'])
    expect(groupTenants(list, 'bank zed').length).toBe(1)
    expect(groupTenants(list, 'nothing')).toEqual([])
  })
  it('ticks and unticks tenants one at a time', () => {
    const one = toggleTenant(ALL_TENANTS, 'acme')
    const two = toggleTenant(one, 'qa')
    expect(two.tenants).toEqual(['acme', 'qa'])
    expect(toggleTenant(two, 'acme').tenants).toEqual(['qa'])
    expect(ALL_TENANTS.tenants).toEqual([])
  })
  it('lets go of followed tenants the environment no longer lists', () => {
    const v = { hideTest: true, tenants: ['acme', 'gone'] }
    expect(pruneTenants(v, list).tenants).toEqual(['acme'])
    expect(pruneTenants({ hideTest: false, tenants: ['acme'] }, list)).toEqual({ hideTest: false, tenants: ['acme'] })
  })
  it('labels the button', () => {
    expect(tenantLabel(ALL_TENANTS, list)).toBe('All tenants')
    expect(tenantLabel({ hideTest: false, tenants: ['acme'] }, list)).toBe('Acme')
    expect(tenantLabel({ hideTest: false, tenants: ['acme', 'qa'] }, list)).toBe('2 tenants')
    expect(tenantLabel({ hideTest: true, tenants: [] }, list)).toBe('All tenants · no test')
  })
  it('marks the tenants in trouble, the worst unit deciding, and never a test tenant red', () => {
    const u = (id: string, kind: TenantUnitSnapshot['kind'], state: TenantUnitSnapshot['state']) => ({ ...unit(kind, state), id })
    const t = tenantTrouble([
      { tenants: [u('acme', 'Customer', 'Degraded'), u('ok', 'Customer', 'Healthy'), u('qa', 'Test', 'Down')] },
      { tenants: [u('acme', 'Customer', 'Down')] },
      { tenants: null },
    ])
    expect(Object.fromEntries(t)).toEqual({ acme: 'red', qa: 'amber' })
  })
  it('reads the staging fixture: ghost-co is unknown and test tenants are grouped apart', () => {
    const g = groupTenants(staging.tenants)
    expect(g.map((x) => x.key)).toEqual(['Customer', 'Test', 'Unknown'])
    expect(g[2].tenants.map((t) => t.id)).toEqual(['ghost-co'])
  })
})

describe('the order the inspector lists tenants in', () => {
  const named = (name: string, state: TenantUnitSnapshot['state'], throttled: number | null, utilisation: number | null): TenantUnitSnapshot =>
    ({ ...unit('Customer', state, throttled, utilisation), id: name, name })

  it('puts the tenant that is down first, then degraded, then any turning requests away, then the busiest of the rest', () => {
    const units = [named('quiet', 'Healthy', 0, 0.1), named('busy', 'Healthy', 0, 0.6), named('refusing', 'Healthy', 0.02, 0.2), named('hot', 'Degraded', 0, 0.8), named('red', 'Down', 0, 0.9)]
    expect(tenantListOrder(units).map((u) => u.name)).toEqual(['red', 'hot', 'refusing', 'busy', 'quiet'])
  })

  it('keeps a tenant with no reading at the end and does not change the list it is given', () => {
    const units = [named('none', 'Stale', null, null), named('some', 'Healthy', 0, 0.3)]
    expect(tenantListOrder(units).map((u) => u.name)).toEqual(['some', 'none'])
    expect(units.map((u) => u.name)).toEqual(['none', 'some'])
  })
})

describe('saying which tenant throttles', () => {
  const named = (name: string, throttled: number | null) => ({ ...unit('Customer', 'Healthy', throttled), id: name, name })
  const units = [named('Lloyds', 0.02), named('Boohoo', 0.032), named('Argos', 0), named('Next', 0.04)]
  it('orders the throttled tenants worst first and skips the ones under the amber share', () => {
    expect(throttledUnits(units, 0.03).map((u) => u.name)).toEqual(['Next', 'Boohoo'])
  })
  it('names the worst tenant and counts the others', () => {
    expect(throttleWho(units, 0.03)).toBe('4.0% · Next +1 more')
    expect(throttleWho([units[1]], 0.03)).toBe('3.2% · Boohoo')
    expect(throttleWho([units[2]], 0.03)).toBeNull()
  })
  it('shows a tenant its own figure, 0% included', () => {
    expect(throttledText(named('a', 0))).toBe('0% throttled')
    expect(throttledText(named('a', 0.4))).toBe('40% throttled')
    expect(throttledText(named('a', 0.032))).toBe('3.2% throttled')
  })
  it('puts the throttled tenants on the yard sign when there are only a few', () => {
    expect(yardSummary(units, ALL_TENANTS, 0.03).note).toBe('2 throttled: Next, Boohoo')
    const many = Array.from({ length: 5 }, (_, i) => named(`T${i}`, 0.2))
    expect(yardSummary(many, ALL_TENANTS, 0.03).note).toBe('')
    expect(yardSummary(many, ALL_TENANTS, 0.03).text).toBe('5 tenants, 5 throttled')
  })
})

describe('showing what a tenant database is provisioned at', () => {
  const sized = (limit: number | null) => ({ ...unit('Customer', 'Healthy'), limit })
  it('writes a size with thousands separators and the unit', () => {
    expect(limitText(20000)).toBe('20,000 RU/s')
    expect(limitText(400)).toBe('400 RU/s')
  })
  it('gives the one size, or the range when the databases differ, and nothing when none is known', () => {
    expect(limitRange([sized(20000), sized(20000)])).toBe('20,000 RU/s')
    expect(limitRange([sized(4000), sized(20000), sized(10000)])).toBe('4,000 to 20,000 RU/s')
    expect(limitRange([sized(null), sized(10000)])).toBe('10,000 RU/s')
    expect(limitRange([sized(null)])).toBeNull()
    expect(limitRange([])).toBeNull()
  })
  it('puts the size first on a tenant row, then the use and the throttling', () => {
    expect(tenantFigures({ limit: 20000, utilisation: 0.4, throttled: 0.032 })).toBe('20,000 RU/s · 40% · 3.2% throttled')
    expect(tenantFigures({ limit: null, utilisation: 0.4, throttled: 0 })).toBe('40% · 0% throttled')
    expect(tenantFigures({ limit: null, utilisation: null, throttled: null })).toBe('–')
    // a quiet database read as no use says so, instead of a bare 0%
    expect(tenantFigures({ limit: 4000, utilisation: 0, throttled: 0, idle: true })).toBe('4,000 RU/s · no activity reported · 0% throttled')
    expect(tenantFigures({ limit: 4000, utilisation: 0, throttled: 0, idle: null })).toBe('4,000 RU/s · 0% · 0% throttled')
  })
})
