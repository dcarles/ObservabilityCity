import { test, expect, type Page } from '@playwright/test'

// A live town whose environment reads the cloud's own health reports (a recording stands in for the activity log). The same checks run on two towns that write
// everything differently (health-town-a: names, the source called "health"; health-town-b: tags, the source called "azure-health", another look-back). The town
// shows the same thing in both, which is the proof that the environment, not the program, knows the providers and the names.
// Recorded: the ledger store is Unavailable, the orders store Degraded, one more resource nobody owns is Degraded, and another report on the orders store was resolved.

const B = process.env.E2E_SUITE === 'healthb'

test.describe.configure({ mode: 'serial' })

async function open(page: Page, query = ''): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`/?test=1&quality=low${query}`)
  await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
  await page.waitForFunction(() => ((window as any).city.seen.last.healthEvents ?? []).length > 0, undefined, { timeout: 30_000 })
}

const incidents = (page: Page) => page.locator('#topbar [data-list="Incidents"]')
const listed = (page: Page) => page.locator('#state-list .hit')

test.describe(`the cloud's own health reports (${B ? 'tags, azure-health' : 'names, health'})`, () => {
  test('the server lists the open reports worst first and the resolved one last, each tied to the building that owns the resource', async ({ page }) => {
    await open(page)

    const events = await page.evaluate(() => (window as any).city.seen.last.healthEvents.map((e: any) => ({ state: e.state, node: e.nodeId, group: e.groupId, resolvedAt: e.resolvedAt })))

    expect(events.map((e: any) => e.state)).toEqual(['Unavailable', 'Degraded', 'Degraded', 'Resolved'])
    expect(events.map((e: any) => e.node)).toEqual(['bb.ledger-db', 'aa.orders-db', null, 'aa.orders-db'])
    expect(events[3].resolvedAt).not.toBeNull()
  })

  test('a building with an open report shows the red exclamation mark, and a resolved report marks nothing', async ({ page }) => {
    await open(page)

    const status = (id: string) => page.evaluate((i) => (window as any).city.inspect(i)?.cloudHealth ?? null, id)

    expect(await status('bb.ledger-db')).toBe('Unavailable')
    expect(await status('aa.orders-db')).toBe('Degraded') // its open report, not the resolved one
    expect(await status('aa.orders-worker')).toBeNull()
  })

  test('the top bar counts the open reports as incidents, and not the resolved one', async ({ page }) => {
    await open(page)

    await expect(incidents(page).locator('b')).toHaveText('3')
  })

  test('the Incidents list shows open reports in the colour of trouble and the resolved one in green, and a click goes to the building', async ({ page }) => {
    await open(page)
    await incidents(page).click()

    await expect(page.locator('#state-list .head b')).toHaveText('3 with open incidents · 1 resolved')
    await expect(listed(page)).toHaveCount(4)
    await expect(page.locator('#state-list .hit.resolved')).toHaveCount(1)
    await expect(page.locator('#state-list .hit.resolved .detail')).toContainText('Resolved')

    await listed(page).filter({ hasText: 'Unavailable since' }).click()
    await expect(page.locator('#inspector')).toBeVisible()
    await expect(page.locator('#inspector .cloud-health')).toHaveAttribute('data-cloud-health', 'Unavailable')
    await expect(page.locator('#inspector .cloud-health')).toContainText('UserInitiated')
  })

  test('the Incidents list shows every entry in full: stacked lines, no sideways scroll and no inner scroll', async ({ page }) => {
    await open(page)
    await incidents(page).click()

    const panel = page.locator('#state-list')
    await expect(listed(page)).toHaveCount(4)
    const fit = await panel.evaluate((el) => ({ across: el.scrollWidth <= el.clientWidth, down: el.scrollHeight <= el.clientHeight }))
    expect(fit).toEqual({ across: true, down: true })
    const first = listed(page).first()
    const name = await first.locator('b').boundingBox()
    const where = await first.locator('span').first().boundingBox()
    expect(where!.y).toBeGreaterThan(name!.y + name!.height - 2) // the lines stack: the island line is under the name
    await expect(first.locator('.dismiss')).toBeVisible()
  })

  test('a report no building owns is listed and goes nowhere', async ({ page }) => {
    await open(page)
    await incidents(page).click()

    const stray = page.locator('#state-list .hit.inert')
    await expect(stray).toHaveCount(1)
    await expect(stray).toContainText('not in the town')
    await stray.locator('b').click()
    await expect(page.locator('#state-list')).toBeVisible() // still open: nothing was picked
    await expect(page.locator('#inspector')).toBeHidden()
  })

  test('the drawer of a building whose report resolved says it is resolved, in green; one with an open report says so in the colour of trouble', async ({ page }) => {
    await open(page)

    await page.locator('#search-input').fill('orders')
    await page.locator('#search-results .hit', { hasText: 'Orders DB' }).first().click()
    await expect(page.locator('#inspector .cloud-health')).toHaveAttribute('data-cloud-health', 'Degraded')

    // the next snapshot holds only the resolved report. The page stops taking the live feed's own snapshots first: one with the open report arriving between
    // the feed and the checks below put the open report back (the drawer said Degraded and the building had its mark again), which made this test fail now and then
    await page.evaluate(() => { const c = (window as any).city; c.hold(true); c.feed({ ...c.seen.last, healthEvents: c.seen.last.healthEvents.filter((e: any) => e.state === 'Resolved') }) })
    await expect(page.locator('#inspector .cloud-health')).toHaveAttribute('data-cloud-health', 'Resolved')
    await expect(page.locator('#inspector .cloud-health .ok').first()).toHaveText('Resolved')
    expect(await page.evaluate(() => (window as any).city.inspect('aa.orders-db').cloudHealth)).toBeNull() // no mark on the building
  })

  test('the dashboard shows a chip on the service row, red for unavailable and amber for degraded, with the same lines under Details', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto('/?view=dashboard')
    await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)

    // the tables are closed until asked for: open each pillar, then the group its store stands in
    for (const [pillar, group] of [['bb', 'Ledger'], ['aa', 'Orders']]) {
      const toggle = page.locator(`[data-pillar="${pillar}"] [data-toggle]`)
      if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
      const row = page.locator(`[data-pillar="${pillar}"] tr.g`, { hasText: group })
      if ((await row.getAttribute('aria-expanded')) === 'false') await row.click()
    }

    const ledger = page.locator('tr.row[data-system="bb.ledger-db"] .cloud-health')
    await expect(ledger).toContainText('Azure incident', { timeout: 30_000 }) // one plain words, in red, whatever the state; the state is in Details
    await expect(ledger).toHaveClass(/down/)
    const orders = page.locator('tr.row[data-system="aa.orders-db"] .cloud-health')
    await expect(orders).toContainText('Azure incident')
    await expect(orders).toHaveClass(/bad/)
    expect(await orders.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)') // a red label, not faint text

    await page.locator('tr.row[data-system="bb.ledger-db"] .det').click()
    await expect(page.locator('#inspector .cloud-health')).toHaveAttribute('data-cloud-health', 'Unavailable')
  })

  test('the dashboard has an Incidents box in the top row, red while a report is open, and with no list', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto('/?view=dashboard')
    const card = page.locator('#kpi-incidents')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.locator('> b')).toHaveText('3')
    await expect(card).toHaveClass(/bad/)
    await expect(card.locator('.il')).toHaveCount(0)

    const got = await page.locator('#dash-sum .kpi').evaluateAll((els) => ({ tops: els.map((e) => Math.round(e.getBoundingClientRect().top)), heights: els.map((e) => Math.round(e.getBoundingClientRect().height)) }))
    expect(got.tops.length).toBeGreaterThanOrEqual(3)
    expect(new Set(got.tops).size).toBe(1) // all in one row
    expect(new Set(got.heights).size).toBe(1) // all one height
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    // the row of the resource with an open report says so, and its drawer has the details
    const toggle = page.locator('[data-pillar="bb"] [data-toggle]')
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    const group = page.locator('[data-pillar="bb"] tr.g', { hasText: 'Ledger' })
    if ((await group.getAttribute('aria-expanded')) === 'false') await group.click()
    await page.locator('tr.row[data-system="bb.ledger-db"] .det').click()
    await expect(page.locator('#inspector .cloud-health')).toBeVisible()
  })

  test('Dismiss hides a report for everyone: the resolved one first, then an open one with its marker', async ({ page }) => {
    await open(page)
    await incidents(page).click()

    await page.locator('#state-list .hit.resolved .dismiss').click()
    await expect(listed(page)).toHaveCount(3)
    await expect(page.locator('#state-list .head b')).toHaveText('3 with open incidents')

    await listed(page).filter({ hasText: 'Unavailable since' }).locator('.dismiss').click()
    await expect(listed(page)).toHaveCount(2)
    await expect(incidents(page).locator('b')).toHaveText('2')
    await expect.poll(() => page.evaluate(() => (window as any).city.inspect('bb.ledger-db')?.cloudHealth ?? null)).toBeNull()

    await page.reload() // the server remembers, not the page
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    await expect(incidents(page).locator('b')).toHaveText('2')
  })
})
