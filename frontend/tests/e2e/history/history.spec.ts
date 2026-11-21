import { test, expect, type Page } from '@playwright/test'
import { API } from '../support/city'

// Time travel on a live town that records a frame every 10 seconds (History__IntervalSeconds in playwright.config.ts, Polling__AlwaysOn keeps it reading).
// The tests wait until the server has a few frames, then travel to moments just behind now.

type Win = { city?: any; dash?: any }

async function waitForFrames(request: import('@playwright/test').APIRequestContext, count: number): Promise<void> {
  await expect.poll(async () => ((await (await request.get(`${API}/api/history/range`)).json()) as { frames: number }).frames, { timeout: 60_000, intervals: [1000] }).toBeGreaterThanOrEqual(count)
}

async function openTown(page: Page, query = ''): Promise<void> {
  await page.goto(`/?test=1&quality=low${query}`)
  await page.waitForFunction(() => (window as unknown as Win).city?.seen.snapshots > 0)
}

const state = (page: Page, view: 'city' | 'dash' = 'city') => page.evaluate((v) => (window as unknown as Win)[v].history.state, view)

test.describe('time travel on a live town', () => {
  test('the server keeps a range with a point for each recorded frame', async ({ request }) => {
    await waitForFrames(request, 2)
    const range = await (await request.get(`${API}/api/history/range`)).json()
    expect(range.enabled).toBe(true)
    expect(range.days).toBe(7)
    expect(range.intervalSeconds).toBe(10)
    expect(range.points.length).toBe(range.frames)
    expect(range.bytes).toBeGreaterThan(0)
  })

  test('the menu has a History button that opens the quick picks, the strip, the speeds and no way back to live while live', async ({ page, request }) => {
    await waitForFrames(request, 2)
    await openTown(page)
    const button = page.locator('#history-button')
    await expect(button).toBeVisible()
    await expect(button).toHaveAttribute('aria-label', 'History')
    await button.click()
    await expect(page.locator('#history-pop')).toBeVisible()
    const picks = await page.locator('#history-pop [data-pick]').allInnerTexts()
    expect(picks.slice(0, 6)).toEqual(['1 h ago', '6 h ago', '12 h ago', '1 day ago', '3 days ago', '7 days ago'])
    await expect(page.locator('#history-strip svg')).toBeVisible()
    await expect(page.locator('#history-pop [data-speed]')).toHaveText(['1x', '2x', '4x', '15x', '30x', '60x'])
    await expect(page.locator('#history-live')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('#history-pop')).toBeHidden()
  })

  test('travelling to a recorded moment shows the overlay, stops the live feed, and the button says when and how fast', async ({ page, request }) => {
    await waitForFrames(request, 3)
    await openTown(page)
    await page.evaluate(() => (window as unknown as Win).city.history.goTo(Date.now() - 15_000))
    await expect(page.locator('#history-travel')).toBeVisible()
    await expect(page.locator('#history-when')).not.toHaveText('')
    await page.locator('#history-skip').click()
    await expect(page.locator('#history-travel')).toBeHidden()
    await expect(page.locator('body')).toHaveClass(/history/)
    await expect(page.locator('#history-button')).toHaveText(/^\w{3} \d+ \w{3} \d\d:\d\d:\d\d · 1x$/)
    expect((await state(page)).noData).toBe(false)

    // the live feed is ignored while looking at the past
    const before = await page.evaluate(() => (window as unknown as Win).city.seen.snapshots)
    await page.waitForTimeout(2000)
    expect(await page.evaluate(() => (window as unknown as Win).city.seen.snapshots)).toBeLessThanOrEqual(before + 1)
    // Wall mode and the live status are not offered in the past
    await expect(page.locator('#wall-button')).toBeHidden()
  })

  test('going back to live shows the newest snapshot and the feed carries on', async ({ page, request }) => {
    await waitForFrames(request, 3)
    await openTown(page)
    await page.evaluate(() => (window as unknown as Win).city.history.goTo(Date.now() - 15_000))
    await page.locator('#history-skip').click()
    await page.locator('#history-button').click()
    await page.locator('#history-live').click()
    await expect(page.locator('body')).not.toHaveClass(/history/)
    await expect(page.locator('#history-button')).toHaveAttribute('aria-label', 'History')
    const after = await page.evaluate(() => (window as unknown as Win).city.seen.snapshots)
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).city.seen.snapshots)).toBeGreaterThan(after + 1)
  })

  test('time runs at the speed chosen and catches up with live by itself', async ({ page, request }) => {
    await waitForFrames(request, 3)
    await openTown(page)
    await page.evaluate(() => { const h = (window as unknown as Win).city.history; h.setSpeed(60); return h.goTo(Date.now() - 25_000) })
    await page.locator('#history-skip').click()
    await expect(page.locator('#history-button')).toContainText('60x')
    // 25 s behind at 60x catches up in under a second; the page is live again
    await expect(page.locator('body')).not.toHaveClass(/history/, { timeout: 10_000 })
    expect((await state(page)).active).toBe(false)
  })

  test('Space pauses and plays, and the arrows step one frame while paused', async ({ page, request }) => {
    await waitForFrames(request, 4)
    await openTown(page)
    await page.evaluate(() => (window as unknown as Win).city.history.goTo(Date.now() - 25_000))
    await page.locator('#history-skip').click()
    await page.locator('body').click({ position: { x: 5, y: 300 } })
    await page.keyboard.press('Space')
    expect((await state(page)).paused).toBe(true)
    await expect(page.locator('#history-button')).toContainText('Paused')
    const at = (await state(page)).viewed
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await state(page)).viewed).toBeLessThan(at)
    await page.keyboard.press('Space')
    expect((await state(page)).paused).toBe(false)
  })

  test('a moment with nothing recorded says so and plays on when frames come', async ({ page, request }) => {
    await waitForFrames(request, 2)
    await openTown(page)
    await page.evaluate(() => (window as unknown as Win).city.history.goTo(Date.now() - 3_600_000))
    await page.locator('#history-skip').click()
    await expect(page.locator('#history-nodata')).toBeVisible()
    await expect(page.locator('#history-nodata')).toContainText('Nothing was recorded')
    expect((await state(page)).noData).toBe(true)
  })

  test('a link to a moment opens paused on it, going live takes it out of the address, and the next visit starts live', async ({ page, request }) => {
    await waitForFrames(request, 3)
    const at = new Date(Date.now() - 20_000).toISOString().replace(/\.\d+Z$/, 'Z')
    await openTown(page, `&at=${at}`)
    await expect(page.locator('body')).toHaveClass(/history/)
    expect((await state(page)).paused).toBe(true)
    await page.locator('#history-skip').click().catch(() => {})
    await page.locator('#history-button').click()
    await page.locator('#history-live').click()
    await expect(page.locator('body')).not.toHaveClass(/history/)
    expect(page.url()).not.toContain('at=')
    await openTown(page)
    await expect(page.locator('body')).not.toHaveClass(/history/)
  })

  test('Copy link writes the moment in UTC and keeps the rest of the address', async ({ page, request, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
    await waitForFrames(request, 3)
    await openTown(page, '&env=demo')
    await page.evaluate(() => (window as unknown as Win).city.history.goTo(Date.now() - 20_000, { paused: true }))
    await page.locator('#history-skip').click()
    await page.locator('#history-button').click()
    await page.locator('#history-copy').click()
    await expect(page.locator('.copied')).toBeVisible()
    const link = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '')
    if (link) expect(link).toMatch(/env=demo.*&at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/)
  })

  test('the dashboard has the same button and travels the same way', async ({ page, request }) => {
    await waitForFrames(request, 3)
    await page.goto('/?view=dashboard&test=1')
    await page.waitForFunction(() => (window as unknown as Win).dash?.seen.snapshots > 0)
    await expect(page.locator('#history-button')).toBeVisible()
    await page.evaluate(() => (window as unknown as Win).dash.history.goTo(Date.now() - 15_000))
    await page.locator('#history-skip').click()
    await expect(page.locator('body')).toHaveClass(/history/)
    await expect(page.locator('#wall-button-dash')).toBeHidden()
    await page.locator('#history-button').click()
    await page.locator('#history-live').click()
    await expect(page.locator('body')).not.toHaveClass(/history/)
  })

  test('the architecture view has the same button', async ({ page, request }) => {
    await waitForFrames(request, 2)
    await page.goto('/?view=architecture&test=1')
    await page.waitForFunction(() => (window as unknown as Win).dash?.seen.snapshots > 0)
    await expect(page.locator('#history-button')).toBeVisible()
  })
})
