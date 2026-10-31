import { test, expect, type Page } from '@playwright/test'
import { API, type Status } from '../support/city'

// A live town whose functions know whether their app runs and how each scheduled job is doing, and whose API runs in two regions. The same checks run on
// two towns that write everything differently (function-town-a: names, a state called Running, regions in the names; function-town-b: tags, a state
// called Started, regions in a tag). The town shows the same thing in both, which is the proof that the rules, not the program, know the conventions.

const B = process.env.E2E_SUITE === 'functionsb'
const town = B
  ? { hot: 'Amsterdam', calm: 'Dublin', regions: ['Amsterdam', 'Dublin'], cloud: 'Cumulus', split: '⚠ Amsterdam 25% · Dublin 75%', flagged: 'Dublin',
      assets: [['aa.orders-blobs', 'Blob store', 'store', 'orders', true], ['aa.orders-vault', 'Secret store', 'vault', 'orders', true], ['aa.vault-main', 'Shared secret store', 'vault', null, false]] }
  : { hot: 'West', calm: 'North', regions: ['North', 'West'], cloud: 'Azure', split: '⚠ North 95% · West 5%', flagged: 'North',
      assets: [['aa.appcfg-acme-al', 'App configuration', 'settings', null, false], ['aa.kv-acme-al-ord', 'Key vault', 'vault', 'orders', true], ['aa.kv-acme-al-shared', 'Key vault', 'vault', null, false], ['aa.stacmealord', 'Storage account', 'store', 'orders', true]] }

async function open(page: Page): Promise<void> {
  await page.goto('/?test=1&quality=low')
  await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
  // the inventory and the job logs are read on the first poll, so wait until the town knows its functions
  await page.waitForFunction(
    () => (window as any).city.seen.last.groups.flatMap((g: any) => g.nodes).some((n: any) => n.id === 'aa.sched-fn' && n.app === 'Running' && n.jobs?.length > 0),
    null,
    { timeout: 30_000, polling: 250 },
  )
  await page.evaluate(() => (window as any).city.step(4)) // let the eased lights, floors and beacons settle
}

const inspect = (page: Page, id: string): Promise<Status> => page.evaluate((i) => (window as any).city.inspect(i), id)
const node = (page: Page, id: string) => page.evaluate((i) => (window as any).city.seen.last.groups.flatMap((g: any) => g.nodes).find((n: any) => n.id === i), id)

test.describe(`functions and regions (${B ? 'tags, Started, a region tag' : 'names, Running, regions in the names'})`, () => {
  test('the server sends each function its app state and the state of each job', async ({ request }) => {
    await expect.poll(async () => {
      const s = await (await request.get(`${API}/api/snapshot/latest`)).json()
      return s.groups.flatMap((g: any) => g.nodes).find((n: any) => n.id === 'aa.sched-fn')?.jobs?.length
    }, { timeout: 30_000 }).toBe(3)
    const s = await (await request.get(`${API}/api/snapshot/latest`)).json()
    const by = (id: string) => s.groups.flatMap((g: any) => g.nodes).find((n: any) => n.id === id)
    expect(by('aa.sched-fn').jobs.map((j: any) => [j.name, j.region, j.status])).toEqual([['daily', town.calm, 'Ok'], ['hourly', town.hot, 'Overdue'], ['purge', town.hot, 'Failed']])
    expect(by('aa.sched-fn').state).toBe('Down')
    expect(by('aa.report-fn').state).toBe('Degraded')
    expect(by('aa.idle-fn').app).toBe('Stopped')
    expect(by('aa.ghost-fn').app).toBe('Missing') // declared with the old role name, cron
    expect(by('aa.ghost-fn').kind).toBe('Function')
  })

  test('a stopped app is a half-built building in scaffolding, not one in trouble', async ({ page }) => {
    await open(page)
    const idle = await inspect(page, 'aa.idle-fn')
    expect(idle.underConstruction).toBe(true)
    expect(idle.beacon).toBe('off')
    expect(idle.floors).toBe(1)
    expect(idle.closedSign).toBe(false)
    expect(idle.plaque).toBe('stopped')
    expect(idle.state).toBe('Healthy')
    expect((await inspect(page, 'aa.sched-fn')).underConstruction).toBe(false)
  })

  test('an app the inventory does not have is grey and says it is not found', async ({ page }) => {
    await open(page)
    const ghost = await inspect(page, 'aa.ghost-fn')
    expect(ghost.state).toBe('Stale')
    expect(ghost.beacon).toBe('grey')
    expect(ghost.plaque).toBe('not found')
    await page.evaluate(() => (window as any).city.openSystem('aa.ghost-fn'))
    // the environment names its cloud, and the words follow it: no cloud is built in
    await expect(page.locator('#inspector .row', { hasText: 'App' })).toContainText(`not found in ${town.cloud}`)
    await expect(page.locator('#inspector .why')).toContainText(`not found in ${town.cloud}`)
  })

  test('the drawer lists each job in each region, and a failed one makes the building red', async ({ page }) => {
    await open(page)
    expect((await inspect(page, 'aa.sched-fn')).closedSign).toBe(true) // down
    await page.evaluate(() => (window as any).city.openSystem('aa.sched-fn'))
    const jobs = page.locator('#inspector .job')
    await expect(jobs).toHaveCount(3)
    await expect(page.locator(`#inspector .job[data-job="purge (${town.hot})"] .bad`)).toContainText('failed')
    await expect(page.locator(`#inspector .job[data-job="hourly (${town.hot})"] .warn`)).toContainText('overdue')
    await expect(page.locator(`#inspector .job[data-job="daily (${town.calm})"]`)).toContainText('ok')
    await expect(page.locator('#inspector .why li')).toHaveCount(2)
  })

  test('a late job alone makes the building amber', async ({ page }) => {
    await open(page)
    const report = await inspect(page, 'aa.report-fn')
    expect(report.state).toBe('Degraded')
    expect(report.beacon).toBe('amber')
  })

  test('a service in two regions shows its worst region and says which', async ({ page }) => {
    await open(page)
    const api = await inspect(page, 'aa.orders-api')
    expect(api.region).toBe(`${town.hot} (worst of 2)`)
    expect(api.floors).toBe(1) // one instance in the hot region
    const n = await node(page, 'aa.orders-api')
    expect(n.regions.map((r: any) => r.label)).toEqual(town.regions)
  })

  test('the drawer lists both regions and a switch changes what the building shows, with no new data', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.openSystem('aa.orders-api'))
    await expect(page.locator('#inspector .region')).toHaveCount(2)
    await expect(page.locator('#inspector .regions button.on')).toHaveText('Worst')
    const before = await page.evaluate(() => (window as any).city.seen.snapshots)

    await expect(page.locator('#inspector .regions button')).toHaveText(['Worst', ...town.regions]) // no combined view
    expect(await page.evaluate(() => (window as any).city.seen.snapshots)).toBeLessThanOrEqual(before + 2) // nothing was asked of the server
    let api = await inspect(page, 'aa.orders-api')

    await page.locator('#inspector .regions button', { hasText: town.calm }).click()
    api = await inspect(page, 'aa.orders-api')
    expect(api.region).toBe(town.calm)
    expect(api.floors).toBe(2)

    await page.locator('#inspector .regions button', { hasText: 'Worst' }).click()
    expect((await inspect(page, 'aa.orders-api')).region).toBe(`${town.hot} (worst of 2)`)
  })

  test('a service in one region has no region line and no switch', async ({ page }) => {
    await open(page)
    expect((await inspect(page, 'aa.sched-fn')).region).toBe('')
    await page.evaluate(() => (window as any).city.openSystem('aa.sched-fn'))
    await expect(page.locator('#inspector .regions')).toHaveCount(0)
  })

  test('the sign shows how the requests divide between the regions, with a warning when one takes too much', async ({ page }) => {
    await open(page)
    expect((await inspect(page, 'aa.orders-api')).split).toBe(town.split)
    expect((await inspect(page, 'aa.sched-fn')).split).toBe('') // one region: nothing to divide
    await page.evaluate(() => (window as any).city.openSystem('aa.orders-api'))
    await expect(page.locator('#inspector .region.skewed')).toHaveCount(1)
    await expect(page.locator('#inspector .region.skewed')).toContainText(town.flagged)
    await expect(page.locator('#inspector .region').first()).toContainText('of requests')
    await expect(page.locator('#inspector .region-skew')).toContainText('takes more of the requests')
    // the split does not change with the switch: the sign always says how the traffic divides
    await page.locator('#inspector .regions button', { hasText: town.calm }).click()
    expect((await inspect(page, 'aa.orders-api')).split).toBe(town.split)
  })

  test('no region line or drawer text says instances are unknown', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.openSystem('aa.orders-api'))
    await expect(page.locator('#inspector')).not.toContainText('unknown')
    for (const id of ['aa.orders-api', 'aa.sched-fn', 'aa.report-fn']) expect((await inspect(page, id)).plaque).not.toContain('unknown')
  })

  test('a function gets its run rate from the span metrics like any serving system', async ({ page }) => {
    await open(page)
    const sched = await node(page, 'aa.sched-fn')
    expect(sched.requestsPerSecond).toBeCloseTo(1440 / 300, 3)
    expect(sched.absent).not.toContain('requests')
  })

  test('resources that are not systems stand as small buildings: beside their service, or in the back yard', async ({ page }) => {
    await open(page)
    const assets = await page.evaluate(() => (window as any).city.inspectAssets('aa'))
    expect(assets.map((a: any) => [a.id, a.label, a.shape, a.service, a.behindPad]).sort((x: any, y: any) => (x[0] < y[0] ? -1 : 1))).toEqual(town.assets)
    const services = await page.evaluate(() => (window as any).city.inspectServices('aa'))
    expect(services.length).toBeGreaterThan(0)
    // none is a system: no health, no beacon, nothing among the buildings
    expect(await page.evaluate(() => (window as any).city.inspectIsland('aa').kinds.length)).toBe(5)
    expect(await page.evaluate(() => (window as any).city.town.assetHits().length)).toBe(town.assets.length)
  })

  test('a resource building opens a card with what it is, where it belongs and its address, and no health', async ({ page }) => {
    await open(page)
    const [id, label, , service] = town.assets[1] as [string, string, string, string | null]
    await page.evaluate((i) => (window as any).city.openAsset(i), id)
    const panel = page.locator('#service-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText(label)
    await expect(panel).toContainText(`Resource of the ${service} service`)
    await expect(panel).toContainText('Not monitored')
    await expect(panel.locator('a.out')).toHaveAttribute('href', /^https:\/\/(portal|console)\.example\.test\//)
    await expect(panel).not.toContainText('Healthy')
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    // a pillar-wide resource says it belongs to the pillar
    const [pillarId] = town.assets.find((a) => a[3] === null)!
    await page.evaluate((i) => (window as any).city.openAsset(i), pillarId as string)
    await expect(panel).toContainText('Resource of Alpha')
  })
})
