import { test, expect } from '@playwright/test'
import { API } from '../support/city'

// A town with no mode in its town.yaml is a live town: no fake source, so no /api/fake, no Break things panel and no story bar.
// live-town has no fake.yaml and no stories folder. It does not use the shared fixtures, because those steer the fake source.

async function open(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/?test=1&quality=low')
  await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
}

test.describe('a live town', () => {
  test('the server says live and has no fake source', async ({ request }) => {
    const snap = await (await request.get(`${API}/api/snapshot/latest`)).json()
    expect(snap.mode).toBe('live')
    for (const path of ['', '/stories', '/story']) {
      expect((await request.get(`${API}/api/fake${path}`)).status(), `GET /api/fake${path}`).toBe(404)
    }
    expect((await request.post(`${API}/api/fake/reset`)).status()).toBe(404)
    expect((await request.post(`${API}/api/fake/effects`, { data: { target: '*', kind: 'Down', intensity: 1 } })).status()).toBe(404)
  })

  test('the page has no Break things panel and no story bar, and says Live without "demo data"', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await open(page)
    expect(await page.evaluate(() => (window as any).city.mode())).toBe('live')
    await expect(page.locator('#break-panel')).toBeHidden()
    await expect(page.locator('#story-bar')).toBeHidden()
    expect(await page.locator('#break-panel').innerHTML()).toBe('')
    const status = await page.locator('#topbar').innerText()
    expect(status).toContain('Live')
    expect(status).not.toContain('demo data')
    expect(await page.evaluate(() => (window as any).city.breakArmed())).toBe(false)
    expect(errors).toEqual([])
  })

  test('the page asks the server for nothing under /api/fake', async ({ page }) => {
    const asked: string[] = []
    page.on('request', (r) => { if (r.url().includes('/api/fake')) asked.push(r.url()) })
    await open(page)
    await page.waitForTimeout(1500)
    expect(asked).toEqual([])
  })

  test('a system no source is configured for is absent, not grey: no lamp, no "no data", no totals that are really zeros', async ({ page, request }) => {
    const snap = await (await request.get(`${API}/api/snapshot/latest`)).json()
    for (const n of snap.groups.flatMap((g: any) => g.nodes)) expect(n.absent, n.id).toHaveLength(10)

    await open(page)
    await page.evaluate(() => (window as any).city.step(0.5))
    const api = await page.evaluate(() => (window as any).city.inspect('aa.orders-api'))
    expect(api.beacon).toBe('off')
    expect(api.plaque).toBe('not monitored')

    const bar = page.locator('#topbar')
    await expect(bar).not.toContainText('req/s')
    await expect(bar).not.toContainText('errors')
    await expect(bar).not.toContainText('p99')
    await expect(bar).not.toContainText('DLQ')
    // nothing is missing data: there is nothing configured to miss
    await expect(page.locator('#topbar [data-list="Stale"] b')).toHaveText('0')
  })

  test('the Logs tab says logs are not set up, instead of showing four empty sections', async ({ page, request }) => {
    const first = (await (await request.get(`${API}/api/snapshot/latest`)).json()).groups[0].nodes[0]
    const logs = await (await request.get(`${API}/api/systems/${first.id}/logs`)).json()
    expect(logs.configured).toBe(false)
    expect(logs.sections).toEqual([])
    await open(page)
    await page.locator('#search-input').fill(first.name)
    await page.locator('#search-results .hit').first().click()
    await page.locator('#inspector [data-tab="logs"]').click()
    await expect(page.locator('#inspector [data-logs="unconfigured"]')).toContainText('not set up')
    await expect(page.locator('#inspector [data-log-tab]')).toHaveCount(0)
  })

  test('the inspector says there is no source instead of listing numbers', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.inspect('aa.orders-api'))
    await page.evaluate(() => (document.querySelector('#search-input') as HTMLInputElement | null)?.focus())
    await page.locator('#search-input').fill('Orders API')
    await page.locator('#search-results .hit').first().click()
    await expect(page.locator('#inspector .rows')).toContainText('no source configured')
    await expect(page.locator('#inspector .rows')).not.toContainText('Requests')
    await expect(page.locator('#inspector .why')).toHaveCount(0)
  })
})
