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

  for (const machine of ['car', 'cabin'] as const) {
    test(`the Town travels in a time machine (${machine}): the overlay draws a scene and says which machine it is`, async ({ page, request }) => {
      await waitForFrames(request, 3)
      await openTown(page, `&machine=${machine}`)
      await page.evaluate(() => (window as unknown as Win).city.history.goTo(Date.now() - 15_000))
      const overlay = page.locator('#history-travel')
      await expect(overlay).toBeVisible()
      await expect(overlay).toHaveClass(/machine/)
      await expect(overlay).toHaveAttribute('data-machine', machine)
      await expect(page.locator('#history-travel canvas.scene')).toBeVisible()
      await page.waitForTimeout(700)
      // something is drawn: the canvas is not one flat colour
      const colours = await page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('#history-travel canvas.scene')!
        const g = c.getContext('2d')!
        const seen = new Set<string>()
        for (let i = 1; i < 12; i++) for (let j = 1; j < 8; j++) seen.add(Array.from(g.getImageData(Math.floor((c.width * i) / 12), Math.floor((c.height * j) / 8), 1, 1).data).join(','))
        return seen.size
      })
      expect(colours).toBeGreaterThan(5)
      await expect(page.locator('#history-when')).not.toHaveText('')
      await page.locator('#history-skip').click()
      await expect(overlay).toBeHidden()
    })
  }

  test('the Logs tab reads the logs around the viewed time while in the past, and for now again when live', async ({ page, request }) => {
    await waitForFrames(request, 3)
    await openTown(page)
    const asked: string[] = []
    page.on('request', (r) => { if (r.url().includes('/logs')) asked.push(r.url()) })
    await page.evaluate(() => (window as unknown as Win).city.history.goTo(Date.now() - 15_000))
    await page.locator('#history-skip').click()
    const viewed = (await state(page)).viewed as number
    await page.evaluate(() => {
      const c = (window as any).city
      c.openSystem(c.seen.last.groups[0].nodes[0].id, 'logs')
    })
    await expect.poll(() => asked.length).toBeGreaterThanOrEqual(1)
    const at = new URL(asked[0]).searchParams.get('at')
    expect(at).not.toBeNull()
    expect(Math.abs(Date.parse(at!) - viewed)).toBeLessThan(2000)
    // back to live: the tab reads for now, without a time
    const before = asked.length
    await page.evaluate(() => (window as unknown as Win).city.history.goLive())
    await expect.poll(() => asked.length).toBeGreaterThan(before)
    expect(new URL(asked[asked.length - 1]).searchParams.has('at')).toBe(false)
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

  test('the freshness popup has a History section with what is held', async ({ page, request }) => {
    await waitForFrames(request, 2)
    await page.goto('/?view=dashboard&test=1')
    await page.waitForFunction(() => (window as unknown as Win).dash?.seen.snapshots > 0)
    await page.locator('#fresh-button').click()
    const pop = page.locator('#fresh-pop')
    await expect(pop.locator('#fresh-history')).toHaveText('History')
    await expect(pop).toContainText('up to 7 days')
    await expect(pop).toContainText('recorded')
  })

  test('the dashboard has the same button and travels the same way', async ({ page, request }) => {
    await waitForFrames(request, 3)
    await page.goto('/?view=dashboard&test=1')
    await page.waitForFunction(() => (window as unknown as Win).dash?.seen.snapshots > 0)
    await expect(page.locator('#history-button')).toBeVisible()
    await page.evaluate(() => (window as unknown as Win).dash.history.goTo(Date.now() - 15_000))
    // only the Town has the time machine: the dashboard keeps the plain overlay
    await expect(page.locator('#history-travel')).toBeVisible()
    await expect(page.locator('#history-travel')).not.toHaveClass(/machine/)
    await expect(page.locator('#history-travel canvas')).toHaveCount(0)
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

  // ---- frames rebuilt from the cloud. This town's sources replay recordings and cannot rebuild, so the server's answers are changed on the way to the page.

  async function realFrame(request: import('@playwright/test').APIRequestContext): Promise<{ at: string; snapshot: unknown }> {
    const range = await (await request.get(`${API}/api/history/range`)).json() as { newest: string }
    return (await (await request.get(`${API}/api/history/frame?at=${encodeURIComponent(range.newest)}`)).json()) as { at: string; snapshot: unknown }
  }

  test('a rebuilt frame says so: the badge, the word on the button and a mark on the strip', async ({ page, request }) => {
    await waitForFrames(request, 3)
    const frame = { ...(await realFrame(request)), at: new Date(Date.now() - 16_000).toISOString() }
    await page.route('**/api/history/range*', async (route) => {
      const body = await (await route.fetch()).json()
      body.points = body.points.map((p: { at: string }) => ({ ...p, rebuilt: true }))
      await route.fulfill({ json: body })
    })
    await page.route('**/api/history/frame?*', (route) => route.fulfill({ json: { ...frame, rebuilt: true } }))
    // no real frames read ahead: a recorded frame that falls between the made-up one and the viewed second would be shown instead (a one in ten chance, which made this test flaky)
    await page.route('**/api/history/frames*', (route) => route.fulfill({ json: { frames: [] } }))
    await openTown(page)

    await page.evaluate((at) => (window as unknown as Win).city.history.goTo(Date.parse(at) + 1_000, { paused: true }), frame.at)
    await expect(page.locator('#history-travel')).toBeHidden({ timeout: 15_000 })

    await expect(page.locator('#history-rebuilt')).toBeVisible()
    await expect(page.locator('#history-rebuilt')).toContainText('Rebuilt from the cloud')
    await expect(page.locator('#history-button')).toContainText('rebuilt')
    await page.locator('#history-button').click()
    expect(await page.locator('#history-strip-svg .rebuilt').count()).toBeGreaterThan(0)
  })

  test('a time with no frame that the server can rebuild shows a loading card, then the rebuilt town', async ({ page, request }) => {
    await waitForFrames(request, 3)
    const frame = { ...(await realFrame(request)), at: new Date(Date.now() - 16_000).toISOString() }
    let asked = false
    await page.route(/\/api\/history\/fill(\?.*)?$/, (route) => route.fulfill({ json: { available: true, running: !asked, done: 0, total: 2, hour: null, problem: null, ahead: 2, building: false, secondsPerHour: 110 } }))
    await page.route('**/api/history/fill/priority*', (route) => { asked = true; return route.fulfill({ status: 202, body: '' }) })
    await page.route('**/api/history/frame?*', (route) => asked ? route.fulfill({ json: { ...frame, rebuilt: true } }) : route.fulfill({ status: 404, json: { error: 'no' } }))
    await openTown(page)

    // not awaited: the jump itself waits for the rebuild, and the loading card is what is looked at meanwhile
    await page.evaluate((at) => { void (window as unknown as Win).city.history.goTo(Date.parse(at) + 1_000, { paused: true }) }, frame.at)
    await expect(page.locator('#history-nodata')).toContainText('Rebuilding', { timeout: 15_000 })
    // while it waits: the town is covered, the card says what is ahead, the button says it waits and the clock stands still
    await expect(page.locator('#history-veil')).toBeVisible()
    await expect(page.locator('#history-nodata')).toContainText('2 hours are built before it, so about 6 min')
    await expect(page.locator('#history-button')).toContainText('Waiting')
    const waitingAt = (await state(page)).viewed
    await page.waitForTimeout(1_200)
    expect((await state(page)).viewed).toBe(waitingAt)
    await expect(page.locator('#history-rebuilt')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('#history-nodata')).toBeHidden()
    await expect(page.locator('#history-veil')).toBeHidden()
  })

  // last on purpose: stepping back asks the server to rebuild that hour, which changes what the tests after it see
  test('the Step and Snap to rows move from the viewed time, and [ ] hop by half an hour', async ({ page, request }) => {
    await waitForFrames(request, 2)
    await openTown(page, '&machine=car')
    await page.locator('#history-button').click()
    await expect(page.locator('#history-pop')).toContainText('Step')
    await expect(page.locator('#history-pop')).toContainText('Snap to')
    // live: only backward steps
    expect(await page.locator('#history-pop .row:has(.label:text("Step")) button').allInnerTexts()).toEqual(['−1 h', '−30 m'])
    await page.locator('#history-pop .row:has(.label:text("Step")) button', { hasText: '−30 m' }).click()
    await page.waitForFunction(() => (window as unknown as Win).city.history.state.active)
    const first = (await state(page)).viewed
    expect(Date.now() - first).toBeGreaterThan(29 * 60_000)
    expect(Date.now() - first).toBeLessThan(31 * 60_000)
    await page.locator('#history-skip').click()
    // the key goes a further half hour back, then Shift+] an hour forward (held at now: live)
    await page.keyboard.press('[')
    await page.waitForFunction((was) => (window as unknown as Win).city.history.state.viewed < was - 25 * 60_000, first)
    await page.keyboard.press('Shift+}')
    await page.waitForFunction(() => !(window as unknown as Win).city.history.state.active)
  })
})
