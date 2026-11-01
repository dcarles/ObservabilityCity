import { test, expect } from '../support/test'

// Where an API's traffic comes from, on mini-town. The page is handed a snapshot as if the server had sent it and read in the same breath, since the
// next snapshot from the server puts the real town back. Measured, the outside part is the API's total less what town systems send and arrives at the
// airport whichever building it is; not measured, nothing is made up: the rate is shared evenly between everything that can be seen to call it.

/** Hands the page a snapshot in which the given APIs are measured, and reports what the airport and the car routes then say. */
function measured(page: import('@playwright/test').Page, apis: Record<string, { rps: number; outside: number; from?: [string, number][] }>) {
  return page.evaluate((spec) => {
    const c = (window as any).city
    const s = structuredClone(c.seen.last)
    const nodes = s.groups.flatMap((g: any) => g.nodes)
    let total = 0
    for (const [id, m] of Object.entries(spec) as [string, { rps: number; outside: number; from?: [string, number][] }][]) {
      const n = nodes.find((x: any) => x.id === id)
      n.requestsPerSecond = m.rps
      n.outsideRequestsPerSecond = m.outside
      n.inbound = (m.from ?? []).map(([from, requestsPerSecond]) => ({ from, requestsPerSecond }))
      n.inboundEstimated = false
      total += m.outside
    }
    s.outsideRequestsPerSecond = total
    c.feed(s)
    const outsideShare = (id: string) => c.town.cars.routeList.filter((r: any) => r.dest.id === id && r.origin === 'external').map((r: any) => (typeof r.share === 'function' ? r.share() : r.share))
    return {
      airport: c.inspectAirport(),
      total,
      shares: Object.fromEntries(Object.keys(spec).map((id) => [id, outsideShare(id)])),
    }
  }, apis)
}

test.describe('where an API\'s traffic comes from', () => {
  test('measured, the airport brings in the outside part of every API and each road takes its measured share', async ({ town, page }) => {
    await town.open()

    const out = await measured(page, {
      'aa.orders-api': { rps: 10, outside: 7, from: [['aa.orders-worker', 3]] },
      'bb.ledger-api': { rps: 4, outside: 4 },
      'cc.notify-api': { rps: 2, outside: 0.5 },
    })

    expect(out.airport.requestsPerSecond).toBeCloseTo(11.5, 6) // 7 + 4 + 0.5: the sum of the outside parts
    expect(out.shares['aa.orders-api']).toEqual([expect.closeTo(0.7, 6)])
    expect(out.shares['bb.ledger-api']).toEqual([expect.closeTo(1, 6)])
    expect(out.shares['cc.notify-api']).toEqual([expect.closeTo(0.25, 6)])
    expect(out.airport.board[0]).toContain('ARRIVALS')
    expect(out.airport.board).toHaveLength(1) // the declared callers are only names: the board shows the total alone
  })

  test('not measured, an external API with no known caller gets all of it from outside and no fixed share is made up', async ({ town, page }) => {
    await town.open()

    const shares = await page.evaluate(() => {
      const c = (window as any).city
      const n = c.seen.last.groups.flatMap((g: any) => g.nodes).find((x: any) => x.id === 'cc.notify-api')
      return { measured: n.outsideRequestsPerSecond, routes: c.town.cars.routeList.filter((r: any) => r.dest.id === 'cc.notify-api' && r.origin === 'external').map((r: any) => (typeof r.share === 'function' ? r.share() : r.share)) }
    })

    expect(shares.measured).toBeNull()
    expect(shares.routes).toEqual([1])
    expect(shares.routes).not.toContain(0.85)
  })

  test('not measured, a call through the gateway is a known caller: the outside and that caller share the traffic evenly', async ({ town, page }) => {
    await town.open()

    const routes = await page.evaluate(() => {
      const c = (window as any).city
      return c.town.cars.routeList
        .filter((r: any) => r.dest.id === 'aa.orders-api')
        .map((r: any) => ({ origin: r.origin, source: r.source.id ?? r.source.node?.id, share: typeof r.share === 'function' ? r.share() : r.share }))
    })

    // aa.orders-api is called through the gateway by cc.notify-api and is open to the outside: two slots, half each
    expect(routes.filter((r: any) => r.origin === 'external').map((r: any) => r.share)).toEqual([0.5])
    expect(routes.some((r: any) => r.origin === 'internal' && r.source === 'cc.notify-api' && Math.abs(r.share - 0.5) < 1e-9)).toBe(true)
  })
})
