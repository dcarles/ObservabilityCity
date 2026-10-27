import { test, expect } from '../support/test'
import { API } from '../support/city'

// The server's own config folder holds two sample towns: Galactic Credit (16 pillars on a hub, Service Bus) and Droid Shop (six teams, Kafka,
// direct calls between teams, three vendors). These tests run against both together.

const SHOP = 'droid-shop'

test.describe('the server runs two towns', () => {
  test('lists them with Galactic Credit first, and the default marked', async ({ request }) => {
    const towns = (await (await request.get(`${API}/api/towns`)).json()) as { id: string; name: string; isDefault: boolean }[]

    expect(towns.map((t) => t.id)).toEqual(['droid-shop', 'galactic-credit'].sort((a) => (a === 'galactic-credit' ? -1 : 1)))
    expect(towns[0]).toEqual({ id: 'galactic-credit', name: 'Galactic Credit', isDefault: true })
    expect(towns[1]).toEqual({ id: 'droid-shop', name: 'Droid Shop', isDefault: false })
  })

  test('each answers for itself', async ({ request }) => {
    const get = async (q: string) => (await (await request.get(`${API}/api/snapshot/latest${q}`)).json()) as { townId: string; topology: string; groups: { id: string }[] }
    await expect.poll(async () => (await request.get(`${API}/api/snapshot/latest?town=${SHOP}`)).status(), { timeout: 30_000 }).toBe(200)

    const credit = await get('')
    const shop = await get(`?town=${SHOP}`)

    expect(credit).toMatchObject({ townId: 'galactic-credit', topology: 'hub-and-spoke' })
    expect(shop).toMatchObject({ townId: SHOP, topology: 'direct' })
    expect(shop.groups.map((g) => g.id)).toEqual(['hub', 'web', 'mob', 'chk', 'inv', 'shp', 'ntf'])
  })

  test('a town the server does not have is not found, and the page says so instead of showing another', async ({ town, page, request }) => {
    expect((await request.get(`${API}/api/snapshot/latest?town=nope`)).status()).toBe(404)
    await town.reset()
    await page.goto('/?test=1&quality=low&town=nope')
    await expect(page.locator('#banner')).toContainText('There is no town "nope"')
    await expect(page.locator('#banner')).toContainText('droid-shop')
    expect(await page.evaluate(() => (window as any).city.seen.snapshots)).toBe(0)
  })

  test('steering one town leaves the other alone', async ({ town, request }) => {
    town.townId = SHOP
    await town.reset()
    await town.effect('web.storefront-api', 'Down')
    await expect.poll(async () => {
      const s = (await (await request.get(`${API}/api/snapshot/latest?town=${SHOP}`)).json()) as { totals: { down: number } }
      return s.totals.down
    }, { timeout: 20_000 }).toBe(1)

    const credit = (await (await request.get(`${API}/api/snapshot/latest`)).json()) as { totals: { down: number } }
    expect(credit.totals.down).toBe(0)
  })
})

test.describe('Droid Shop', () => {
  test.beforeEach(({ town }) => { town.townId = SHOP })

  test('has six teams round the platform', async ({ town, page }) => {
    await town.open()
    const islands = await page.evaluate(() => (window as any).city.islandChoices().map((i: any) => `${i.id}:${i.name}`))
    expect([...islands].sort()).toEqual(['chk:Checkout', 'inv:Inventory', 'mob:Mobile', 'ntf:Notifications', 'shp:Shipping', 'web:Web'])
    await expect(page.locator('#town-name')).toHaveText('Droid Shop')
    expect(await page.evaluate(() => (window as any).city.seen.last.topology)).toBe('direct')
    expect(await page.evaluate(() => (window as any).city.seen.last.groupLabel)).toBe('Team')
  })

  test('has Kafka at the platform, and the port reads KAFKA on its sign and its billboard', async ({ town, page }) => {
    await town.open()
    const hub = await town.hub()
    expect(hub.sign).toMatchObject({ board: 'KAFKA', model: 'KAFKA' })
    expect(hub.sign.counts).toBe('3 topics · 6 subscriptions · 5 piers')
    expect(hub).toMatchObject({ topics: 3, subscriptions: 6, piers: 5 })
    const kafka = await town.inspect('hub.kafka')
    expect(kafka.kind).toBe('Broker')
    expect(await page.evaluate(() => (window as any).city.seen.last.groups[0].nodes.find((n: any) => n.kind === 'Broker').name)).toBe('Kafka')
  })

  test('the teams reach each other over the ring road: only the two that call the shared accounts DB have a spoke to the platform', async ({ town, page }) => {
    await town.open()
    const r = await page.evaluate(() => (window as any).city.town.inspectRoads())

    expect(r).toMatchObject({ direct: true, ringRoad: true, airport: 'ring', routesThroughHub: 0 })
    expect([...r.ringBridges].sort()).toEqual(['chk', 'inv', 'mob', 'ntf', 'shp', 'web'])
    expect([...r.hubBridges].sort()).toEqual(['mob', 'web'])
    expect(r.routes).toBeGreaterThan(0)
  })

  test('has no gateway on the platform, and outside callers arrive at the airport', async ({ town, page }) => {
    await town.open()
    const kinds = await page.evaluate(() => (window as any).city.seen.last.groups.find((g: any) => g.isHub).nodes.map((n: any) => n.kind))
    const externalFrom = await page.evaluate(() => {
      const t = (window as any).city.town
      return t.cars.routeList.filter((r: any) => r.origin === 'external').map((r: any) => (r.source === t.airport ? 'airport' : 'other'))
    })

    expect(kinds).not.toContain('Gateway')
    expect(externalFrom.length).toBeGreaterThan(0)
    expect(new Set(externalFrom)).toEqual(new Set(['airport']))
  })

  test('the team with no messaging has no pier, and the others do', async ({ town }) => {
    await town.open()
    expect((await town.island('mob')).pier).toBe(false)
    for (const id of ['web', 'chk', 'inv', 'shp', 'ntf']) expect((await town.island(id)).pier, id).toBe(true)
  })

  test('has a payment gateway, a courier and a push service as vendors', async ({ town, page }) => {
    await town.open()
    const vendors = await page.evaluate(() => (window as any).inspectVendorsIds?.() ?? (window as any).city.inspectVendors().map((v: any) => v.id))
    expect(vendors.sort()).toEqual(['ext.courier', 'ext.payment-gateway', 'ext.push'])
  })

  test('a failing vendor shows on its stand in the town', async ({ town, page }) => {
    await town.open()
    await town.effect('ext.payment-gateway', 'Down')
    await page.waitForFunction(() => (window as any).city.seen.last.vendors.find((v: any) => v.node.id === 'ext.payment-gateway')?.node.state === 'Down', null, { timeout: 30_000 })
  })

  test('ships the flash sale story', async ({ request }) => {
    const stories = (await (await request.get(`${API}/api/fake/stories?town=${SHOP}`)).json()) as { id: string; name: string }[]
    expect(stories.map((s) => s.id)).toEqual(['flash-sale'])
    expect(stories[0].name).toBe('The flash sale')
  })

  test('the flash sale puts checkout under a storm and sends the gateway into errors', async ({ town, request, page }) => {
    await town.open()
    const q = `?town=${SHOP}`
    expect((await request.post(`${API}/api/fake/story/play${q}`, { data: { id: 'flash-sale' } })).ok()).toBe(true)
    expect((await request.post(`${API}/api/fake/story/seek${q}`, { data: { seconds: 55 } })).ok()).toBe(true)
    await page.waitForFunction(() => (window as any).city.seen.last.totals.incidents >= 1, null, { timeout: 30_000 })
    const incidents = await page.evaluate(() => (window as any).city.seen.last.groups.find((g: any) => g.id === 'chk').incidents.length)
    expect(incidents).toBe(1)
    await page.waitForFunction(() => (window as any).city.seen.last.vendors.find((v: any) => v.node.id === 'ext.payment-gateway')?.node.errorRate > 0.2, null, { timeout: 30_000 })
    await request.post(`${API}/api/fake/story/stop${q}`)
  })

  test('opens on a wall for one team, with its own islands only', async ({ town, page }) => {
    await town.open('&wall=1&hold=2&islands=chk,shp')
    await page.waitForFunction(() => (window as any).city.seen.last.view.islands.join() === 'chk,shp')
    await expect(page.locator('#wall-town')).toHaveText('Droid Shop')
    await expect(page.locator('#wall-headline')).toHaveText('ALL SYSTEMS HEALTHY')
    const keys: string[] = []
    for (let i = 0; i < 8; i++) {
      await town.step(2.05)
      keys.push(await page.evaluate(() => (window as any).city.wall().stop.key))
    }
    expect(keys.filter((k) => k.startsWith('island:')).every((k) => k === 'island:chk' || k === 'island:shp')).toBe(true)
    expect(keys).toContain('island:chk')

    await town.effect('shp.shipments-worker', 'Down')
    await page.waitForFunction(() => (window as any).city.wall().stop?.kind === 'down')
    await expect(page.locator('#wall-headline')).toHaveText('1 DOWN')
    await expect(page.locator('#wall-caption')).toContainText('Shipments worker (Shipping) is down')
  })
})

test.describe('Galactic Credit keeps its hub and spokes', () => {
  test('every island with an API has a spoke, the airport is on a spoke, and outside callers cross the hub', async ({ town, page }) => {
    await town.open()
    const r = await page.evaluate(() => (window as any).city.town.inspectRoads())

    expect(r).toMatchObject({ direct: false, airport: 'hub' })
    expect(r.hubBridges.length).toBeGreaterThanOrEqual(10)
    expect(r.routesThroughHub).toBeGreaterThan(0)
  })
})

test.describe('the town switcher', () => {
  test('is in the top bar when the server has more than one town, and names the one in use', async ({ town, page }) => {
    town.townId = SHOP
    await town.open()
    await expect(page.locator('#town-button')).toContainText('Droid Shop')
    await page.locator('#town-button').click()
    await expect(page.locator('#town-list [data-act="town"]')).toHaveCount(2)
    await expect(page.locator('#town-list .sel')).toContainText('Droid Shop')
    await expect(page.locator('#town-list')).toContainText('Galactic Credit')
    await expect(page.locator('#town-list')).toContainText('default')
  })

  test('switching to the other town loads it, drops the islands and the environment, and keeps the rest of the address', async ({ town, page }) => {
    town.townId = SHOP
    await town.open('&islands=chk&hide=traffic')
    await page.waitForFunction(() => (window as any).city.seen.last.view.islands.join() === 'chk')
    await page.locator('#town-button').click()
    await page.locator('#town-list [data-id="galactic-credit"]').click()

    await page.waitForFunction(() => (window as any).city?.seen.last?.townId === 'galactic-credit', null, { timeout: 55_000 })
    const url = new URL(page.url())
    expect(url.searchParams.has('town')).toBe(false)
    expect(url.searchParams.has('islands')).toBe(false)
    expect(url.searchParams.get('hide')).toBe('traffic')
    expect(url.searchParams.get('test')).toBe('1')
    await expect(page.locator('#town-button')).toContainText('Galactic Credit')
  })

  test('switching from the default town sets ?town= for the other', async ({ town, page }) => {
    // the first town of the server is Galactic Credit; go to Droid Shop from there
    await town.reset()
    await page.goto('/?test=1&quality=low&town=galactic-credit')
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0, null, { timeout: 55_000 })
    await page.locator('#town-button').click()
    await page.locator('#town-list [data-id="droid-shop"]').click()

    await page.waitForFunction(() => (window as any).city?.seen.last?.townId === 'droid-shop', null, { timeout: 55_000 })
    expect(new URL(page.url()).searchParams.get('town')).toBe('droid-shop')
  })
})
