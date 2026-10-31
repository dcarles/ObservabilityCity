import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inboundMix, inboundSplitText, isMeasured } from '../../src/inbound'
import { overviewRows } from '../../src/inspectorModel'
import { checkSnapshot } from '../../src/snapshotGuard'
import type { NodeSnapshot, Snapshot } from '../../src/types'

const calm = JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/calm.json'), 'utf8')) as Snapshot
const api = (patch: Partial<NodeSnapshot> = {}): NodeSnapshot => ({ ...calm.groups.flatMap((g) => g.nodes).find((n) => n.kind === 'Api' && n.state === 'Healthy')!, ...patch })
const ids = (...names: string[]) => new Set(names)
const measured = (rps: number, outside: number, from: [string, number][] = []) =>
  api({ requestsPerSecond: rps, outsideRequestsPerSecond: outside, inbound: from.map(([id, r]) => ({ from: id, requestsPerSecond: r })) })

describe('where an API\'s traffic comes from, as the renderer reads it', () => {
  it('measured: the outside part and each caller are their shares of the API\'s own rate', () => {
    const mix = inboundMix(measured(10, 6, [['a.x', 3], ['b.y', 1]]), ids('a.x', 'b.y'), false)

    expect(mix.outside).toBeCloseTo(0.6)
    expect(mix.caller('a.x')).toBeCloseTo(0.3)
    expect(mix.caller('b.y')).toBeCloseTo(0.1)
    expect(mix.standIn).toBe(0)
  })

  it('measured: a building nobody in the town calls gets all of it from outside, marked external or not', () => {
    const mix = inboundMix(measured(5, 5), ids(), false)

    expect(mix.outside).toBe(1)
  })

  it('measured: a caller the telemetry does not show sends nothing, even if it declares a call, and no stand-in is invented', () => {
    const mix = inboundMix(measured(10, 10, [['a.x', 0]]), ids('a.x', 'b.y', 'declared.but.silent'), true)

    expect(mix.caller('declared.but.silent')).toBe(0)
    expect(mix.standIn).toBe(0)
  })

  it('measured: an idle API has no traffic from anywhere', () => {
    const mix = inboundMix(measured(0, 0), ids('a.x', 'b.y'), true)

    expect([mix.outside, mix.caller('a.x'), mix.standIn]).toEqual([0, 0, 0])
  })

  it('measured: shares never go past one, whatever the numbers', () => {
    expect(inboundMix(measured(1, 5, [['a.x', 9]]), ids('a.x'), false).outside).toBe(1)
    expect(inboundMix(measured(1, 5, [['a.x', 9]]), ids('a.x'), false).caller('a.x')).toBe(1)
  })

  it('not measured: the rate is shared evenly between the declared callers and the outside, with no fixed split', () => {
    const node = api({ outsideRequestsPerSecond: null, inbound: null })

    const external = inboundMix(node, ids('a.x', 'b.y', 'c.z'), true)
    expect(external.outside).toBeCloseTo(0.25)
    expect(external.caller('a.x')).toBeCloseTo(0.25)
    expect(external.caller('stand.in')).toBe(0) // a caller nothing declares is not one of them
    const internal = inboundMix(node, ids('a.x', 'b.y', 'c.z'), false)
    expect(internal.outside).toBe(0)
    expect(internal.caller('a.x')).toBeCloseTo(1 / 3)
    // the old split gave an external API 85% from outside whatever its callers; nothing like it is left
    expect([external.outside, inboundMix(node, ids('a.x'), true).outside]).not.toContain(0.85)
  })

  it('not measured: an API nothing can be seen to call gets a stand-in so its road is not silent, unless it is called from outside', () => {
    const node = api({ outsideRequestsPerSecond: null, inbound: null })

    expect(inboundMix(node, ids(), false)).toMatchObject({ outside: 0, standIn: 1 })
    expect(inboundMix(node, ids(), true)).toMatchObject({ outside: 1, standIn: 0 })
  })

  it('a node that is not drawn has no traffic, and only an API can be measured', () => {
    expect(inboundMix(null, ids('a.x'), true).outside).toBe(0)
    expect(isMeasured(api({ kind: 'Database', outsideRequestsPerSecond: 1, inbound: [] }))).toBe(false)
  })
})

describe('what the inspector says', () => {
  const names: Record<string, string> = { 'a.x': 'Merchant', 'b.y': 'Offers' }
  const nameOf = (id: string) => names[id] ?? id

  it('splits a measured API\'s traffic, biggest first, and says it is measured', () => {
    const n = measured(100, 64, [['a.x', 28], ['b.y', 8]])

    expect(inboundSplitText(n, nameOf)).toBe('64% outside · 28% Merchant · 8% Offers')
    const row = overviewRows({ ...n, absent: [] }, nameOf).find((r) => r.label === 'Comes from')
    expect(row?.value).toBe('64% outside · 28% Merchant · 8% Offers (measured)')
  })

  it('marks a share that stands on too few calls as estimated', () => {
    const row = overviewRows({ ...measured(10, 10), inboundEstimated: true, absent: [] }).find((r) => r.label === 'Comes from')

    expect(row?.value).toBe('100% outside (estimated)')
  })

  it('says nothing when the traffic is not measured, when the API is idle, or when requests are not a signal here', () => {
    expect(overviewRows({ ...api(), outsideRequestsPerSecond: null, inbound: null }).some((r) => r.label === 'Comes from')).toBe(false)
    expect(inboundSplitText(measured(0, 0), nameOf)).toBeNull()
    expect(overviewRows({ ...measured(10, 10), absent: ['requests'] }).some((r) => r.label === 'Comes from')).toBe(false)
  })
})

describe('the snapshot guard', () => {
  it('keeps what the server measured and repairs what is wrong with it', () => {
    const raw = structuredClone(calm)
    const nodes = raw.groups.flatMap((g) => g.nodes)
    const a = nodes.find((n) => n.kind === 'Api')!
    Object.assign(a, { outsideRequestsPerSecond: 2.5, inbound: [{ from: 'a.x', requestsPerSecond: 1 }, { from: '', requestsPerSecond: 3 }, { from: 'b.y', requestsPerSecond: 'lots' }], inboundEstimated: true })
    raw.outsideRequestsPerSecond = 7

    const { snapshot } = checkSnapshot(raw)

    const out = snapshot!.groups.flatMap((g) => g.nodes).find((n) => n.id === a.id)!
    expect(out.outsideRequestsPerSecond).toBe(2.5)
    expect(out.inbound).toEqual([{ from: 'a.x', requestsPerSecond: 1 }, { from: 'b.y', requestsPerSecond: 0 }])
    expect(out.inboundEstimated).toBe(true)
    expect(snapshot!.outsideRequestsPerSecond).toBe(7)
  })

  it('treats an older server that says nothing as not measured', () => {
    const raw = structuredClone(calm) as unknown as Record<string, unknown>
    delete raw.outsideRequestsPerSecond

    const { snapshot } = checkSnapshot(raw)

    expect(snapshot!.outsideRequestsPerSecond).toBeNull()
    expect(snapshot!.groups.flatMap((g) => g.nodes).every((n) => n.outsideRequestsPerSecond === null && n.inbound === null)).toBe(true)
  })
})
