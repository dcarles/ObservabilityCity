import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { andList, brokerNames, brokerSea, combinedGateways } from '../../src/hubSystems'
import { overviewRows } from '../../src/inspectorModel'
import { portCountsLine } from '../../src/portSign'
import { messagingOf, pierLines } from '../../src/scene/harbour'
import { connectorsOf, portSummary } from '../../src/scene/links'
import { speedFactor } from '../../src/visuals'
import { flowsOf } from '../../src/dashboard/flows'
import { calmScenes } from '../../src/wall/calm'
import type { NodeSnapshot, Snapshot } from '../../src/types'

// A hub with several systems of one kind (multi-hub-town: two gateways, two brokers, two databases, one egress). Each is its own building; what stands for the
// kind as a whole adds them all up, and a hub with one of each reads exactly as it always did.

const golden = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}.json`), 'utf8')) as Snapshot
const multi = golden('multi-hub-town')
const hubOf = (s: Snapshot) => s.groups.find((g) => g.isHub)!
const gateway = (id: string, patch: Partial<NodeSnapshot> = {}): NodeSnapshot => ({ ...hubOf(multi).nodes.find((n) => n.kind === 'Gateway')!, id, ...patch })

describe('the gateways together', () => {
  it('are one gateway\'s own numbers when there is one', () => {
    const one = gateway('hub.gw', { requestsPerSecond: 42, errorRate: 0.03, state: 'Degraded' })
    expect(combinedGateways([one])).toEqual({ requestsPerSecond: 42, errorRate: 0.03, state: 'Degraded', count: 1 })
  })

  it('add up the requests, weigh the error rate by requests and take the worst state', () => {
    const t = combinedGateways([gateway('a', { requestsPerSecond: 90, errorRate: 0.01, state: 'Healthy' }), gateway('b', { requestsPerSecond: 10, errorRate: 0.11, state: 'Down' })])!
    expect(t.requestsPerSecond).toBe(100)
    expect(t.errorRate).toBeCloseTo(0.02, 10)
    expect(t.state).toBe('Down')
    expect(t.count).toBe(2)
  })

  it('take the plain mean of the error rates when nothing is requested', () => {
    expect(combinedGateways([gateway('a', { requestsPerSecond: 0, errorRate: 0.02 }), gateway('b', { requestsPerSecond: 0, errorRate: 0.04 })])!.errorRate).toBeCloseTo(0.03, 10)
  })

  it('are nothing for a hub without one', () => {
    expect(combinedGateways(hubOf(multi).nodes.filter((n) => n.kind !== 'Gateway'))).toBeNull()
  })

  it('are both gateways of the multi-hub town', () => {
    const t = combinedGateways(hubOf(multi).nodes)!
    expect(t.count).toBe(2)
    expect(t.requestsPerSecond).toBe(80 + 24)
  })
})

describe('the wall\'s caption for the hub', () => {
  it('names one broker and reads one gateway as it always did', () => {
    // links-town has one of each kind on its hub (the sample town now has two gateways, two brokers and two databases)
    const s = golden('links-town')
    const hub = hubOf(s)
    const broker = hub.nodes.find((n) => n.kind === 'Broker')!
    const rate = hub.nodes.find((n) => n.kind === 'Gateway')!.requestsPerSecond
    expect(hub.nodes.filter((n) => n.kind === 'Broker')).toHaveLength(1)
    expect(calmScenes(s)[1].caption).toBe(`${hub.displayName}: ${hub.nodes.length} shared systems, with ${broker.name} carrying the messages and ${Math.round(rate)} req/s through the gateway`)
  })

  it('names every broker and adds up every gateway', () => {
    expect(calmScenes(multi)[1].caption).toBe('Platform hub: 7 shared systems, with Event broker and Task broker carrying the messages and 104 req/s through the gateways')
  })

  it('lists three names with commas', () => {
    expect(andList(['A', 'B', 'C'])).toBe('A, B and C')
    expect(andList(['A'])).toBe('A')
    expect(andList([])).toBe('')
  })
})

describe('the town\'s message total in a broker\'s drawer', () => {
  const broker = hubOf(multi).nodes.find((n) => n.kind === 'Broker')!

  it('is "Messages" on the only broker', () => {
    expect(overviewRows(broker, undefined, null, 12)[0]).toEqual({ label: 'Messages', value: '12 msg/s through the queues', tone: '' })
  })

  it('is labelled as the town\'s on each of several brokers, as no queue says which broker holds it', () => {
    const count = brokerNames(hubOf(multi).nodes).length
    expect(count).toBe(2)
    for (const b of hubOf(multi).nodes.filter((n) => n.kind === 'Broker')) {
      expect(overviewRows(b, undefined, null, 12, count)[0]).toEqual({ label: 'Messages (town)', value: '12 msg/s through the queues', tone: '' })
    }
  })

  it('is on no other building', () => {
    const gw = hubOf(multi).nodes.find((n) => n.kind === 'Gateway')!
    expect(overviewRows(gw, undefined, null, 12, 2).some((r) => r.label.startsWith('Messages'))).toBe(false)
  })
})

describe('the piers and the port of the multi-hub town', () => {
  const islands = multi.groups.filter((g) => !g.isHub)

  it('has one pier for each island, whatever the number of brokers', () => {
    expect(islands.map((g) => connectorsOf(g).pier)).toEqual([true, true, true])
    expect(portSummary(multi.groups)).toEqual({ topics: 3, subscriptions: 4, piers: 3 })
  })

  it('counts on each island\'s pier everything its own consumers hold, from every broker, and the islands add up to the town', () => {
    const boards = islands.map((g) => ({ id: g.id, m: messagingOf([...g.nodes], g.messaging) }))
    for (const { id, m } of boards) {
      const g = islands.find((x) => x.id === id)!
      const consumers = new Set(g.messaging!.subscriptions.map((x) => x.consumer))
      const workers = g.nodes.filter((n) => consumers.has(n.id))
      expect(m.waiting, id).toBe(workers.reduce((a, n) => a + (n.queueDepth ?? 0), 0))
      expect(m.deadLetters, id).toBe(workers.reduce((a, n) => a + (n.deadLetters ?? 0), 0))
      expect(m.topics, id).toBe(g.messaging!.topics.length)
      expect(m.subscriptions, id).toBe(g.messaging!.subscriptions.length)
    }
    const town = portSummary(multi.groups)
    expect(boards.reduce((a, b) => a + b.m.topics, 0)).toBe(town.topics)
    expect(boards.reduce((a, b) => a + b.m.subscriptions, 0)).toBe(town.subscriptions)
    expect(boards.find((b) => b.id === 'stk')!.m.subscriptions).toBe(2)
  })

  it('says on each pier what its island sends and receives, from the island\'s own flow', () => {
    const flows = new Map(flowsOf(multi).map((f) => [f.id, f]))
    for (const g of islands) {
      const f = flows.get(g.id)!
      expect(f.sent).toBe(g.flow!.sentPerSecond)
      expect(f.received).toBe(g.flow!.receivedPerSecond)
      const lines = pierLines({ ...messagingOf([...g.nodes], g.messaging), pillar: { sent: f.sent, internal: f.internal, received: f.received, windowSeconds: f.windowSeconds } })
      expect(lines, g.id).toContain(`Sends outside ${Math.round(g.flow!.sentPerSecond!)} msg/s`)
      expect(lines, g.id).toContain(`Receives ${Math.round(g.flow!.receivedPerSecond!)} msg/s`)
    }
  })

  it('reads the town\'s counts on the port as the town\'s when there are several brokers, and as before with one', () => {
    expect(portCountsLine(portSummary(multi.groups), true)?.text).toBe('Town: 3 topics · 4 subscriptions · 3 piers')
    expect(portCountsLine(portSummary(multi.groups))?.text).toBe('3 topics · 4 subscriptions · 3 piers')
  })
})

describe('what the boats follow with several brokers', () => {
  const broker = (state: string, p99Ms = 50, slaP99Ms = 100) => ({ state: state as NodeSnapshot['state'], p99Ms, slaP99Ms })

  it('gives one broker its own answer', () => {
    expect(brokerSea([broker('Healthy')])).toEqual({ running: true, speed: speedFactor(50, 100) })
    expect(brokerSea([broker('Down')]).running).toBe(false)
  })

  it('keeps the boats sailing while any broker is up, even when the first is down', () => {
    expect(brokerSea([broker('Down'), broker('Healthy')])).toEqual({ running: true, speed: speedFactor(50, 100) })
    expect(brokerSea([broker('Healthy'), broker('Down')]).running).toBe(true)
  })

  it('stops them only when every broker is down', () => {
    expect(brokerSea([broker('Down'), broker('Down')]).running).toBe(false)
  })

  it('sails as slowly as the slowest running broker, and ignores a down one\'s latency', () => {
    expect(brokerSea([broker('Healthy', 10), broker('Degraded', 200)]).speed).toBe(speedFactor(200, 100))
    expect(brokerSea([broker('Down', 900), broker('Healthy', 10)]).speed).toBe(speedFactor(10, 100))
  })

  it('treats a broker with no reading as up at normal speed, and a hub with none as unchanged', () => {
    expect(brokerSea([undefined])).toEqual({ running: true, speed: 1 })
    expect(brokerSea([])).toEqual({ running: true, speed: 1 })
  })
})
