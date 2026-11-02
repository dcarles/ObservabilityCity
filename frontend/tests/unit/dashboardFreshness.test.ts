import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { agoText, feedLateAfter, intervalText, marker, popupLeft, sourceLines } from '../../src/dashboard/freshness'
import { buildDashboard, detailText, sectionSummary, type Row, type SideRow } from '../../src/dashboard/model'
import { freshnessHtml, sectionHtml, sectionsHtml, type UiState } from '../../src/dashboard/render'
import { checkSnapshot } from '../../src/snapshotGuard'
import { ALL_TENANTS } from '../../src/tenants'
import type { Snapshot } from '../../src/types'

const golden = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}.json`), 'utf8')) as Snapshot
const ui = (open: string[] = []): UiState => ({ openPillars: new Set(), groups: new Map(), databases: new Map(), sections: new Set(open) })

describe('the freshness marker', () => {
  it('says how old the last snapshot is, and turns amber only when snapshots stop', () => {
    expect(marker(true, 3, 10)).toEqual({ text: 'Connected · snapshot 3 s ago', late: false })
    expect(marker(true, 11, 10).late).toBe(true)
    expect(marker(false, 3, 10).late).toBe(true)
    expect(marker(true, null, 10).late).toBe(false)
  })

  it('waits three times the usual gap, never under ten seconds', () => {
    expect(feedLateAfter([])).toBe(30)
    expect(feedLateAfter([0.5, 0.5, 0.6])).toBe(10)
    expect(feedLateAfter([5, 5, 6, 5])).toBe(15)
  })
})

describe('the freshness popup', () => {
  const now = Date.parse('2026-11-02T12:00:00Z')
  const sources = [
    { name: 'health', lastRead: '2026-11-02T11:59:48Z', intervalSeconds: 60, overdue: false },
    { name: 'jobs', lastRead: '2026-11-02T11:53:00Z', intervalSeconds: 300, overdue: true },
    { name: 'links', lastRead: null, intervalSeconds: 3600, overdue: false },
  ]

  it('has one line per configured source with last read and interval, and marks the overdue ones', () => {
    const lines = sourceLines(sources, now)
    expect(lines.map((l) => [l.name, l.lastRead, l.interval, l.overdue])).toEqual([['health', '12 s ago', '1 min', false], ['jobs', '7 min ago', '5 min', true], ['links', 'not yet', '1 h', false]])
    const html = freshnessHtml(lines)
    expect(html).toContain('(overdue)')
    expect(html.match(/class="warn"/g)).toHaveLength(1)
  })

  it('says so when no source reports', () => {
    expect(sourceLines(null, now)).toEqual([])
    expect(freshnessHtml([])).toContain('No source reports')
  })

  it('stays inside the screen with a gutter on both sides', () => {
    expect(popupLeft(10, 380, 1280)).toBe(16)
    expect(popupLeft(900, 380, 1280)).toBe(884)
    expect(popupLeft(1200, 380, 1280)).toBe(884)
    expect(popupLeft(200, 340, 390)).toBe(34)
  })

  it('words for ages and intervals', () => {
    expect(agoText(0)).toBe('0 s ago')
    expect(agoText(125)).toBe('2 min ago')
    expect(agoText(7200)).toBe('2 h ago')
    expect(intervalText(30)).toBe('30 s')
  })

  it('the snapshot guard keeps the sources and drops a broken line', () => {
    const s = golden('calm') as unknown as Record<string, unknown>
    s.sources = [{ name: 'a', lastRead: null, intervalSeconds: 5, overdue: true }, { name: 7 }, null]
    expect(checkSnapshot(s).snapshot!.sources).toEqual([{ name: 'a', lastRead: null, intervalSeconds: 5, overdue: true }])
  })
})

describe('the lists under the pillars', () => {
  it('lists the hub, vendors and digital services, each only when it has something', () => {
    const d = buildDashboard(golden('calm'), ALL_TENANTS)
    const s = golden('calm')
    expect(d.sections.map((x) => x.id)).toEqual([...(s.groups.some((g) => g.isHub && (g.nodes.length || g.assets?.length)) ? ['hub'] : []), ...(s.vendors.some((v) => !v.internal) ? ['vendors'] : []), ...(s.vendors.some((v) => v.internal) ? ['digital'] : [])])
    const bare = golden('calm')
    bare.vendors = []
    bare.groups = bare.groups.filter((g) => !g.isHub)
    expect(buildDashboard(bare, ALL_TENANTS).sections).toEqual([])
  })

  it('every section starts closed and keeps what the viewer opened', () => {
    const d = buildDashboard(golden('calm'), ALL_TENANTS)
    expect(sectionsHtml(d, ui())).not.toMatch(/<details[^>]* open/)
    expect(sectionsHtml(d, ui(['hub']))).toMatch(/data-section="hub" open/)
  })

  it('shows a vendor with no health as such, and never as healthy', () => {
    const s = golden('calm')
    s.vendors[0].node.state = 'Stale'
    const d = buildDashboard(s, ALL_TENANTS)
    const row = d.sections.flatMap((x) => x.rows).find((r) => r.id === s.vendors[0].node.id)!
    expect(row.level).toBe('none')
    expect(row.health).toBeNull()
    expect(sectionHtml(d.sections.find((x) => x.rows.includes(row))!, true)).toContain('no health available')
  })

  it('the hub lists a resource that is only links with its links and no drawer button', () => {
    const s = golden('calm')
    const hub = s.groups.find((g) => g.isHub)!
    hub.assets = [{ id: 'hub.logs', name: 'Logs', label: 'Log store', shape: 'x', group: 'Monitoring', links: [{ name: 'Portal', url: 'https://portal.example.test/logs' }] }]
    const section = buildDashboard(s, ALL_TENANTS).sections.find((x) => x.id === 'hub')!
    const row = section.rows.find((r) => r.name === 'Logs')!
    expect(row.drawer).toBe(false)
    expect(row.detail).toContain('links only')
    const html = sectionHtml(section, true)
    expect(html).toContain('https://portal.example.test/logs')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('summarises in one line: how many, what is wrong, what is unknown', () => {
    const row = (level: SideRow['level']): SideRow => ({ id: 'x', name: 'x', level, health: null, detail: '', calledBy: [], calls: [], links: [], drawer: true })
    expect(sectionSummary('vendor', [])).toBe('')
    expect(sectionSummary('vendor', [row('ok'), row('ok')])).toBe('2 vendors · all healthy')
    expect(sectionSummary('vendor', [row('ok'), row('warn'), row('none')])).toBe('3 vendors · 1 degraded · 1 without health')
    expect(sectionSummary('resource', [row('bad')], ['backlog 473', 'DLQ 9'])).toBe('1 resource · backlog 473 · DLQ 9 · 1 down')
  })

  it('details are only what is measured', () => {
    const base: Row = { id: 'x', name: 'x', type: 'API', level: 'ok', reason: null, rps: 12, errorPct: 0.4, p99: 90, instances: null, cpu: null, ru: null, backlog: 3, dlq: 0, calledBy: [], calls: [], tenants: null, tenantsOpenByDefault: false }
    expect(detailText(base)).toBe('12 rps · errors 0.4% · p99 90 ms · backlog 3 · DLQ 0')
    expect(detailText({ ...base, rps: null, errorPct: null, p99: null, backlog: null, dlq: null })).toBe('')
  })
})
