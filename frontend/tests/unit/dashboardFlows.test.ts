import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flowsOf, flowTile, internalOf, trafficByPillar, stableOrder, pillarFlow, windowText, FLOW_TOP, type Flow } from '../../src/dashboard/flows'
import { buildDashboard } from '../../src/dashboard/model'
import { flowTileHtml, pillarFlowHtml, pillarHtml, summaryHtml, type UiState } from '../../src/dashboard/render'
import { ALL_TENANTS } from '../../src/tenants'
import type { Snapshot } from '../../src/types'

const golden = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}.json`), 'utf8')) as Snapshot
const ui = (over: Partial<UiState> = {}): UiState => ({ openPillars: new Set(), groups: new Map(), databases: new Map(), connections: new Set(), sections: new Set(), ...over })

/** The calm town where each pillar of `flows` (id to [sent, received], null = not measured) carries what the broker reported, over a 15 minute window. */
function withFlows(flows: Record<string, [number | null, number | null]>, windowSeconds = 900): Snapshot {
  const s = golden('calm')
  for (const g of s.groups) { g.flow = undefined; for (const n of g.nodes) n.queues = [] }
  for (const [id, [sent, received]] of Object.entries(flows)) s.groups.find((g) => g.id === id)!.flow = { sentPerSecond: sent, receivedPerSecond: received, windowSeconds }
  return s
}
const flow = (id: string, sent: number | null, received: number | null, windowSeconds = 900): Flow => ({ id, name: id.toUpperCase(), sent, received, internal: null, windowSeconds })

describe('pillar flows from the broker', () => {
  it('lists the pillars with a measured side, busiest first, with the name of each', () => {
    const flows = flowsOf(withFlows({ pay: [3000, 20], ldg: [null, 4000], bil: [null, null] }))
    expect(flows.map((f) => [f.id, f.sent, f.received])).toEqual([['ldg', null, 4000], ['pay', 3000, 20]])
    expect(flows[0]).toMatchObject({ name: 'Core Ledger', windowSeconds: 900 })
  })

  it('has no flows when the snapshot reports none, and never counts the hub', () => {
    expect(flowsOf(withFlows({}))).toEqual([])
    const s = withFlows({ pay: [5, 5] })
    s.groups.find((g) => g.isHub)!.flow = { sentPerSecond: 99, receivedPerSecond: 99, windowSeconds: 900 }
    expect(flowsOf(s).map((f) => f.id)).toEqual(['pay'])
  })

  it('says a window the way people say it', () => {
    expect(windowText(900)).toBe('15 min')
    expect(windowText(300)).toBe('5 min')
    expect(windowText(45)).toBe('45 s')
    expect(windowText(7200)).toBe('2 h')
    expect(windowText(0)).toBe('')
  })
})

describe('the Message flow tile', () => {
  it('lists the four busiest pillars of at least one message a second, and all of them behind the button', () => {
    const flows = [flow('a', 900, 1), flow('b', 800, 1), flow('c', 1, 700), flow('d', 600, 0), flow('e', 0, 500), flow('f', 400, 0), flow('g', 0.5, 0)]
    const t = flowTile(flows, [])!
    expect(t.top.map((f) => f.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(t.top).toHaveLength(FLOW_TOP)
    expect(t.all).toHaveLength(7)
    expect(t.max).toBe(900)
    expect(flowTileHtml(t, false)).toContain('Show all 7')
    expect(flowTileHtml(t, true).match(/class="fl"/g)).toHaveLength(7)
    expect(flowTileHtml(t, true)).toContain('Show fewer')
  })

  it('shows what each pillar sends and receives, bars scaled to the busiest side, and says so when a side has no messages', () => {
    const html = flowTileHtml(flowTile([flow('a', 1000, 500), flow('b', 0, 1), flow('c', 250, null)], [])!, true)
    expect(html).toContain('width:100%')
    expect(html).toContain('width:50%')
    expect(html).toContain('width:25%')
    expect(html).toContain('width:2%') // one message a second beside a thousand: a visible sliver
    expect(html).toContain('1.0k msg/s')
    expect(html).toContain('no external messages sent')
    expect(html).not.toContain('no messages received') // c's receiving side is not measured: nothing is said about it
    expect(html).toContain('sends')
    expect(html).toContain('receives')
  })

  it('takes the window it says from the source, never from the code', () => {
    expect(flowTileHtml(flowTile([flow('a', 10, 0, 900)], [])!, false)).toContain('Average over the last 15 min')
    expect(flowTileHtml(flowTile([flow('a', 10, 0, 300)], [])!, false)).toContain('Average over the last 5 min')
    expect(flowTileHtml(flowTile([flow('a', 10, 0, 0)], [])!, false)).not.toContain('Average over')
  })

  it('is left out when nothing moves, and has no button when the short list already holds every pillar', () => {
    expect(flowTile([], [])).toBeNull()
    expect(flowTile([flow('a', 0, 0)], [])).toBeNull()
    expect(flowTileHtml(null, false)).toBe('')
    expect(summaryHtml(buildDashboard(withFlows({}), ALL_TENANTS))).not.toContain('kpi-flow')
    expect(flowTileHtml(flowTile([flow('a', 5, 0)], [])!, false)).not.toContain('data-flows-all')
  })

  it('says so when every pillar is below the minimum, with the button to see them', () => {
    const html = flowTileHtml(flowTile([flow('a', 0.4, 0)], [])!, false)
    expect(html).toContain('No pillar sends or receives 1 message a second or more')
    expect(html).toContain('Show all 1')
  })

  it('keeps the order of the last draw unless a pillar is clearly busier, and puts a new pillar after the old ones', () => {
    const before = [flow('a', 100, 0), flow('b', 99, 0)]
    const ids = (xs: Flow[]) => xs.map((f) => f.id)
    expect(ids(stableOrder([flow('a', 98, 0), flow('b', 100, 0)], ids(before)))).toEqual(['a', 'b']) // 2% busier: stays
    expect(ids(stableOrder([flow('a', 80, 0), flow('b', 100, 0)], ids(before)))).toEqual(['b', 'a']) // 25% busier: moves up
    expect(ids(stableOrder([flow('a', 100, 0), flow('b', 99, 0), flow('x', 101, 0)], ids(before)))).toEqual(['a', 'b', 'x'])
    expect(ids(stableOrder([flow('a', 100, 0), flow('b', 99, 0), flow('x', 500, 0)], ids(before)))).toEqual(['x', 'a', 'b'])
    expect(ids(stableOrder([flow('a', 0, 100), flow('b', 99, 0)], ids(before)))).toEqual(['a', 'b']) // the busier side counts, sending or receiving
  })
})

describe('the flow on the pillar cards', () => {
  const s = withFlows({ pay: [3200, 40], ldg: [null, 15], rwd: [0, 0] })
  const d = buildDashboard(s, ALL_TENANTS)
  const card = (id: string) => d.pillars.find((p) => p.id === id)!

  it('a closed card shows what the pillar sends and receives, and nothing for a pillar that moves nothing or is not measured', () => {
    expect(pillarFlowHtml(card('pay').flow, false)).toContain('sends ext <i>3.2k msg/s</i> · receives <i>40 msg/s</i>')
    expect(pillarFlowHtml(card('ldg').flow, false)).toContain('receives <i>15 msg/s</i>')
    expect(pillarFlowHtml(card('ldg').flow, false)).not.toContain('sends')
    expect(pillarFlowHtml(card('rwd').flow, false)).toBe('') // measured, and nothing moves
    expect(pillarFlowHtml(card('fra').flow, false)).toBe('') // not measured
    const quiet = pillarHtml(card('rwd'), ui())
    expect(quiet).not.toContain('data-flow')
    expect(quiet).not.toContain('Messages')
  })

  it('an open card gives both sides, says so when a side has no messages, and says the window', () => {
    const open = pillarFlowHtml(card('pay').flow, true)
    expect(open).toContain('Sends')
    expect(open).toContain('3.2k msg/s')
    expect(open).toContain('Receives')
    expect(open).toContain('Average over the last 15 min')
    const quiet = pillarFlowHtml(card('rwd').flow, true)
    expect(quiet).toContain('no external messages sent')
    expect(quiet).toContain('no messages received')
    expect(pillarFlowHtml(card('fra').flow, true)).toBe('')
    expect(pillarHtml(card('pay'), ui({ openPillars: new Set(['pay']) }))).toContain('Sends')
    expect(pillarHtml(card('pay'), ui())).not.toContain('Average over')
  })

  it('finds a pillar flow among the flows', () => {
    const flows = flowsOf(s)
    expect(pillarFlow(flows, 'pay')).toMatchObject({ sent: 3200, received: 40 })
    expect(pillarFlow(flows, 'fra')).toBeNull()
  })

  it('never uses a word for towns, islands, buildings or boats', () => {
    const html = summaryHtml(d, { flowsAll: true }) + d.pillars.map((p) => pillarHtml(p, ui({ openPillars: new Set([p.id]) }))).join('')
    const flowParts = html.slice(html.indexOf('id="kpi-flow"'))
    expect(flowParts).not.toMatch(/\b(town|city|island|building|boat)s?\b/i)
  })
})

describe('internal messages, the platform total and traffic by pillar', () => {
  /** The calm town with queues read inside the pillar `pay` (rates 2 and 3, from its own services) and one from another pillar (rate 50, not counted). */
  function withInternal(): Snapshot {
    const s = withFlows({ pay: [10, 4] })
    const aa = s.groups.find((g) => g.id === 'pay')!
    const [one, two] = aa.nodes
    one.queues = [{ name: 'pay-in-1', perSecond: 2 } as never, { name: 'ldg-in', perSecond: 50 } as never]
    two.queues = [{ name: 'pay-in-2', perSecond: 3 } as never]
    aa.messaging = {
      topics: [],
      subscriptions: [
        { topic: 'pay-in-1', publisher: 'pay', consumer: one.id, legacy: false },
        { topic: 'pay-in-2', publisher: 'pay', consumer: two.id, legacy: false },
        { topic: 'ldg-in', publisher: 'ldg', consumer: one.id, legacy: false },
      ],
    } as never
    return s
  }

  it('adds up the queues a pillar reads from its own services, and not the ones another pillar publishes', () => {
    expect(internalOf(withInternal()).get('pay')).toBe(5)
    expect(flowsOf(withInternal()).find((f) => f.id === 'pay')).toMatchObject({ sent: 10, received: 4, internal: 5 })
  })

  it('says sends ext, sends int and receives on the card, and puts the platform total on the tile', () => {
    const d = buildDashboard(withInternal(), ALL_TENANTS)
    expect(pillarFlowHtml(d.pillars.find((p) => p.id === 'pay')!.flow, false)).toContain('sends ext <i>10 msg/s</i> · sends int <i>5.0 msg/s</i> · receives <i>4.0 msg/s</i>')
    expect(pillarFlowHtml(d.pillars.find((p) => p.id === 'pay')!.flow, true)).toContain('Sends inside')
    expect(d.summary.flows!.total).toBe(55)
    expect(flowTileHtml(d.summary.flows, false)).toContain('<b>55 <u>msg/s</u></b>')
  })

  it('lists the pillars by requests a second, busiest first, leaving out the ones with none', () => {
    expect(trafficByPillar([{ id: 'a', name: 'A', rps: 0, split: null }, { id: 'b', name: 'B', rps: 3, split: null }, { id: 'c', name: 'C', rps: 9, split: null }]).map((r) => r.id)).toEqual(['c', 'b'])
    const d = buildDashboard(golden('calm'), ALL_TENANTS)
    expect(d.summary.trafficPillars.length).toBeGreaterThan(0)
    expect(summaryHtml(d)).toContain('data-pillar-traffic')
  })
})
