import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connectorsOf, portSummary } from '../../src/scene/links'
import { consumersOf, hasMessaging, messagingOf } from '../../src/scene/harbour'
import { planIsland } from '../../src/scene/plan'
import { checkSnapshot } from '../../src/snapshotGuard'
import type { GroupSnapshot, NodeSnapshot, Snapshot } from '../../src/types'

// The snapshots are written by the backend's tests from real registries, so these tests check the renderer's rules against what the
// backend really sends: links-town has one island for each case, and calm.json is the sample town.
const fixture = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}`), 'utf8')) as Snapshot
const links = fixture('links-town.json')
const sample = fixture('calm.json')
const group = (s: Snapshot, id: string) => s.groups.find((g) => g.id === id)!
const kinds = (g: GroupSnapshot) => planIsland(g).placed.map((p) => p.node.kind)

describe('the connectors an island gets (links-town)', () => {
  it.each([
    ['ful', true, true, 'an API and a consumer: a bridge and a pier'],
    ['wrk', false, true, 'a worker only: a pier and no bridge'],
    ['nom', true, false, 'an API and no messaging: a bridge and no pier'],
    ['hbk', true, false, 'no API, but a call to the shared hub database: a bridge and no pier'],
    ['leg', true, true, 'an API and a legacy consumer: a bridge and a pier'],
    ['sta', false, false, 'nothing at all: no bridge and no pier'],
  ])('%s: %s', (id, bridge, pier) => {
    const c = connectorsOf(group(links, id))
    expect(c.bridge).toBe(bridge)
    expect(c.pier).toBe(pier)
    expect(c.standalone).toBe(!bridge && !pier)
  })

  it('never gives the hub a bridge or a pier of its own', () => {
    const c = connectorsOf(group(links, 'hub'))
    expect([c.bridge, c.pier]).toEqual([false, false])
  })

  it('does not build connectors for an island whose file is broken', () => {
    const broken = { ...group(links, 'ful'), configError: 'bad file', nodes: [] }
    expect(connectorsOf(broken)).toMatchObject({ bridge: false, pier: false })
  })

  it('tells the backend registry warning and the picture the same story: only sta stands alone', () => {
    const alone = links.groups.filter((g) => !g.isHub && connectorsOf(g).standalone).map((g) => g.id)
    expect(alone).toEqual(['sta'])
    expect(links.notices.some((n) => n.includes("Island 'sta' stands alone"))).toBe(true)
  })
})

describe('buildings exist only for roles an island has', () => {
  it('draws no factory without a worker and no storage without a database', () => {
    expect(kinds(group(links, 'nom')).sort()).toEqual(['Api', 'Cache'])
    expect(kinds(group(links, 'hbk'))).toEqual(['Function'])
  })

  it('draws no office tower for an island with no API', () => {
    expect(kinds(group(links, 'wrk'))).not.toContain('Api')
    expect(kinds(group(links, 'wrk'))).toEqual(expect.arrayContaining(['Worker', 'Database']))
  })
})

describe('the Service Bus port summary', () => {
  it('counts topics, subscriptions, piers and the old-route reads in links-town', () => {
    expect(portSummary(links.groups)).toEqual({ topics: 3, subscriptions: 3, piers: 3, legacy: 1 })
  })

  it('counts the sample town: a pier for every pillar with messaging, the legacy read in Lost & found', () => {
    const p = portSummary(sample.groups)
    expect(p.legacy).toBe(1)
    expect(p.piers).toBe(sample.groups.filter((g) => !g.isHub && hasMessaging(g.messaging)).length)
    expect(p.piers).toBe(16) // every pillar except reg, which has none
    expect(p.subscriptions).toBeGreaterThan(30)
  })
})

describe('the sample town', () => {
  it('has a worker-only island with a pier and no bridge, and a messaging-free island with a bridge and no pier', () => {
    expect(connectorsOf(group(sample, 'rcn'))).toMatchObject({ bridge: false, pier: true })
    expect(kinds(group(sample, 'rcn'))).not.toContain('Api')
    expect(connectorsOf(group(sample, 'reg'))).toMatchObject({ bridge: true, pier: false })
    expect(kinds(group(sample, 'reg'))).not.toContain('Worker')
    expect(kinds(group(sample, 'reg'))).not.toContain('Database')
  })

  it('gives every other pillar a bridge and a pier', () => {
    for (const g of sample.groups.filter((x) => !x.isHub && !['rcn', 'reg'].includes(x.id)))
      expect(connectorsOf(g), g.id).toMatchObject({ bridge: true, pier: true })
  })

  it('has a consumer for every worker, so every worker has a queue to show', () => {
    for (const g of sample.groups.filter((x) => !x.isHub)) {
      const consumers = consumersOf(g.messaging)
      for (const w of g.nodes.filter((n) => n.kind === 'Worker')) expect(consumers.has(w.id), w.id).toBe(true)
    }
  })

  it('reports no dead letters when calm', () => {
    expect(sample.totals.deadLetters).toBe(0)
  })
})

describe('what a pier reports', () => {
  const worker = (id: string, extra: Partial<NodeSnapshot>) => ({ id, kind: 'Worker', state: 'Healthy', requestsPerSecond: 10, backlogAmber: 60, backlogRed: 300, queueDepth: 100, oldestMessageSeconds: 5, deadLetters: 3, ...extra }) as unknown as NodeSnapshot
  const messaging = { topics: [{ name: 'a-x-outbox', service: 'x' }], subscriptions: [{ topic: 'b-y-outbox', publisher: 'b', consumer: 'a.one', legacy: false }] }

  it('adds up only the workers that subscribe to a topic', () => {
    const m = messagingOf([worker('a.one', {}), worker('a.two', { queueDepth: 5000, deadLetters: 40 })], messaging)

    expect(m.waiting).toBe(100)
    expect(m.deadLetters).toBe(3)
    expect(m.perSecond).toBe(10)
    expect([m.topics, m.subscriptions, m.legacy]).toEqual([1, 1, false])
  })

  it('reports nothing for an island with no subscriptions, however busy its workers are', () => {
    const m = messagingOf([worker('a.one', {})], { topics: messaging.topics, subscriptions: [] })

    expect(m.waiting).toBeNull()
    expect(m.deadLetters).toBeNull()
  })

  it('flags the old route', () => {
    const m = messagingOf([worker('a.one', {})], { ...messaging, subscriptions: [{ ...messaging.subscriptions[0], legacy: true }] })

    expect(m.legacy).toBe(true)
  })

  it('treats a missing messaging block as no messaging', () => {
    expect(hasMessaging(undefined)).toBe(false)
    expect(hasMessaging({ topics: [], subscriptions: [] })).toBe(false)
    expect(hasMessaging({ topics: messaging.topics, subscriptions: [] })).toBe(true)
  })
})

describe('the snapshot guard and messaging', () => {
  it('keeps a bridge for a snapshot that does not say, and gives it no pier', () => {
    const raw = structuredClone(links) as unknown as { groups: Record<string, unknown>[] }
    for (const g of raw.groups) { delete g.hasBridge; delete g.messaging }

    const { snapshot } = checkSnapshot(raw)

    for (const g of snapshot!.groups.filter((x) => !x.isHub)) expect(connectorsOf(g), g.id).toMatchObject({ bridge: true, pier: false })
  })

  it('drops subscriptions and topics it cannot use and keeps the rest', () => {
    const raw = structuredClone(links) as unknown as { groups: { id: string; messaging: { topics: unknown[]; subscriptions: unknown[] } }[] }
    const ful = raw.groups.find((g) => g.id === 'ful')!
    ful.messaging.topics.push({ service: 'no name' }, 7)
    ful.messaging.subscriptions.push({ topic: 'x' }, null, { topic: 'z', consumer: '' })

    const { snapshot } = checkSnapshot(raw)
    const m = snapshot!.groups.find((g) => g.id === 'ful')!.messaging

    expect(m.topics.map((t) => t.name)).toEqual(['ful-orders-outbox'])
    expect(m.subscriptions.map((s) => s.consumer)).toEqual(['ful.orders-worker'])
  })

  it('repairs a missing dead-letter total to 0', () => {
    const raw = structuredClone(links) as unknown as { totals: Record<string, unknown> }
    delete raw.totals.deadLetters

    expect(checkSnapshot(raw).snapshot!.totals.deadLetters).toBe(0)
  })
})
