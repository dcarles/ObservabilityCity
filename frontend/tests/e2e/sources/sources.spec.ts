import { test, expect } from '@playwright/test'
import { API } from '../support/city'

// A live town whose environment has one source (request rate, errors and latency) and no source for anything else. No adapter for that kind
// exists yet, so what it supplies is configured and silent (grey, "no data") while the rest is absent: not shown, not grey, not zero.

async function open(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/?test=1&quality=low')
  await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
}

const ABSENT = ['instances', 'cpu', 'memory', 'utilisation', 'throttled', 'backlog', 'deadLetters']

test.describe('a live town with some signals configured', () => {
  test('the server lists the signals nothing supplies, and not the ones a source is configured for', async ({ request }) => {
    const snap = await (await request.get(`${API}/api/snapshot/latest`)).json()
    for (const n of snap.groups.flatMap((g: any) => g.nodes)) {
      expect(n.absent, n.id).toEqual(ABSENT)
      // configured but silent: grey
      expect(n.state, n.id).toBe('Stale')
    }
  })

  test('a silent source is grey and counted as no data; the signals nobody asked for are not drawn', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.step(0.5))
    const api = await page.evaluate(() => (window as any).city.inspect('aa.orders-api'))
    expect(api.beacon).toBe('grey')
    expect(api.plaque).toBe('no data')
    await expect(page.locator('#topbar [data-list="Stale"] b')).not.toHaveText('0')
    // requests, errors and latency are configured, so their totals stay; the queue signal is not, so its total goes
    await expect(page.locator('#topbar')).toContainText('req/s')
    await expect(page.locator('#topbar')).toContainText('p99')
    await expect(page.locator('#topbar')).not.toContainText('DLQ')
  })

  // The page is served a snapshot of our making: the live socket is refused, so it polls, and the poll gets the server's snapshot with one system changed.
  async function openServing(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext, patch: Record<string, unknown>): Promise<void> {
    const real = await (await request.get(`${API}/api/snapshot/latest`)).json()
    Object.assign(real.groups.flatMap((g: any) => g.nodes).find((n: any) => n.id === 'aa.orders-api'), patch)
    await page.route('**/hubs/town**', (r) => r.abort())
    await page.route('**/api/snapshot/latest**', (r) => r.fulfill({ json: real }))
    await open(page)
  }

  test('given fresh numbers, only the configured signals appear in the drawer', async ({ page, request }) => {
    await openServing(page, request, { state: 'Healthy', requestsPerSecond: 12, errorRate: 0.002, p99Ms: 120 })
    await page.locator('#search-input').fill('Orders API')
    await page.locator('#search-results .hit').first().click()
    const rows = page.locator('#inspector .rows')
    await expect(rows).toContainText('Requests')
    await expect(rows).toContainText('Errors')
    await expect(rows).toContainText('p99 / SLA')
    for (const label of ['Instances', 'CPU', 'Memory', 'Capacity used', 'Throttled', 'Waiting', 'Oldest message', 'Dead letters', 'Load'])
      await expect(rows).not.toContainText(label)
    await page.evaluate(() => (window as any).city.step(1))
    const api = await page.evaluate(() => (window as any).city.inspect('aa.orders-api'))
    expect(api.beacon).toBe('green') // errors are configured, so the lamp is lit from them
    expect(api.plaque).toBe('')
  })

  test('a signal that is not configured stays out even when a number comes with it', async ({ page, request }) => {
    // the server never sends a number for an absent signal; a stray one must not be drawn or held against the system either
    await openServing(page, request, { state: 'Healthy', cpu: 0.99, instancesTotal: 3, instancesHealthy: 1, requestsPerSecond: 5, errorRate: 0, p99Ms: 50 })
    await page.locator('#search-input').fill('Orders API')
    await page.locator('#search-results .hit').first().click()
    await expect(page.locator('#inspector .rows')).toContainText('Requests')
    await expect(page.locator('#inspector .rows')).not.toContainText('CPU')
    await expect(page.locator('#inspector .why')).toHaveCount(0)
  })
})
