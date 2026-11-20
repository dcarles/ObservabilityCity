import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildDashboard } from '../../src/dashboard/model'
import { pillarHtml, type UiState } from '../../src/dashboard/render'
import { tenantHot, reasons } from '../../src/inspectorModel'
import { checkSnapshot } from '../../src/snapshotGuard'
import { ALL_TENANTS, hotParts, partLabel, partLines, partsFineText, throttleWho, worstPart } from '../../src/tenants'
import type { NodeSnapshot, PartSnapshot, Snapshot, TenantUnitSnapshot } from '../../src/types'

// A database the source splits into the pieces that have capacity of their own: the shared pool, and one piece (a container) throttling while the rest is fine.
const part = (name: string, kind: PartSnapshot['kind'], state: PartSnapshot['state'], utilisation: number, throttled: number): PartSnapshot =>
  ({ name, kind, state, utilisation, throttled, requestsPerSecond: 1, limit: kind === 'Shared' ? 2000 : 1000 })
const PARTS = [
  part('', 'Shared', 'Healthy', 0.3, 0),
  part('entries', 'Dedicated', 'Healthy', 0.4, 0),
  part('audit-log', 'Dedicated', 'Down', 1, 0.5),
]
const unit = (parts: PartSnapshot[] | undefined, state: TenantUnitSnapshot['state'] = 'Degraded'): TenantUnitSnapshot =>
  ({ id: 'acme', name: 'Acme', kind: 'Customer', database: 'merchant-acme-db', state, utilisation: 1, throttled: 0.5, requestsPerSecond: 5, limit: 2000, ...(parts ? { parts } : {}) })

const fixture = (): Snapshot => structuredClone(JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/tenants-town.json'), 'utf8')) as Snapshot)
const topOf = (db: NodeSnapshot): TenantUnitSnapshot => db.tenants!.find((t) => t.parts)!
const dbOf = (s: Snapshot): NodeSnapshot => s.groups.flatMap((g) => g.nodes).find((n) => n.id === 'aa.orders-db')!

/** The orders database with its first tenant split into parts, as the backend would send it (a unit amber for a dedicated part, the engine named "container"). */
function split(): Snapshot {
  const s = fixture()
  const db = dbOf(s)
  db.engine = { id: 'cosmos', name: 'Cosmos DB', type: 'document', typeName: 'Document', partLabel: 'container' }
  // the tenant the inspector names first is the one using the most of its capacity
  const top = db.tenants!.reduce((a, b) => ((b.utilisation ?? 0) > (a.utilisation ?? 0) ? b : a))
  db.tenants![db.tenants!.indexOf(top)] = { ...top, state: 'Degraded', utilisation: 1.1, throttled: 0.5, parts: PARTS }
  return s
}

describe('the parts of a database', () => {
  it('lists the parts in trouble, and the worst is the one turning away the most requests', () => {
    expect(hotParts(unit(PARTS)).map((p) => p.name)).toEqual(['audit-log'])
    expect(worstPart(unit(PARTS))?.name).toBe('audit-log')
    expect(worstPart(unit(undefined))).toBeNull()
  })

  it('says how many parts are fine, and nothing for a unit with none in trouble or none at all', () => {
    expect(partsFineText(unit(PARTS), 'container')).toBe('2 other containers fine')
    expect(partsFineText(unit(PARTS.slice(0, 2)), 'container')).toBeNull()
    expect(partsFineText(unit(undefined), 'container')).toBeNull()
    expect(partsFineText(unit([PARTS[0], PARTS[2]]), 'container')).toBe('1 other container fine')
  })

  it('names the engine word for a piece, or part when the town gave none', () => {
    expect(partLabel({ engine: { id: 'x', name: 'X', type: 'document', typeName: 'Document', partLabel: 'container' } })).toBe('container')
    expect(partLabel({ engine: { id: 'x', name: 'X', type: 'document', typeName: 'Document' } })).toBe('part')
    expect(partLabel({})).toBe('part')
  })

  it('gives the lines under a tenant only for the parts in trouble, red parts in the bad tone', () => {
    const lines = partLines(unit(PARTS), 'container')!
    expect(lines.lines).toEqual([{ name: 'audit-log', kind: 'Dedicated', figures: 'max 1,000 · 100% · 50% throttled', tone: 'bad' }])
    expect(lines.note).toBe('2 other containers fine')
    expect(partLines(unit(PARTS.slice(0, 2)), 'container')).toBeNull()
  })

  it('names the throttling part beside the tenant in the throttled figure', () => {
    expect(throttleWho([unit(PARTS)], 0.001)).toBe('50.0% · Acme · audit-log')
    expect(throttleWho([unit(undefined)], 0.001)).toBe('50.0% · Acme')
    // the shared pool is named as what it is, not by its empty name
    expect(throttleWho([unit([part('', 'Shared', 'Down', 1, 0.5)])], 0.001)).toBe('50.0% · Acme · shared throughput')
  })
})

describe('what the inspector says about a database split into parts', () => {
  it('says which container is hot, with its own numbers, and that the rest is fine', () => {
    const db = dbOf(split())
    const text = tenantHot(db, 'past the red line of 95%')
    expect(text).toContain('container audit-log is at 100% of its capacity (past the red line')
    expect(text).toContain('turning away 50.0% of its requests')
    expect(text).toContain('the rest of it is fine')
  })

  it('judges the part against the lines, not the whole database', () => {
    const db = dbOf(split())
    topOf(db).parts = [part('audit-log', 'Dedicated', 'Degraded', 0.9, 0)]
    expect(tenantHot(db, 'past the red line of 95%')).toContain('(past the amber line of')
  })

  it('names the part in the reasons list too', () => {
    const db = dbOf(split())
    db.state = 'Degraded'
    expect(reasons(db).join(' ')).toContain('audit-log')
  })
})

describe('the dashboard under a database split into parts', () => {
  const rowOf = (s: Snapshot) => buildDashboard(s, ALL_TENANTS).pillars.flatMap((p) => p.groups.flatMap((g) => g.rows)).find((r) => r.id === 'aa.orders-db')!

  it('puts the parts in trouble on the tenant row and counts the ones that are fine', () => {
    const row = rowOf(split())
    expect(row.partLabel).toBe('container')
    const acme = row.tenants!.find((t) => t.parts.length > 0)!
    expect(acme.parts.map((p) => [p.name, p.shared, p.level, p.throttled])).toEqual([['audit-log', false, 'bad', 50]])
    expect(acme.partsFine).toBe(2)
    expect(row.tenants!.filter((t) => t !== acme).every((t) => t.parts.length === 0 && t.partsFine === 0)).toBe(true)
  })

  it('opens the tenant lines by itself and draws the part lines with the note', () => {
    const s = split()
    const d = buildDashboard(s, ALL_TENANTS)
    const ui: UiState = { openPillars: new Set(d.pillars.map((p) => p.id)), groups: new Map(d.pillars.flatMap((p) => p.groups.map((g) => [g.key, true] as const))), databases: new Map([['aa.orders-db', true]]), connections: new Set(), sections: new Set() }
    const html = d.pillars.map((p) => pillarHtml(p, ui)).join('')
    expect(html).toContain('data-part="audit-log"')
    expect(html).toContain('container</span>')
    expect(html).toContain('2 other containers fine')
    expect(html).not.toContain('data-part="entries"')
  })

  it('shows nothing extra for a database without parts', () => {
    const row = rowOf(fixture())
    expect(row.tenants!.every((t) => t.parts.length === 0)).toBe(true)
  })
})

describe('the snapshot guard and parts', () => {
  it('keeps the parts and the engine word as sent', () => {
    const raw = split()
    const { snapshot, problems } = checkSnapshot(structuredClone(raw))
    expect(problems).toEqual([])
    const db = dbOf(snapshot!)
    expect(db.engine?.partLabel).toBe('container')
    expect(topOf(db).parts).toEqual(PARTS)
  })

  it('never shows a part with an unknown state as healthy', () => {
    const raw = split()
    topOf(dbOf(raw)).parts![1] = { ...PARTS[1], state: 'Mystery' as PartSnapshot['state'] }
    const db = dbOf(checkSnapshot(raw).snapshot!)
    expect(topOf(db).parts![1].state).toBe('Stale')
  })
})
