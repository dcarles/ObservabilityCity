import { test, expect, type Page } from '@playwright/test'
import { API, type Status } from '../support/city'

// A live town whose functions know whether their app runs and how each scheduled job is doing, and whose API runs in two regions. The same checks run on
// two towns that write everything differently (function-town-a: names, a state called Running, regions in the names; function-town-b: tags, a state
// called Started, regions in a tag). The town shows the same thing in both, which is the proof that the rules, not the program, know the conventions.

const B = process.env.E2E_SUITE === 'functionsb'
const town = B
  ? { hot: 'Amsterdam', calm: 'Dublin', regions: ['Amsterdam', 'Dublin'] }
  : { hot: 'West', calm: 'North', regions: ['North', 'West'] }

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
    await expect(page.locator('#inspector .row', { hasText: 'App' })).toContainText('not found in the inventory')
    await expect(page.locator('#inspector .why')).toContainText('not found in the inventory')
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

    await page.locator('#inspector .regions button', { hasText: 'All' }).click()
    let api = await inspect(page, 'aa.orders-api')
    expect(api.region).toBe('all 2 regions')
    expect(api.floors).toBe(3) // 2 + 1 instances, floors on a doubling scale
    expect(await page.evaluate(() => (window as any).city.seen.snapshots)).toBeLessThanOrEqual(before + 2) // nothing was asked of the server

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
})
