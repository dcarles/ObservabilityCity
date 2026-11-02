import { test, expect } from '../support/test'
import type { Page } from '@playwright/test'

// The plain dashboard on the tenants town (pillars Alpha and Billing; aa.orders-db and bb.billing-db keep a database for each tenant).
// Everything is read from what the page draws.

const dash = (page: Page) => page.locator('#dash-root')

async function open(town: { reset(): Promise<void> }, page: Page, query = ''): Promise<void> {
  await town.reset()
  await page.goto(`/?view=dashboard${query}`)
  await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)
  await expect(page.locator('#dash-pillars .card').first()).toBeVisible()
}

/** Waits until the page has taken `n` more snapshots. */
/** Opens a group of the table unless it opened by itself. */
async function openGroup(page: Page, pillar: string, name: string): Promise<void> {
  const group = page.locator(`[data-pillar="${pillar}"] tr.g`, { hasText: name })
  if ((await group.getAttribute('aria-expanded')) === 'false') await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'true')
}

async function snapshots(page: Page, n: number): Promise<void> {
  const from = await page.evaluate(() => (window as any).dash.seen.snapshots)
  await page.waitForFunction((t) => (window as any).dash.seen.snapshots >= t, from + n)
}

test.describe('the dashboard view', () => {
  test('opens without the 3D town: no three.js, no canvas, the company name from config in the menu', async ({ town, page }) => {
    const loaded: string[] = []
    page.on('request', (r) => { if (/three/i.test(r.url())) loaded.push(r.url()) })
    await open(town, page)
    expect(loaded).toEqual([])
    expect(await page.evaluate(() => (window as any).city)).toBeUndefined()
    await expect(page.locator('#town')).toBeHidden()
    await expect(page.locator('#dash-brand')).toHaveText('Tenants Town')
    await expect(page.locator('#vs-dash')).toHaveAttribute('aria-pressed', 'true')
  })

  test('the switch goes to the town and back, and the browser remembers the last view', async ({ town, page }) => {
    await open(town, page)
    await page.locator('#vs-town').click()
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    expect(new URL(page.url()).searchParams.get('view')).toBe('town')
    await page.goto('/') // no ?view=: this browser last chose the town
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    await page.locator('#view-switch').click()
    await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)
    await page.goto('/') // now the dashboard is what it remembers
    await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)
    await expect(dash(page)).toBeVisible()
  })

  test('a healthy pillar card shows only its name; the summary says everything is healthy', async ({ town, page }) => {
    await open(town, page)
    await expect(page.locator('#kpi-services')).toContainText('0 down · 0 degraded')
    await expect(page.locator('#kpi-services')).toContainText('All services are healthy')
    const card = page.locator('[data-pillar="aa"]')
    await expect(card.locator('h3')).toContainText('Alpha')
    await expect(card.locator('.m')).toHaveCount(0)
    await expect(card.locator('.issues')).toHaveCount(0)
    await expect(card).not.toHaveClass(/warn|bad/)
    // nothing below the menu speaks of towns, cities, buildings or islands
    const words = (await page.locator('#dash-sum').innerText()) + (await page.locator('#dash-pillars').innerText())
    expect(words).not.toMatch(/\b(town|city|building|island)s?\b/i)
  })

  test('a failing service shows counts, a chip with its reason, and opens its group by itself', async ({ town, page }) => {
    await open(town, page)
    await town.effect('aa.orders-api', 'Errors', 1)
    await expect(page.locator('#kpi-services')).not.toContainText('0 down · 0 degraded', { timeout: 30_000 })
    const card = page.locator('[data-pillar="aa"]')
    await expect(card).toHaveClass(/warn|bad/)
    await expect(card.locator('.issues .chip', { hasText: 'Orders API' })).toContainText('error rate')
    await expect(page.locator('#kpi-services .ch', { hasText: 'Orders API' })).toContainText('Alpha')
    await card.locator('[data-toggle]').click()
    const group = card.locator('tr.g', { hasText: 'orders' })
    await expect(group).toHaveAttribute('aria-expanded', 'true') // the group with the problem opens by itself
    await expect(card.locator('tr.row[data-system="aa.orders-api"]')).toBeVisible()
  })

  test('a database with a tenant database each expands to one line per tenant, with the test tenants tagged and hideable', async ({ town, page }) => {
    await open(town, page)
    const card = page.locator('[data-pillar="aa"]')
    await card.locator('[data-toggle]').click()
    await openGroup(page, 'aa', 'orders')
    const dbRow = card.locator('tr.row[data-system="aa.orders-db"]')
    await expect(dbRow).toContainText('tenants')
    await dbRow.locator('[data-db]').click()
    await expect(card.locator('tr.sub')).not.toHaveCount(0)
    await expect(card.locator('tr.sub', { hasText: /smoke/i }).locator('.test')).toHaveText('test')
    // the tenant filter in the menu is the town's: hide test tenants removes those lines
    await page.locator('#tenant-button').click()
    await page.locator('#hide-test').check({ force: true })
    await expect(card.locator('tr.sub', { hasText: /smoke/i })).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).dash.tenantView().hideTest)).toBe(true)
  })

  test('hiding a pillar removes its card, offers it back, and the choice is the same in the town', async ({ town, page }) => {
    await open(town, page)
    await page.locator('[data-pillar="bb"] [data-hide]').click()
    await expect(page.locator('[data-pillar="bb"]')).toHaveCount(0)
    await expect(page.locator('#hidden-pillars [data-show="bb"]')).toBeVisible()
    expect(new URL(page.url()).searchParams.get('islands')).toBe('aa')
    await page.locator('#vs-town').click()
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    expect(await page.evaluate(() => (window as any).city.islands())).toEqual(['aa'])
    await page.locator('#view-switch').click()
    await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)
    await page.locator('#hidden-pillars [data-show="bb"]').click()
    await expect(page.locator('[data-pillar="bb"]')).toBeVisible()
    await page.locator('#pillars-button').click()
    await expect(page.locator('#pillar-menu input')).toHaveCount(2)
    await page.locator('#pillar-menu input[data-pillar-box="aa"]').uncheck()
    await expect(page.locator('[data-pillar="aa"]')).toHaveCount(0)
  })

  test('what the viewer opened stays open, and the page does not jump, when new snapshots arrive', async ({ town, page }) => {
    await open(town, page)
    const card = page.locator('[data-pillar="aa"]')
    await card.locator('[data-toggle]').click()
    await openGroup(page, 'aa', 'orders')
    await expect(card.locator('tr.row[data-system="aa.orders-api"]')).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, 120))
    await snapshots(page, 3)
    await expect(card.locator('tr.row[data-system="aa.orders-api"]')).toBeVisible()
    expect(await page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(120)
  })

  test('a click on a row opens the detail drawer', async ({ town, page }) => {
    await open(town, page)
    const card = page.locator('[data-pillar="aa"]')
    await card.locator('[data-toggle]').click()
    await openGroup(page, 'aa', 'orders')
    await card.locator('tr.row[data-system="aa.orders-api"]').locator('td').first().click()
    await expect(page.locator('#inspector')).toBeVisible()
    await expect(page.locator('#inspector')).toContainText('Orders API')
  })

  for (const [name, width] of [['desktop', 1280], ['phone', 390]] as const)
    for (const scheme of ['light', 'dark'] as const)
      test(`no sideways scrolling on ${name} in ${scheme}`, async ({ town, page }) => {
        await page.setViewportSize({ width, height: 800 })
        await page.emulateMedia({ colorScheme: scheme })
        await open(town, page)
        for (const id of ['aa', 'bb']) {
          await page.locator(`[data-pillar="${id}"] [data-toggle]`).click()
          for (const g of await page.locator(`[data-pillar="${id}"] tr.g`).all()) await g.click()
        }
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        expect(over).toBeLessThanOrEqual(0)
        expect(await page.evaluate(() => document.body.dataset.mode)).toBe(scheme)
      })

  test('the narrow screen drops the minor columns', async ({ town, page }) => {
    await page.setViewportSize({ width: 700, height: 800 })
    await open(town, page)
    await page.locator('[data-pillar="aa"] [data-toggle]').click()
    for (const h of ['Inst', 'CPU %', 'Calls', 'rps', 'p99 ms', 'Called by']) await expect(page.locator('[data-pillar="aa"] thead th', { hasText: h }).first()).toBeHidden()
    await expect(page.locator('[data-pillar="aa"] thead th', { hasText: 'Err %' })).toBeVisible()
  })
})
