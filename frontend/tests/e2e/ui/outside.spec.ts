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
    expect(out.airport.board[1]).toBe('INTERNAL') // the declared callers are only names: the board shows the totals alone, outside then internal
    expect(out.airport.board).toHaveLength(3)
  })

  test('the airport board says how much traffic is internal, the town total less the outside part, and the dashboard says the same', async ({ town, page }) => {
    await town.open()

    const board = await page.evaluate(() => {
      const c = (window as any).city
      const s = structuredClone(c.seen.last)
      for (const n of s.groups.flatMap((g: any) => g.nodes)) n.absent = (n.absent ?? []).filter((x: string) => x !== 'requests')
      s.totals.requestsPerSecond = 50
      s.outsideRequestsPerSecond = 12
      c.feed(s)
      return c.inspectAirport().board
    })

    expect(board).toEqual(['ARRIVALS  12 req/s', 'INTERNAL', 'TRAFFIC  38 req/s'])
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

  test('the airport has no back gate when no building of a third party island calls the town', async ({ town, page }) => {
    await town.open()
    expect(await page.evaluate(() => (window as any).city.town.airport.backGateZ)).toBeNull()
  })
})

test.describe('the Unknown hosts button', () => {
  const hosts = [
    { host: 'api.partner.example', calls: 1200, callers: ['aa.orders-api'], days: 3 },
    { host: 'files.example.test', calls: 40, callers: ['bb.ledger-worker', 'aa.orders-worker'], days: 2 },
  ]

  test('is hidden when there is nothing, adds a host with one click and takes it off the list, and a Remove undoes it', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#unknown-hosts')).toBeHidden()

    // a server that keeps the two lists, as the real one does: adding saves, loads the town again, and the host leaves the unknown list
    let unknown = [...hosts]
    let added: { id: string; name: string; host: string; kind: string; calledBy: string[] }[] = []
    const posted: any[] = []
    await page.route('**/api/unknown-hosts*', (r) => r.fulfill({ json: unknown }))
    await page.route('**/api/added-hosts*', async (r) => {
      const req = r.request()
      if (req.method() === 'POST') {
        const body = req.postDataJSON()
        posted.push(body)
        const host = unknown.find((h) => h.host === body.host)!
        added = [...added, { id: `ext.${body.host}`, name: body.host === 'api.partner.example' ? 'Partner API' : body.host, host: body.host, kind: body.kind, calledBy: host.callers }]
        unknown = unknown.filter((h) => h.host !== body.host)
      } else if (req.method() === 'DELETE') {
        added = added.filter((a) => a.id !== new URL(req.url()).searchParams.get('id'))
      }
      await r.fulfill({ json: added })
    })
    await page.evaluate(() => (window as any).city.unknownHosts.refresh())
    await expect(page.locator('#unknown-hosts-toggle')).toHaveText(/2 unknown hosts/)
    await page.locator('#unknown-hosts-toggle').click()
    await expect(page.locator('#unknown-hosts-list > li')).toHaveCount(2)
    await expect(page.locator('#unknown-hosts-list > li').first()).toContainText('api.partner.example')
    await expect(page.getByRole('button', { name: 'Copy vendor entry' })).toHaveCount(0)

    await page.locator('#unknown-hosts-list > li').first().getByRole('button', { name: 'Add vendor' }).click()
    await expect(page.locator('#unknown-hosts-toggle')).toHaveText(/1 unknown host · 1 added/)
    expect(posted).toEqual([{ host: 'api.partner.example', kind: 'vendor' }])
    await expect(page.locator('#added-hosts-list > li')).toHaveCount(1)
    await expect(page.locator('#added-hosts-list > li')).toContainText('Partner API')

    await page.locator('#unknown-hosts-list > li').first().getByRole('button', { name: 'Ignore' }).click()
    await expect(page.locator('#unknown-hosts-toggle')).toHaveText(/0 unknown hosts · 2 added/)
    await expect(page.locator('#unknown-hosts')).toBeVisible() // nothing unknown any more, but the added list is still there to undo from
    await expect(page.locator('#unknown-hosts-list > li')).toHaveCount(0)

    await page.locator('#added-hosts-list > li').first().getByRole('button', { name: 'Remove' }).click()
    await expect(page.locator('#added-hosts-list > li')).toHaveCount(1)
    await page.locator('#added-hosts-list > li').first().getByRole('button', { name: 'Remove' }).click()
    await expect(page.locator('#unknown-hosts')).toBeHidden()
  })

  test('shows why the server refused an add, and leaves the lists as they were', async ({ town, page }) => {
    await town.open()
    await page.route('**/api/unknown-hosts*', (r) => r.fulfill({ json: hosts }))
    await page.route('**/api/added-hosts*', (r) => r.request().method() === 'POST'
      ? r.fulfill({ status: 400, json: { error: 'No system of the town was seen calling api.partner.example.' } })
      : r.fulfill({ json: [] }))
    await page.evaluate(() => (window as any).city.unknownHosts.refresh())
    await page.locator('#unknown-hosts-toggle').click()

    await page.locator('#unknown-hosts-list > li').first().getByRole('button', { name: 'Add internal' }).click()

    await expect(page.locator('#unknown-hosts-error')).toContainText('No system of the town was seen calling')
    await expect(page.locator('#unknown-hosts-list > li')).toHaveCount(2)
  })

  test('lists a gateway by its unexplained paths, adds a rule for one once a system is picked, and shows calls made only by vendors behind the tick box', async ({ town, page }) => {
    await town.open()
    const list = [
      { host: 'gw.example.test', calls: 440, callers: ['aa.orders-api', 'ext.partner-svc'], days: 3, gateway: true, vendorsOnly: false, morePaths: 0,
        paths: [{ path: '/internal/x', calls: 400, vendorsOnly: false }, { path: '/odd/y', calls: 40, vendorsOnly: true }] },
      { host: 'theirs.example.test', calls: 500, callers: ['ext.partner-svc'], days: 2, vendorsOnly: true },
    ]
    const posted: any[] = []
    let added: any[] = []
    await page.route('**/api/unknown-hosts*', (r) => r.fulfill({ json: list }))
    await page.route('**/api/added-hosts*', (r) => r.fulfill({ json: added }))
    await page.route('**/api/added-rules*', (r) => {
      posted.push(r.request().postDataJSON())
      added = [{ id: 'rule:x', name: 'aa.orders-api', host: '^/internal/x(/|$)', kind: 'rule', calledBy: [] }]
      return r.fulfill({ json: added })
    })
    await page.evaluate(() => (window as any).city.unknownHosts.refresh())
    await expect(page.locator('#unknown-hosts-toggle')).toHaveText(/1 unknown host /)
    await page.locator('#unknown-hosts-toggle').click()
    const gw = page.locator('#unknown-hosts li[data-host="gw.example.test"]')
    await expect(gw.getByRole('button', { name: 'Add vendor' })).toHaveCount(0)
    await expect(gw.getByRole('button', { name: 'Ignore' })).toHaveCount(0)
    await expect(gw.locator('li')).toHaveCount(1)

    // no system picked yet: it says so and sends nothing
    await gw.getByRole('button', { name: 'Add rule' }).click()
    await expect(page.locator('#unknown-hosts-error')).toContainText('Pick the system')
    expect(posted).toEqual([])

    // the systems on offer are the town's APIs; pick one and add
    const options = await page.locator('#unknown-hosts select[data-target] option').allTextContents()
    expect(options.length).toBeGreaterThan(1)
    const target = options[1]
    await page.locator('#unknown-hosts li[data-host="gw.example.test"] select[data-target]').selectOption(target)
    await page.locator('#unknown-hosts li[data-host="gw.example.test"]').getByRole('button', { name: 'Add rule' }).click()
    await expect(page.locator('#added-hosts-list > li')).toContainText('rule')
    // by default a rule keeps two parts of the path and goes through the gateway, as rules always did
    expect(posted).toEqual([{ host: 'gw.example.test', path: '/internal/x', target, depth: 2, gateway: true }])

    // the panel can keep one part and say the calls do not go through the gateway
    await page.locator('#unknown-hosts li[data-host="gw.example.test"] select[data-depth]').selectOption('1')
    await page.locator('#unknown-hosts li[data-host="gw.example.test"] input[data-gateway]').uncheck()
    await page.locator('#unknown-hosts li[data-host="gw.example.test"] select[data-target]').selectOption(target)
    await page.locator('#unknown-hosts li[data-host="gw.example.test"]').getByRole('button', { name: 'Add rule' }).click()
    await expect.poll(() => posted.length).toBe(2)
    expect(posted[1]).toEqual({ host: 'gw.example.test', path: '/internal/x', target, depth: 1, gateway: false })

    await page.locator('#unknown-hosts-vendors').check()
    await expect(page.locator('#unknown-hosts-toggle')).toHaveText(/2 unknown hosts/)
    await expect(gw.locator('li')).toHaveCount(2)
    await expect(page.locator('#unknown-hosts li[data-host="theirs.example.test"]')).toBeVisible()
  })
})

test.describe('the airport and the islands on the pointer', () => {
  /** A screen point over bare ground of an island (nothing to click or hover there), found by trying points of its ground from the camera. */
  const bareGround = (page: import('@playwright/test').Page, kind: 'airport' | 'island', id: string) => page.evaluate(([k, wanted]) => {
    const c = (window as any).city
    const T = c.THREE
    const root = k === 'airport' ? c.town.airport.root : (c.town.islands.find((i: any) => i.group.id === wanted) ?? c.town.vendors.get(wanted)).root
    const outline = k === 'airport' ? c.town.airport.outline : (c.town.islands.find((i: any) => i.group.id === wanted) ?? c.town.vendors.get(wanted)).outline
    root.updateWorldMatrix(true, false)
    const ray = new T.Raycaster()
    const lists = () => [c.town.hitMeshes(), c.town.serviceHits(), c.town.assetHits(), c.town.harbourHits()]
    for (let x = -40; x <= 40; x += 2) for (let z = -28; z <= 28; z += 2) {
      if (!outline.contains(x, z, 3)) continue
      const p = root.localToWorld(new T.Vector3(x, -0.55, z)).project(c.stage.camera)
      if (Math.abs(p.x) > 0.9 || Math.abs(p.y) > 0.9) continue
      ray.setFromCamera(new T.Vector2(p.x, p.y), c.stage.camera)
      if (lists().some((l: any) => ray.intersectObjects(l, false).length > 0)) continue
      return { x: (p.x + 1) / 2 * window.innerWidth, y: (1 - p.y) / 2 * window.innerHeight }
    }
    return null
  }, [kind, id] as const)

  test('hovering the airport gives its arrivals and the traffic inside the town, the numbers on its board', async ({ town, page }) => {
    await town.open()
    const got = await page.evaluate(() => {
      const c = (window as any).city
      const at = c.town.airport.root.getWorldPosition(new c.THREE.Vector3())
      return { hover: c.town.airportAt(at.x, at.z), sea: c.town.airportAt(at.x + 400, at.z + 400), board: c.town.inspectAirport().board }
    })
    expect(got.sea).toBeNull()
    expect(got.hover.name).toBe('Airport')
    expect(got.hover.lines[0]).toMatch(/^Arrivals .+ req\/s$/)
    expect(got.board[0]).toMatch(/^ARRIVALS {2}.+ req\/s$/)
  })

  test('clicking the airport glides the camera to the whole airport', async ({ town, page }) => {
    await town.open()
    const at = await bareGround(page, 'airport', 'airport')
    expect(at).not.toBeNull()
    await page.mouse.click(at!.x, at!.y)
    await town.step(3)
    const d = await page.evaluate(() => {
      const c = (window as any).city
      const want = c.town.islandFocusOf('airport')
      return { off: c.stage.controls.target.distanceTo(want.target), dist: c.stage.camera.position.distanceTo(c.stage.controls.target), want: want.distance }
    })
    expect(d.off).toBeLessThan(1)
    expect(d.dist).toBeLessThan(d.want * 1.15)
  })

  test('clicking a pillar\'s island glides to the whole island, but the hub island stays where it is', async ({ town, page }) => {
    await town.open()
    const at = await bareGround(page, 'island', 'cc')
    expect(at).not.toBeNull()
    await page.mouse.click(at!.x, at!.y)
    await town.step(3)
    const off = await page.evaluate(() => { const c = (window as any).city; return c.stage.controls.target.distanceTo(c.town.islandFocusOf('cc').target) })
    expect(off).toBeLessThan(1)
    // nothing happens over the hub's ground
    const before = await page.evaluate(() => (window as any).city.stage.controls.target.toArray())
    expect(await page.evaluate(() => { const c = (window as any).city; return c.town.islandAt(0, 0) })).toBeNull()
    expect(before).toHaveLength(3)
  })

  test('says what the town sends a third party under its name and on its hover, summed over its services', async ({ town, page }) => {
    await town.open()
    const got = await page.evaluate(() => {
      const c = (window as any).city
      const s = structuredClone(c.seen.last)
      for (const v of s.vendors) { v.node.requestsPerSecond = 0; v.node.absent = (v.node.absent ?? []).filter((a: string) => a !== 'requests') }
      const v = s.vendors.find((x: any) => x.node.id === 'ext.mailer')
      v.node.requestsPerSecond = 8
      c.feed(s)
      const island = c.town.vendors.get('ext.mailer')
      const same = s.vendors.filter((x: any) => (x.islandId ?? x.node.id) === island.id).reduce((a: number, x: any) => a + x.node.requestsPerSecond, 0)
      return { line: island.nameSign.userData.line(), summary: c.town.signSummary(island.id), picked: island.nameSign.children.every((p: any) => p.userData.signIsland === island.id), same, others: c.town.inspectVendorSigns().filter((x: any) => x.id !== island.id).map((x: any) => x.line) }
    })
    expect(got.picked).toBe(true)
    expect(got.line).toBe(`in ${got.summary.lines[0].split(' ')[2]} rps`)
    expect(got.summary.lines).toHaveLength(1)
    expect(got.summary.lines[0]).toMatch(/^Requests in .+ rps$/)
    expect(got.same).toBeGreaterThanOrEqual(8)
    // a third party nothing is sent to says nothing
    for (const l of got.others) expect(l).toBe('')
  })
})
