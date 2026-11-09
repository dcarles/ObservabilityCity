import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flowsOf, flowTile, stableOrder, pillarFlows, FLOW_TOP, type Flow } from '../../src/dashboard/flows'
import { buildDashboard } from '../../src/dashboard/model'
import { flowTileHtml, pillarFlowsHtml, pillarHtml, summaryHtml, type UiState } from '../../src/dashboard/render'
import { ALL_TENANTS } from '../../src/tenants'
import type { Snapshot } from '../../src/types'

const golden = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}.json`), 'utf8')) as Snapshot
const ui = (over: Partial<UiState> = {}): UiState => ({ openPillars: new Set(), groups: new Map(), databases: new Map(), connections: new Set(), sections: new Set(), ...over })

/** The calm town with a rate on every queue a worker reads: `rates` maps `topic@consumer` to msg/s; every other queue is zeroed. */
function withRates(rates: Record<string, number>): Snapshot {
  const s = golden('calm')
  for (const g of s.groups) {
    for (const n of g.nodes) n.queues = undefined
    for (const sub of g.messaging.subscriptions) {
      const reader = g.nodes.find((n) => n.id === sub.consumer)
      if (!reader) continue
      reader.queues = [...(reader.queues ?? []), { name: sub.topic, backlog: 0, deadLetters: 0, perSecond: rates[`${sub.topic}@${sub.consumer}`] ?? 0 }]
    }
  }
  return s
}
const flow = (from: string, to: string, perSecond: number): Flow => ({ id: `${from}>${to}`, from, fromName: from, to, toName: to, perSecond })

describe('pillar to pillar flows', () => {
  it('adds up the queues a pillar reads, by the pillar that publishes them', () => {
    const s = withRates({ 'pay-payments-outbox@cl.ledger-worker': 3000, 'bil-invoices-outbox@cl.ledger-worker': 20, 'pay-payments-outbox@frd.screening-worker': 5 })
    const flows = flowsOf(s)
    expect(flows.map((f) => [f.id, f.perSecond])).toEqual([['pay>cl', 3000], ['bil>cl', 20], ['pay>frd', 5]])
    expect(flows[0]).toMatchObject({ fromName: 'Payments', toName: 'Core Ledger' })
  })

  it('sums several queues of the same pair and keeps each direction apart', () => {
    const s = withRates({ 'cl-ledger-outbox@acc.accounts-worker': 10, 'cl-ledger-outbox@dat.ingest-worker': 4, 'acq-applications-outbox@acc.accounts-worker': 7 })
    expect(flowsOf(s).find((f) => f.id === 'cl>acc')!.perSecond).toBe(10)
    const two = withRates({ 'pay-payments-outbox@cl.ledger-worker': 2 })
    const cl = two.groups.find((g) => g.id === 'cl')!
    const first = cl.nodes.find((n) => n.id === 'cl.ledger-worker')!
    cl.nodes.push({ ...first, id: 'cl.extra-worker', queues: [{ name: 'pay-payments-outbox', backlog: 0, deadLetters: 0, perSecond: 3 }] }) // a second service of the pillar reads the same topic
    cl.messaging.subscriptions.push({ topic: 'pay-payments-outbox', publisher: 'pay', consumer: 'cl.extra-worker', legacy: false })
    expect(flowsOf(two).find((f) => f.id === 'pay>cl')!.perSecond).toBe(5)
    expect(flowsOf(two).some((f) => f.id === 'cl>pay')).toBe(false)
  })

  it('leaves out legacy reads, the hub, queues of the same pillar, queues nobody measures and queues with no rate', () => {
    const s = withRates({ 'hub-egress@lost-found.batch-gateway-worker': 500, 'col-cases-outbox@col.dunning-worker': 500, 'pay-payments-outbox@cl.ledger-worker': 0 })
    expect(flowsOf(s)).toEqual([])
    for (const g of s.groups) for (const n of g.nodes) for (const q of n.queues ?? []) q.perSecond = undefined
    expect(flowsOf(s)).toEqual([])
  })

  it('leaves out a publisher that is not a pillar of the snapshot (a hidden pillar)', () => {
    const s = withRates({ 'pay-payments-outbox@cl.ledger-worker': 50, 'bil-invoices-outbox@cl.ledger-worker': 9 })
    s.groups = s.groups.filter((g) => g.id !== 'pay')
    expect(flowsOf(s).map((f) => f.id)).toEqual(['bil>cl'])
  })
})

describe('the Message flow tile', () => {
  it('lists the five biggest pairs of at least one message a second, and all of them behind the button', () => {
    const flows = [flow('a', 'b', 900), flow('a', 'c', 800), flow('b', 'c', 700), flow('c', 'a', 600), flow('c', 'b', 500), flow('b', 'a', 400), flow('d', 'a', 0.5)]
    const t = flowTile(flows, [])!
    expect(t.top.map((f) => f.id)).toEqual(['a>b', 'a>c', 'b>c', 'c>a', 'c>b'])
    expect(t.top).toHaveLength(FLOW_TOP)
    expect(t.all).toHaveLength(7)
    expect(t.max).toBe(900)
    expect(flowTileHtml(t, false)).toContain('Show all 7')
    expect(flowTileHtml(t, true).match(/class="fl"/g)).toHaveLength(7)
    expect(flowTileHtml(t, true)).toContain('Show fewer')
  })

  it('scales the bars to the busiest pair and gives a trickle a visible sliver', () => {
    const html = flowTileHtml(flowTile([flow('a', 'b', 1000), flow('a', 'c', 500), flow('a', 'd', 1)], [])!, true)
    expect(html).toContain('width:100%')
    expect(html).toContain('width:50%')
    expect(html).toContain('width:2%')
    expect(html).toContain('1.0k msg/s')
    expect(html).toContain('a → b')
  })

  it('is left out when nothing flows, and has no button when the short list already holds every pair', () => {
    expect(flowTile([], [])).toBeNull()
    expect(flowTileHtml(null, false)).toBe('')
    expect(summaryHtml(buildDashboard(golden('calm'), ALL_TENANTS))).not.toContain('kpi-flow')
    expect(flowTileHtml(flowTile([flow('a', 'b', 5)], [])!, false)).not.toContain('data-flows-all')
  })

  it('says so when every pair is below the minimum, with the button to see them', () => {
    const html = flowTileHtml(flowTile([flow('a', 'b', 0.4)], [])!, false)
    expect(html).toContain('No pair of pillars sends 1 message a second or more')
    expect(html).toContain('Show all 1')
  })

  it('keeps the order of the last draw unless a pair is clearly bigger, and puts a new pair after the old ones', () => {
    const before = [flow('a', 'b', 100), flow('a', 'c', 99)]
    expect(stableOrder([flow('a', 'b', 98), flow('a', 'c', 100)], before.map((f) => f.id)).map((f) => f.id)).toEqual(['a>b', 'a>c']) // 2% bigger: stays
    expect(stableOrder([flow('a', 'b', 80), flow('a', 'c', 100)], before.map((f) => f.id)).map((f) => f.id)).toEqual(['a>c', 'a>b']) // 25% bigger: moves up
    expect(stableOrder([flow('a', 'b', 100), flow('a', 'c', 99), flow('x', 'y', 101)], before.map((f) => f.id)).map((f) => f.id)).toEqual(['a>b', 'a>c', 'x>y'])
    expect(stableOrder([flow('a', 'b', 100), flow('a', 'c', 99), flow('x', 'y', 500)], before.map((f) => f.id)).map((f) => f.id)).toEqual(['x>y', 'a>b', 'a>c'])
  })
})

describe('flows on the pillar cards', () => {
  const s = withRates({ 'pay-payments-outbox@cl.ledger-worker': 3200, 'pay-payments-outbox@frd.screening-worker': 40, 'cl-ledger-outbox@acc.accounts-worker': 15 })
  const d = buildDashboard(s, ALL_TENANTS)
  const card = (id: string) => d.pillars.find((p) => p.id === id)!

  it('a closed card shows only the biggest flow the pillar sends, and a pillar that sends nothing shows nothing', () => {
    expect(pillarFlowsHtml(card('pay').flows, false)).toContain('→ Core Ledger <i>3.2k msg/s</i>')
    expect(pillarFlowsHtml(card('pay').flows, false)).not.toContain('Fraud')
    expect(pillarFlowsHtml(card('rwd').flows, false)).toBe('')
    const quiet = pillarHtml(card('rwd'), ui())
    expect(quiet).not.toContain('pflow')
    expect(quiet).not.toContain('Messages')
  })

  it('an open card lists everything the pillar sends and reads, biggest first', () => {
    const open = pillarFlowsHtml(card('cl').flows, true)
    expect(open).toContain('Sends to')
    expect(open).toContain('Accounts <i>15 msg/s</i>')
    expect(open).toContain('Reads from')
    expect(open).toContain('Payments <i>3.2k msg/s</i>')
    const pay = pillarFlowsHtml(card('pay').flows, true)
    expect(pay.indexOf('Core Ledger')).toBeLessThan(pay.indexOf('Fraud'))
    expect(pay).not.toContain('Reads from')
    expect(pillarHtml(card('pay'), ui({ openPillars: new Set(['pay']) }))).toContain('Sends to')
    expect(pillarHtml(card('pay'), ui())).not.toContain('Sends to')
  })

  it('splits what a pillar sends and reads from the same flows', () => {
    const flows = flowsOf(s)
    expect(pillarFlows(flows, 'cl').in.map((f) => f.id)).toEqual(['pay>cl'])
    expect(pillarFlows(flows, 'cl').out.map((f) => f.id)).toEqual(['cl>acc'])
  })

  it('never uses a word for towns, islands, buildings or boats', () => {
    const html = summaryHtml(d, { flowsAll: true }) + d.pillars.map((p) => pillarHtml(p, ui({ openPillars: new Set([p.id]) }))).join('')
    const flowParts = html.slice(html.indexOf('id="kpi-flow"'))
    expect(flowParts).not.toMatch(/\b(town|city|island|building|boat)s?\b/i)
  })
})
