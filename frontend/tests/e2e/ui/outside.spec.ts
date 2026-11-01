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

  test('a small measured caller still sends a car now and then, one with nothing measured sends none', async ({ town, page }) => {
    await town.open()

    const rates = await page.evaluate(() => {
      const c = (window as any).city
      const s = structuredClone(c.seen.last)
      const nodes = s.groups.flatMap((g: any) => g.nodes)
      const set = (id: string, rps: number, outside: number, from: [string, number][]) => {
        const n = nodes.find((x: any) => x.id === id)
        n.requestsPerSecond = rps; n.outsideRequestsPerSecond = outside
        n.inbound = from.map(([f, r]) => ({ from: f, requestsPerSecond: r })); n.inboundEstimated = false
      }
      set('aa.orders-api', 1000, 999.9, [['cc.notify-api', 0.1]]) // 0.01% from the caller
      set('bb.ledger-api', 1000, 1000, []) // the caller is known but sends nothing measured
      c.feed(s)
      const rateTo = (dest: string, source: string) => {
        const r = c.town.cars.routeList.find((x: any) => x.dest.id === dest && x.source.id === source)
        return r ? c.town.cars.rateOf(r) : null
      }
      const quiet = c.town.cars.density * c.town.cars.townDensity
      return { quiet, small: rateTo('aa.orders-api', 'cc.notify-api'), none: rateTo('bb.ledger-api', 'cc.notify-api') }
    })

    expect(rates.small).toBeCloseTo(rates.quiet / 20, 6) // the floor: one every 20 s (at full density)
    expect(rates.none).toBe(0)
  })
})

test.describe('cars to a third party', () => {
  test('are driven at the measured call rate, whatever the third party\'s own state, each road taking its callers\' part', async ({ town, page }) => {
    await town.open()

    const out = await page.evaluate(() => {
      const c = (window as any).city
      const s = structuredClone(c.seen.last)
      const v = s.vendors.find((x: any) => x.node.id === 'ext.mailer')
      v.node.state = 'Stale'
      v.node.requestsPerSecond = 8
      v.node.inbound = [{ from: 'cc.notify-worker', requestsPerSecond: 6 }, { from: 'bb.ledger-worker', requestsPerSecond: 2 }]
      c.feed(s)
      const routes = c.town.cars.routeList.filter((r: any) => r.vendor && r.dest.id === 'ext.mailer')
      return routes.map((r: any) => ({ from: r.source.node?.id ?? r.source.id, share: typeof r.share === 'function' ? r.share() : r.share, rate: c.town.cars.rateOf(r) }))
    })

    expect(out.length).toBeGreaterThan(0)
    expect(out.every((r: any) => r.rate > 0)).toBe(true)
    expect(out.reduce((a: number, r: any) => a + r.share, 0)).toBeCloseTo(1, 6)
  })

  test('are not driven when nothing is called', async ({ town, page }) => {
    await town.open()
    const rates = await page.evaluate(() => {
      const c = (window as any).city
      const s = structuredClone(c.seen.last)
      const v = s.vendors.find((x: any) => x.node.id === 'ext.mailer')
      v.node.requestsPerSecond = 0
      v.node.inbound = null
      c.feed(s)
      return c.town.cars.routeList.filter((r: any) => r.vendor && r.dest.id === 'ext.mailer').map((r: any) => c.town.cars.rateOf(r))
    })
    expect(rates.every((r: number) => r === 0)).toBe(true)
  })
})

test.describe('cars from a third party island to the town through the airport', () => {
  const callsTheApi = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const c = (window as any).city
    const s = structuredClone(c.seen.last)
    s.vendors.find((x: any) => x.node.id === 'ext.mailer').calls = ['aa.orders-api']
    const api = s.groups.flatMap((g: any) => g.nodes).find((x: any) => x.id === 'aa.orders-api')
    api.requestsPerSecond = 10
    api.outsideRequestsPerSecond = 2
    api.inbound = [{ from: 'ext.mailer', requestsPerSecond: 8 }]
    api.inboundEstimated = false
    c.feed(s)
    const routes = c.town.cars.routeList.filter((r: any) => r.source.node?.id === 'ext.mailer' && r.dest.node?.id === 'aa.orders-api')
    const airport = c.town.airport
    const xs = routes.flatMap((r: any) => r.path.map((p: any) => p.x))
    return {
      routes: routes.length,
      rate: routes.map((r: any) => c.town.cars.rateOf(r)),
      backGate: airport.backGateZ !== null,
      // the road passes the airport's back gate: some point of the path is within a few metres of it
      throughAirport: routes.every((r: any) => r.path.some((p: any) => p.distanceTo(airport.backGate()) < 3) && r.path.some((p: any) => p.distanceTo(airport.gate()) < 3)),
      roads: c.town.inspectRoads(),
      sane: xs.every((x: number) => Number.isFinite(x)),
    }
  })

  test('start on the island, pass the airport\'s back gate and its front gate, and are driven at the measured rate', async ({ town, page }) => {
    await town.open()
    const out = await callsTheApi(page)
    expect(out.backGate).toBe(true)
    expect(out.routes).toBe(1)
    expect(out.rate[0]).toBeGreaterThan(0)
    expect(out.throughAirport).toBe(true)
    expect(out.sane).toBe(true)
  })

  test('the airport has a back gate as soon as a vendor island is the company\'s own, before any call is seen', async ({ town, page }) => {
    await town.open()
    const out = await page.evaluate(() => {
      const c = (window as any).city
      const s = structuredClone(c.seen.last)
      s.vendors.find((x: any) => x.node.id === 'ext.mailer').internal = true
      c.feed(s)
      const a = c.town.airport
      return { back: a.backGateZ !== null, roads: c.town.inspectRoads() }
    })
    expect(out.back).toBe(true)
  })

  test('the airport has no back gate when no vendor island is the company\'s own and none calls the town', async ({ town, page }) => {
    await town.open()
    expect(await page.evaluate(() => (window as any).city.town.airport.backGateZ)).toBeNull()
  })
})

test.describe('the Unknown hosts button', () => {
  const hosts = [
    { host: 'api.partner.example', calls: 1200, callers: ['aa.orders-api'], days: 3 },
    { host: 'files.example.test', calls: 40, callers: ['bb.ledger-worker', 'aa.orders-worker'], days: 2 },
  ]

  test('is hidden when there are none, lists each host with its copy buttons when there are, and copies a line', async ({ town, page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await town.open()
    await expect(page.locator('#unknown-hosts')).toBeHidden()

    await page.route('**/api/unknown-hosts*', (r) => r.fulfill({ json: hosts }))
    await page.evaluate(() => (window as any).city.unknownHosts.refresh())
    await expect(page.locator('#unknown-hosts-toggle')).toHaveText(/2 unknown hosts/)
    await page.locator('#unknown-hosts-toggle').click()
    await expect(page.locator('#unknown-hosts li')).toHaveCount(2)
    await expect(page.locator('#unknown-hosts li').first()).toContainText('api.partner.example')

    await page.locator('#unknown-hosts li').first().getByRole('button', { name: 'Copy vendor entry' }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('- { id: ext.api-partner-example, name: api.partner.example, domains: [api.partner.example], calledBy: [aa.orders-api] }')
    await page.locator('#unknown-hosts li').nth(1).getByRole('button', { name: 'Copy ignore line' }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("- '^files\\.example\\.test$'")

    await page.route('**/api/unknown-hosts*', (r) => r.fulfill({ json: [] }))
    await page.evaluate(() => (window as any).city.unknownHosts.refresh())
    await expect(page.locator('#unknown-hosts')).toBeHidden()
  })
})
