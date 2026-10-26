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
})
