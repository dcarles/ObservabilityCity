import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flowsOf, internalOf, pillarFlow, windowText } from '../../src/dashboard/flows'
import { buildDashboard } from '../../src/dashboard/model'
import { pillarFlowHtml, pillarHtml, summaryHtml, type UiState } from '../../src/dashboard/render'
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
    const html = summaryHtml(d) + d.pillars.map((p) => pillarHtml(p, ui({ openPillars: new Set([p.id]) }))).join('')
    const flowParts = html.slice(html.indexOf('id="kpi-flow"'))
    expect(flowParts).not.toMatch(/\b(town|city|island|building|boat)s?\b/i)
  })
})

describe('internal messages and the platform total', () => {
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
        { topic: 'pay-in-1', publisher: 'pay', consumer: one.id },
        { topic: 'pay-in-2', publisher: 'pay', consumer: two.id },
        { topic: 'ldg-in', publisher: 'ldg', consumer: one.id },
      ],
    } as never
    return s
  }

  it('adds up the queues a pillar reads from its own services, and not the ones another pillar publishes', () => {
    expect(internalOf(withInternal()).get('pay')).toBe(5)
    expect(flowsOf(withInternal()).find((f) => f.id === 'pay')).toMatchObject({ sent: 10, received: 4, internal: 5 })
  })

  it('says sends ext, sends int and receives on the card, and puts the platform total in the Message flow box', () => {
    const d = buildDashboard(withInternal(), ALL_TENANTS)
    expect(pillarFlowHtml(d.pillars.find((p) => p.id === 'pay')!.flow, false)).toContain('sends ext <i>10 msg/s</i> · sends int <i>5.0 msg/s</i> · receives <i>4.0 msg/s</i>')
    expect(pillarFlowHtml(d.pillars.find((p) => p.id === 'pay')!.flow, true)).toContain('Sends inside')
    expect(d.summary.messageFlow).toBe(55)
    expect(summaryHtml(d)).toContain('<b>55 <u>msg/s</u></b>')
  })
})
