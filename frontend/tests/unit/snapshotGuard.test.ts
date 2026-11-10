import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkSnapshot } from '../../src/snapshotGuard'
import { wrapText } from '../../src/scene/town'
import type { Snapshot } from '../../src/types'

const fixture = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}`), 'utf8')) as Snapshot
const calm = () => structuredClone(fixture('calm.json'))

describe('a good snapshot', () => {
  it.each(['calm.json', 'bad-day.json'])('passes %s unchanged and with nothing to report', (name) => {
    const raw = fixture(name)
    const { snapshot, problems } = checkSnapshot(structuredClone(raw))
    expect(problems).toEqual([])
    expect(snapshot).toEqual(raw)
  })
})

describe("the town's wall defaults", () => {
  it('pass through when they are usable', () => {
    const raw = { ...calm(), wall: { holdSeconds: 30, overviewSeconds: 0, light: 'day' } }
    expect(checkSnapshot(structuredClone(raw)).snapshot?.wall).toEqual({ holdSeconds: 30, overviewSeconds: 0, light: 'day' })
  })

  it('drop what is not usable, and all of it when nothing is', () => {
    const odd = { ...calm(), wall: { holdSeconds: 0.1, overviewSeconds: -3, light: 'night' } }
    expect(checkSnapshot(odd).snapshot?.wall).toBeNull()
    const part = { ...calm(), wall: { holdSeconds: 40, overviewSeconds: 'x' } }
    expect(checkSnapshot(part).snapshot?.wall).toEqual({ holdSeconds: 40 })
  })
})

describe('a snapshot that cannot be drawn is refused', () => {
  it.each([
    ['null', null],
    ['text', 'hello'],
    ['a list', []],
    ['an empty object', {}],
    ['no groups', { groups: [] }],
    ['groups that are not a list', { groups: 'many' }],
    ['groups without ids', { groups: [{ nodes: [] }, 42, null] }],
    ['groups with no systems at all', { groups: [{ id: 'x', nodes: 'none' }, { id: 'y', nodes: [] }] }],
  ])('%s', (_name, raw) => {
    const { snapshot, problems } = checkSnapshot(raw)
    expect(snapshot).toBeNull()
    expect(problems.length).toBeGreaterThan(0)
  })
})

describe('a snapshot with something wrong in it is repaired where that is safe', () => {
  it('drops a system with no id or an unknown kind and keeps the rest', () => {
    const raw = calm()
    const g = raw.groups[1]
    const kept = g.nodes.length
    g.nodes.push({ ...g.nodes[0], id: '' }, { ...g.nodes[0], id: 'x.castle', kind: 'Castle' as never }, null as never)
    const { snapshot, problems } = checkSnapshot(raw)
    expect(snapshot!.groups[1].nodes).toHaveLength(kept)
    expect(problems.some((p) => p.includes('x.castle'))).toBe(true)
  })

  it('drops the second of two systems with the same id', () => {
    const raw = calm()
    const g = raw.groups[1]
    g.nodes.push({ ...g.nodes[0] })
    const { snapshot, problems } = checkSnapshot(raw)
    expect(snapshot!.groups[1].nodes).toHaveLength(g.nodes.length - 1)
    expect(problems.some((p) => p.includes('second system'))).toBe(true)
  })

  it('turns numbers that are not numbers into 0 (and greys the system), and optional ones into null', () => {
    const raw = calm()
    const n = raw.groups[1].nodes[0] as unknown as Record<string, unknown>
    n.errorRate = 'lots'
    n.p99Ms = null
    n.cpu = 'high'
    n.queueDepth = Infinity
    const out = checkSnapshot(raw).snapshot!.groups[1].nodes[0]
    expect(out.errorRate).toBe(0)
    expect(out.p99Ms).toBe(0)
    expect(out.cpu).toBeNull()
    expect(out.queueDepth).toBeNull()
  })

  it('keeps what a pillar sends and receives, and drops a rate or a window that is not a number', () => {
    const raw = calm() as unknown as Record<string, any>
    raw.groups[0].flow = { sentPerSecond: 12.5, receivedPerSecond: 'many', windowSeconds: 900 }
    raw.groups[1].flow = { sentPerSecond: -3, receivedPerSecond: null, windowSeconds: 900 }
    raw.groups[2].flow = { sentPerSecond: 0, receivedPerSecond: 0, windowSeconds: 'x' }
    const { snapshot } = checkSnapshot(raw)
    expect(snapshot!.groups[0].flow).toEqual({ sentPerSecond: 12.5, receivedPerSecond: null, windowSeconds: 900 })
    expect(snapshot!.groups[1].flow).toBeNull() // nothing measured
    expect(snapshot!.groups[2].flow).toEqual({ sentPerSecond: 0, receivedPerSecond: 0, windowSeconds: 0 })
  })

  it('shows an unknown state as stale, never as healthy', () => {
    const raw = calm()
    ;(raw.groups[1].nodes[0] as unknown as Record<string, unknown>).state = 'Fine'
    expect(checkSnapshot(raw).snapshot!.groups[1].nodes[0].state).toBe('Stale')
  })

  it('fills in a list that is missing', () => {
    const raw = calm() as unknown as Record<string, unknown>
    delete raw.notices
    const group = (raw.groups as Record<string, unknown>[])[1]
    delete group.configError
    delete (group.nodes as Record<string, unknown>[])[0].calls
    const out = checkSnapshot(raw).snapshot!
    expect(out.notices).toEqual([])
    expect(out.notes).toBeNull()
    expect(out.groups[1].configError).toBeNull()
    expect(out.groups[1].nodes[0].calls).toEqual([])
  })

  it('keeps the health reports a partial read still found next to the notice that says some reads failed', () => {
    const raw = calm()
    const notice = "Source 'health' could not read the cloud's health reports, so the list of resources it calls degraded may be out of date: 1 of 12 activity log reads failed, so the list may be incomplete"
    raw.notices = [notice]
    raw.healthEvents = [{ id: 'e', resource: 'orders-db', state: 'Degraded', previous: 'Available', cause: 'Unknown', summary: null, since: '2026-11-05T16:21:15Z', resolvedAt: null, nodeId: 'aa.orders-db', groupId: 'aa' }]
    const out = checkSnapshot(structuredClone(raw)).snapshot!
    expect(out.notices).toEqual([notice])
    expect(out.healthEvents).toEqual(raw.healthEvents)
  })

  it('keeps the notes, which are not problems, and drops anything that is not text', () => {
    const raw = calm() as unknown as Record<string, unknown>
    raw.notes = ["Pillar 'zz' is not in the town yet", 7, null]
    expect(checkSnapshot(raw).snapshot!.notes).toEqual(["Pillar 'zz' is not in the town yet"])
  })

  it('keeps a config error island, which has no systems, and its message', () => {
    const raw = calm()
    raw.groups[2].nodes = []
    raw.groups[2].configError = 'bb.yaml was skipped: unknown role castle'
    const out = checkSnapshot(raw).snapshot!
    expect(out.groups[2].nodes).toEqual([])
    expect(out.groups[2].configError).toBe('bb.yaml was skipped: unknown role castle')
  })

  it('falls back to a plain colour when a group colour is not one', () => {
    const raw = calm()
    raw.groups[1].color = 'banana'
    expect(checkSnapshot(raw).snapshot!.groups[1].color).toMatch(/^#/)
  })
})

describe('a number the colour depends on that is missing never reads as healthy', () => {
  const first = (raw: Snapshot) => raw.groups[1].nodes[0]

  it.each(['errorRate', 'p99Ms', 'requestsPerSecond', 'instancesTotal', 'instancesHealthy', 'slaP99Ms', 'errorRed'])('turns the system grey when %s is missing', (key) => {
    const raw = calm()
    const id = first(raw).id
    raw.groups[1].nodes[0] = { ...first(raw), state: 'Healthy', absent: [], [key]: null } as never
    const { snapshot, problems } = checkSnapshot(raw)
    const node = snapshot!.groups[1].nodes.find((n) => n.id === id)!
    expect(node.state).toBe('Stale')
    expect(problems.some((p) => p.includes(id) && p.includes(key))).toBe(true)
  })

  it('leaves a system alone whose source says it has no such signal', () => {
    const raw = calm()
    raw.groups[1].nodes[0] = { ...first(raw), state: 'Healthy', absent: ['errors'], errorRate: null } as never
    expect(checkSnapshot(raw).snapshot!.groups[1].nodes[0].state).toBe('Healthy')
  })

  it('reads a missing load as 0 without greying the system, since load only shapes the drawing', () => {
    const raw = calm()
    raw.groups[1].nodes[0] = { ...first(raw), state: 'Healthy', load: null } as never
    const node = checkSnapshot(raw).snapshot!.groups[1].nodes[0]
    expect(node.state).toBe('Healthy')
    expect(node.load).toBe(0)
  })
})

describe('a tenant database read as idle', () => {
  const withTenants = () => {
    const raw = structuredClone(fixture('tenants-town.json'))
    const db = raw.groups.flatMap((g) => g.nodes).find((n) => n.tenants && n.tenants.length > 0)!
    return { raw, unit: db.tenants![0] }
  }

  it('keeps the mark the server put on it', () => {
    const { raw, unit } = withTenants()
    Object.assign(unit, { utilisation: 0, idle: true })
    const { snapshot, problems } = checkSnapshot(raw)
    expect(problems).toEqual([])
    expect(snapshot!.groups.flatMap((g) => g.nodes).flatMap((n) => n.tenants ?? []).filter((t) => t.idle)).toHaveLength(1)
  })

  it('drops a mark that is not a plain true, so a stray value never says "no activity"', () => {
    const { raw, unit } = withTenants()
    Object.assign(unit, { idle: 'yes' })
    const { snapshot } = checkSnapshot(raw)
    expect(snapshot!.groups.flatMap((g) => g.nodes).flatMap((n) => n.tenants ?? []).some((t) => t.idle)).toBe(false)
  })
})

describe('wrapText', () => {
  it('breaks at word boundaries', () => {
    expect(wrapText('one two three four five', 10)).toEqual(['one two', 'three four', 'five'])
  })
  it('cuts a word that is longer than a line', () => {
    expect(wrapText('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl'])
  })
  it('gives nothing for nothing', () => {
    expect(wrapText('   ', 10)).toEqual([])
  })
})

describe('what the island filter adds to a snapshot', () => {
  it('keeps a good view and topology as they are', () => {
    const raw = fixture('island-filter.json')
    const { snapshot, problems } = checkSnapshot(structuredClone(raw))
    expect(problems).toEqual([])
    expect(snapshot!.view).toEqual(raw.view)
    expect(snapshot!.topology).toBe(raw.topology)
  })

  it('treats a snapshot from a server that does not send them as unfiltered, with direct calls', () => {
    const raw = calm() as Record<string, unknown>
    delete raw.view
    delete raw.topology
    const { snapshot } = checkSnapshot(raw)
    expect(snapshot!.topology).toBe('direct')
    expect(snapshot!.view).toEqual({ islands: [], unknown: [], hidden: [], links: [] })
  })

  it('drops view entries that cannot be used instead of refusing the town', () => {
    const raw = calm() as Record<string, unknown>
    raw.view = { islands: ['aa', 5, null], unknown: 'zz', hidden: [{ id: 'bb' }, { id: 7, displayName: 'x' }, null], links: [{ nodeId: 'a' }, 3] }
    const { snapshot } = checkSnapshot(raw)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.view!.islands).toEqual(['aa'])
    expect(snapshot!.view!.unknown).toEqual([])
    expect(snapshot!.view!.hidden.every((h) => typeof h.id === 'string')).toBe(true)
    expect(snapshot!.view!.links.every((l) => typeof l.nodeId === 'string' && typeof l.requestsPerSecond === 'number')).toBe(true)
  })
})

describe('the town mode', () => {
  it('keeps demo, and treats anything else, including a snapshot with no mode, as live', () => {
    expect(checkSnapshot({ ...calm(), mode: 'demo' }).snapshot!.mode).toBe('demo')
    expect(checkSnapshot({ ...calm(), mode: 'live' }).snapshot!.mode).toBe('live')
    expect(checkSnapshot({ ...calm(), mode: undefined }).snapshot!.mode).toBe('live')
    expect(checkSnapshot({ ...calm(), mode: 'surprise' }).snapshot!.mode).toBe('live')
  })

  it('the golden demo snapshots say demo', () => {
    expect(fixture('calm.json').mode).toBe('demo')
  })
})
