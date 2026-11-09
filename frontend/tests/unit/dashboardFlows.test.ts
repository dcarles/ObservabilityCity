import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flowsOf, flowTile, stableOrder, pillarFlow, windowText, FLOW_TOP, type Flow } from '../../src/dashboard/flows'
import { buildDashboard } from '../../src/dashboard/model'
import { flowTileHtml, pillarFlowHtml, pillarHtml, summaryHtml, type UiState } from '../../src/dashboard/render'
import { ALL_TENANTS } from '../../src/tenants'
import type { Snapshot } from '../../src/types'

const golden = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}.json`), 'utf8')) as Snapshot
const ui = (over: Partial<UiState> = {}): UiState => ({ openPillars: new Set(), groups: new Map(), databases: new Map(), connections: new Set(), sections: new Set(), ...over })

/** The calm town where each pillar of `flows` (id to [sent, received], null = not measured) carries what the broker reported, over a 15 minute window. */
function withFlows(flows: Record<string, [number | null, number | null]>, windowSeconds = 900): Snapshot {
  const s = golden('calm')
  for (const g of s.groups) g.flow = undefined
  for (const [id, [sent, received]] of Object.entries(flows)) s.groups.find((g) => g.id === id)!.flow = { sentPerSecond: sent, receivedPerSecond: received, windowSeconds }
  return s
}
const flow = (id: string, sent: number | null, received: number | null, windowSeconds = 900): Flow => ({ id, name: id.toUpperCase(), sent, received, windowSeconds })

describe('pillar flows from the broker', () => {
  it('lists the pillars with a measured side, busiest first, with the name of each', () => {
    const flows = flowsOf(withFlows({ pay: [3000, 20], cl: [null, 4000], bil: [null, null] }))
    expect(flows.map((f) => [f.id, f.sent, f.received])).toEqual([['cl', null, 4000], ['pay', 3000, 20]])
    expect(flows[0]).toMatchObject({ name: 'Core Ledger', windowSeconds: 900 })
  })

  it('has no flows when the snapshot reports none, and never counts the hub', () => {
    expect(flowsOf(golden('calm'))).toEqual([])
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
  it('lists the five busiest pillars of at least one message a second, and all of them behind the button', () => {
    const flows = [flow('a', 900, 1), flow('b', 800, 1), flow('c', 1, 700), flow('d', 600, 0), flow('e', 0, 500), flow('f', 400, 0), flow('g', 0.5, 0)]
    const t = flowTile(flows, [])!
    expect(t.top.map((f) => f.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
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
    expect(html).toContain('no messages sent')
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
    expect(summaryHtml(buildDashboard(golden('calm'), ALL_TENANTS))).not.toContain('kpi-flow')
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
  const s = withFlows({ pay: [3200, 40], cl: [null, 15], rwd: [0, 0] })
  const d = buildDashboard(s, ALL_TENANTS)
  const card = (id: string) => d.pillars.find((p) => p.id === id)!

  it('a closed card shows what the pillar sends and receives, and nothing for a pillar that moves nothing or is not measured', () => {
    expect(pillarFlowHtml(card('pay').flow, false)).toContain('sends <i>3.2k msg/s</i> · receives <i>40 msg/s</i>')
    expect(pillarFlowHtml(card('cl').flow, false)).toContain('receives <i>15 msg/s</i>')
    expect(pillarFlowHtml(card('cl').flow, false)).not.toContain('sends')
    expect(pillarFlowHtml(card('rwd').flow, false)).toBe('') // measured, and nothing moves
    expect(pillarFlowHtml(card('frd').flow, false)).toBe('') // not measured
    const quiet = pillarHtml(card('rwd'), ui())
    expect(quiet).not.toContain('pflow')
    expect(quiet).not.toContain('Messages')
  })

  it('an open card gives both sides, says so when a side has no messages, and says the window', () => {
    const open = pillarFlowHtml(card('pay').flow, true)
    expect(open).toContain('Sends')
    expect(open).toContain('3.2k msg/s')
    expect(open).toContain('Receives')
    expect(open).toContain('Average over the last 15 min')
    const quiet = pillarFlowHtml(card('rwd').flow, true)
    expect(quiet).toContain('no messages sent')
    expect(quiet).toContain('no messages received')
    expect(pillarFlowHtml(card('frd').flow, true)).toBe('')
    expect(pillarHtml(card('pay'), ui({ openPillars: new Set(['pay']) }))).toContain('Sends')
    expect(pillarHtml(card('pay'), ui())).not.toContain('Average over')
  })

  it('finds a pillar flow among the flows', () => {
    const flows = flowsOf(s)
    expect(pillarFlow(flows, 'pay')).toMatchObject({ sent: 3200, received: 40 })
    expect(pillarFlow(flows, 'frd')).toBeNull()
  })

  it('never uses a word for towns, islands, buildings or boats', () => {
    const html = summaryHtml(d, { flowsAll: true }) + d.pillars.map((p) => pillarHtml(p, ui({ openPillars: new Set([p.id]) }))).join('')
    const flowParts = html.slice(html.indexOf('id="kpi-flow"'))
    expect(flowParts).not.toMatch(/\b(town|city|island|building|boat)s?\b/i)
  })
})
