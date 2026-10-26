import { test, expect } from '../support/test'
import { API, type Town } from '../support/city'

// The Break things panel and the daily cycle, on mini-town (islands aa Alpha, bb Beta, cc Gamma).

async function fx(town: Town): Promise<{ calm: boolean; dayLengthSeconds: number; effects: { id: string; target: string; kind: string; intensity: number }[]; story: { storyId: string | null } }> {
  return (await (await town.request.get(`${API}/api/fake`)).json()) as never
}

/** Glides the camera to a building and settles, so a click on its screen position lands on it. */
async function lookAt(town: Town, id: string): Promise<{ x: number; y: number }> {
  await town.page.evaluate((i) => {
    const c = (window as any).city
    const f = c.town.focusOf(i)
    c.stage.focus(f.target, 22)
  }, id)
  await town.step(4)
  const p = await town.page.evaluate((i) => (window as any).city.screenOf(i), id)
  expect(p, `${id} is not on the screen`).not.toBeNull()
  return p
}

test.describe('the panel', () => {
  test('is called Break things, lists every scenario, and the old Try it panel is gone', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#break-panel h3')).toHaveText('Break things')
    await expect(page.locator('#break-panel [data-scenario]')).toHaveCount(16)
    await expect(page.locator('#break-panel .hint')).toContainText('Pick a scenario, then click a building')
    await expect(page.getByText('Try it')).toHaveCount(0)
    await page.locator('#fold').click()
    await expect(page.locator('#break-panel [data-scenario]').first()).toBeHidden()
    await page.locator('#fold').click()
    await expect(page.locator('#break-panel [data-scenario]').first()).toBeVisible()
  })

  test('a scenario waits for a click on a building in the town, then breaks it without opening it', async ({ town, page }) => {
    await town.open()
    await town.step(2)
    await page.locator('[data-scenario="errors"]').click()
    await expect(page.locator('#break-panel .hint')).toContainText('click a building')
    await expect(page.locator('[data-scenario="errors"]')).toHaveClass(/on/)
    expect(await page.evaluate(() => (window as any).city.breakArmed())).toBe(true)
    expect((await fx(town)).effects).toEqual([])

    const at = await lookAt(town, 'bb.ledger-api')
    await page.mouse.click(at.x, at.y)

    await expect.poll(async () => (await fx(town)).effects.map((e) => e.kind)).toEqual(['Errors'])
    const effect = (await fx(town)).effects[0]
    expect(effect.target).toMatch(/^bb\./) // the building under the pointer, in Beta
    expect(effect.intensity).toBe(0.4)
    await expect(page.locator('.fxchip')).toHaveCount(1)
    await expect(page.locator('.fxchip')).toContainText('Errors')
    expect(await page.evaluate(() => (window as any).city.breakArmed())).toBe(false)
    // the click was used for the scenario, so no drawer opened
    expect((await page.evaluate(() => (window as any).city.inspector())).id).toBeNull()
    await town.until(effect.target, (n) => n.errorRate > 0.1)
  })

  test('a click on the sea keeps the scenario waiting, and Escape lets go of it', async ({ town, page }) => {
    await town.open()
    await page.locator('[data-scenario="down"]').click()
    await page.mouse.click(4, 590) // open water in the corner
    expect(await page.evaluate(() => (window as any).city.breakArmed())).toBe(true)
    expect((await fx(town)).effects).toEqual([])

    await page.keyboard.press('Escape')

    expect(await page.evaluate(() => (window as any).city.breakArmed())).toBe(false)
    await expect(page.locator('[data-scenario="down"]')).not.toHaveClass(/on/)
    await expect(page.locator('#break-panel .hint')).toContainText('Pick a scenario')
    // with nothing waiting, a click opens the building again
    const at = await lookAt(town, 'aa.orders-api')
    await page.mouse.click(at.x, at.y)
    await expect.poll(async () => (await page.evaluate(() => (window as any).city.inspector())).id).not.toBeNull()
  })

  test('the search works in either order: scenario then target, or target then scenario', async ({ town, page }) => {
    await town.open()
    await page.locator('[data-scenario="slow"]').click()
    await page.locator('#target').fill('orders worker')
    await page.locator('#target-results .hit').first().click()
    await expect.poll(async () => (await fx(town)).effects.map((e) => `${e.kind}:${e.target}`)).toEqual(['Latency:aa.orders-worker'])
    await expect(page.locator('.fxchip')).toContainText('Slow · Orders worker')

    await page.locator('#target').fill('island: gamma')
    await page.keyboard.press('Enter')
    await expect(page.locator('#break-panel .hint')).toContainText('Target: Gamma')
    await page.locator('[data-scenario="sev1"]').click()
    await expect.poll(async () => (await fx(town)).effects.map((e) => `${e.kind}:${e.target}`)).toContain('Incident:cc')
    await expect(page.locator('.fxchip', { hasText: 'Sev 1 storm' })).toBeVisible()
    // the choice was used up: the next scenario waits again
    await page.locator('[data-scenario="errors"]').click()
    expect(await page.evaluate(() => (window as any).city.breakArmed())).toBe(true)
  })

  test('a chip has a slider that sets how strong it is, and a cross that clears it', async ({ town, page }) => {
    await town.open()
    await town.step(2)
    await page.locator('#target').fill('ledger api')
    await page.locator('#target-results .hit').first().click()
    await page.locator('[data-scenario="errors"]').click()
    const chip = page.locator('.fxchip').first()
    await expect(chip).toBeVisible()

    await chip.locator('input[type=range]').fill('100')

    await expect.poll(async () => (await fx(town)).effects[0].intensity).toBe(1)
    await town.until('bb.ledger-api', (n) => n.errorRate > 0.25)
    await chip.locator('input[type=range]').fill('0')
    await expect.poll(async () => (await fx(town)).effects[0].intensity).toBe(0)
    await town.until('bb.ledger-api', (n) => n.errorRate < 0.05)

    await chip.locator('.x').click()
    await expect(page.locator('.fxchip')).toHaveCount(0)
    expect((await fx(town)).effects).toEqual([])
  })

  test('Down has no slider, and an incident chip is renamed as its strength moves', async ({ town, page }) => {
    await town.open()
    await page.locator('#target').fill('orders api')
    await page.locator('#target-results .hit').first().click()
    await page.locator('[data-scenario="down"]').click()
    await expect(page.locator('.fxchip')).toHaveCount(1)
    await expect(page.locator('.fxchip input[type=range]')).toHaveCount(0)
    await town.removeEffects()
    await expect(page.locator('.fxchip')).toHaveCount(0)

    await page.locator('#target').fill('island: alpha')
    await page.keyboard.press('Enter')
    await page.locator('[data-scenario="sev1"]').click()
    const chip = page.locator('.fxchip')
    await expect(chip).toContainText('Sev 1 storm')
    await chip.locator('input[type=range]').fill('20')
    await expect(chip).toContainText('Sev 4 clouds')
  })

  test('Reset clears every effect and stops the story', async ({ town, page }) => {
    await town.open()
    await town.effect('aa.orders-api', 'Errors', 0.5)
    await town.effect('bb.ledger-api', 'Down')
    await town.request.post(`${API}/api/fake/story/play`, { data: { id: 'orders-trouble' } })
    await expect(page.locator('.fxchip')).toHaveCount(2)

    await page.locator('#reset').click()

    await expect(page.locator('.fxchip')).toHaveCount(0)
    expect((await fx(town)).effects).toEqual([])
    expect((await fx(town)).story.storyId).toBeNull()
    await town.until('bb.ledger-api', (n) => n.state === 'Healthy')
  })
})

test.describe('effects that come from a story', () => {
  test('show as chips tagged story that cannot be cleared by hand', async ({ town, page }) => {
    await town.open()
    await town.request.post(`${API}/api/fake/story/play`, { data: { id: 'orders-trouble' } })
    await town.request.post(`${API}/api/fake/story/pause`)
    await town.request.post(`${API}/api/fake/story/seek`, { data: { seconds: 25 } })

    const chips = page.locator('.fxchip.story')
    await expect(chips).toHaveCount(2)
    await expect(chips.first()).toContainText('story')
    await expect(chips.locator('.x')).toHaveCount(0)
    await expect(page.locator('.fxchip:not(.story)')).toHaveCount(0)
    expect((await fx(town)).effects).toEqual([]) // not among the hand-set ones
  })
})

test.describe('the daily cycle and Calm', () => {
  test('Calm is on for the tests; turning it off lets the day run, and on freezes it again', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#calm')).toHaveClass(/on/)
    const a = await page.evaluate(() => (window as any).city.seen.last.dayFraction)
    await town.nextSnapshot()
    expect(await page.evaluate(() => (window as any).city.seen.last.dayFraction)).toBe(a)

    await page.locator('#calm').click()
    await expect(page.locator('#calm')).not.toHaveClass(/on/)
    expect((await fx(town)).calm).toBe(false)
    await page.locator('#day-length').selectOption('10')
    await expect.poll(async () => (await fx(town)).dayLengthSeconds).toBe(10)
    await page.waitForFunction((was) => (window as any).city.seen.last.dayFraction !== was, a, { timeout: 15_000 })
    const moving = await page.evaluate(() => (window as any).city.seen.last.dayFraction)
    await town.nextSnapshot()
    expect(await page.evaluate(() => (window as any).city.seen.last.dayFraction)).not.toBe(moving)

    await page.locator('#calm').click()
    await expect(page.locator('#calm')).toHaveClass(/on/)
    await town.nextSnapshot()
    await town.nextSnapshot()
    expect(await page.evaluate(() => (window as any).city.seen.last.dayFraction)).toBe(0.5)
  })

  test('the length of a day can be chosen, and Reset puts it back to 2 minutes', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#day-length')).toHaveValue('120')
    await page.locator('#day-length').selectOption('30')
    await expect.poll(async () => (await fx(town)).dayLengthSeconds).toBe(30)

    await page.locator('#reset').click()

    await expect.poll(async () => (await fx(town)).dayLengthSeconds).toBe(120)
    await expect(page.locator('#day-length')).toHaveValue('120')
  })

  test('traffic rises through the day when Calm is off', async ({ town, page }) => {
    await town.open()
    await page.locator('#day-length').selectOption('10')
    await page.locator('#calm').click()
    const seen = new Set<number>()
    for (let i = 0; i < 14; i++) {
      await town.nextSnapshot()
      seen.add(Math.round((await town.node('aa.orders-api')).requestsPerSecond * 10))
    }
    expect(seen.size, 'the request rate never moved').toBeGreaterThan(3)
  })
})
