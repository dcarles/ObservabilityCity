import { test, expect } from '../support/test'
import { API, type Town } from '../support/city'

// The story bar on mini-town, which ships one story, orders-trouble (40 s): all quiet; the orders API fails from 10 s (a ramp up to 20 s);
// the orders worker goes down at 20 s; everything is cleared at 30 s.

async function story(town: Town): Promise<{ storyId: string | null; playing: boolean; ended: boolean; speed: number; position: number; step: number; caption: string | null }> {
  return (await (await town.request.get(`${API}/api/fake/story`)).json()) as never
}

/** Moves the scrub bar to a second of the 40-second story. */
async function scrubTo(town: Town, seconds: number): Promise<void> {
  await town.page.locator('#story-scrub').fill(String(Math.round((seconds / 40) * 1000)))
}

test.describe('the story bar', () => {
  test('lists the stories of the town, shows nothing else while none plays, and has a tick for every step', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#story-bar')).toBeVisible()
    await expect(page.locator('#story-select option')).toHaveText(['Stories…', 'Orders trouble'])
    await expect(page.locator('#story-caption')).toBeHidden()
    await expect(page.locator('#story-scrub')).toBeDisabled()
    await expect(page.locator('#story-bar')).toHaveAttribute('data-state', 'idle')

    await page.locator('#story-select').selectOption('orders-trouble')
    await expect(page.locator('#story-bar')).toHaveAttribute('data-state', 'playing')
    await expect(page.locator('#story-bar .marks i')).toHaveCount(4)
    await expect(page.locator('#story-time')).toContainText('/ 0:40')
    await expect(page.locator('#story-caption')).toHaveText('All quiet.')
  })

  test('play, pause and resume: time moves only while it plays', async ({ town, page }) => {
    await town.open()
    await page.locator('#story-play').click() // nothing picked: it plays the first story
    await expect(page.locator('#story-bar')).toHaveAttribute('data-state', 'playing')
    await expect(page.locator('#story-play')).toHaveAttribute('aria-label', 'Pause')
    await expect.poll(async () => (await story(town)).position).toBeGreaterThan(1)

    await page.locator('#story-play').click()
    await expect(page.locator('#story-bar')).toHaveAttribute('data-state', 'paused')
    const held = (await story(town)).position
    await page.waitForTimeout(1500)
    expect((await story(town)).position).toBe(held)

    await page.locator('#story-play').click()
    await expect.poll(async () => (await story(town)).position).toBeGreaterThan(held + 1)
  })

  test('scrubbing moves the town to that second: the caption, the effects and the building states follow, forward and back', async ({ town, page }) => {
    await town.open()
    await page.locator('#story-select').selectOption('orders-trouble')
    await page.locator('#story-play').click() // pause
    await expect(page.locator('#story-bar')).toHaveAttribute('data-state', 'paused')

    await scrubTo(town, 25)
    await expect(page.locator('#story-caption')).toHaveText('The orders worker goes down.')
    await expect(page.locator('#story-time')).toContainText('0:25 / 0:40')
    await town.until('aa.orders-worker', (n) => n.state === 'Down')
    await town.until('aa.orders-api', (n) => n.errorRate > 0.2)
    await town.step(3)
    expect((await town.inspect('aa.orders-worker')).beacon).toBe('red')
    await expect(page.locator('.fxchip.story')).toHaveCount(2)

    await scrubTo(town, 35)
    await expect(page.locator('#story-caption')).toHaveText('Everything recovers.')
    await town.until('aa.orders-worker', (n) => n.state === 'Healthy')
    await expect(page.locator('.fxchip.story')).toHaveCount(0)

    await scrubTo(town, 2)
    await expect(page.locator('#story-caption')).toHaveText('All quiet.')
    await scrubTo(town, 15)
    await expect(page.locator('#story-caption')).toHaveText('The orders API starts to fail.')
    await town.until('aa.orders-api', (n) => n.errorRate > 0.1)
    await town.until('aa.orders-worker', (n) => n.state === 'Healthy')
  })

  test('the camera glides to the target of a step when the step begins', async ({ town, page }) => {
    await town.open()
    const target = () => page.evaluate((id) => {
      const c = (window as any).city
      const f = c.town.focusOf(id)
      // across the ground: the camera's target stays on it
      return Math.hypot(c.stage.controls.target.x - f.target.x, c.stage.controls.target.z - f.target.z) as number
    }, 'aa.orders-worker')
    await page.locator('#story-select').selectOption('orders-trouble')
    await page.locator('#story-play').click() // pause
    expect(await target()).toBeGreaterThan(8)

    await scrubTo(town, 22) // the step with the worker as its camera
    await expect.poll(async () => { await town.step(1); return target() }).toBeLessThan(2)
  })

  test('the speed button goes through the speeds and the story runs that much faster', async ({ town, page }) => {
    await town.open()
    await page.locator('#story-select').selectOption('orders-trouble')
    await expect(page.locator('#story-speed')).toHaveText('1x')
    await page.locator('#story-speed').click()
    await expect(page.locator('#story-speed')).toHaveText('2x')
    await page.locator('#story-speed').click()
    await page.locator('#story-speed').click()
    await expect(page.locator('#story-speed')).toHaveText('8x')
    await expect.poll(async () => (await story(town)).speed).toBe(8)
    await page.locator('#story-speed').click()
    await expect(page.locator('#story-speed')).toHaveText('0.5x')
    await expect.poll(async () => (await story(town)).speed).toBe(0.5)
  })

  test('at the end it says so, and play starts it again from the beginning', async ({ town, page }) => {
    await town.open()
    await page.locator('#story-select').selectOption('orders-trouble')
    await page.locator('#story-play').click() // pause
    await scrubTo(town, 40)
    await expect(page.locator('#story-bar')).toHaveAttribute('data-state', 'ended')
    await expect(page.locator('#story-caption')).toContainText('The story is over')

    await page.locator('#story-play').click()

    await expect(page.locator('#story-bar')).toHaveAttribute('data-state', 'playing')
    await expect(page.locator('#story-caption')).toHaveText('All quiet.')
    expect((await story(town)).position).toBeLessThan(10)
  })

  test('Stop ends the story and the town heals', async ({ town, page }) => {
    await town.open()
    await page.locator('#story-select').selectOption('orders-trouble')
    await page.locator('#story-play').click()
    await scrubTo(town, 25)
    await town.until('aa.orders-worker', (n) => n.state === 'Down')

    await page.locator('#story-stop').click()

    await expect(page.locator('#story-bar')).toHaveAttribute('data-state', 'idle')
    await expect(page.locator('#story-caption')).toBeHidden()
    await expect(page.locator('#story-select')).toHaveValue('')
    expect((await story(town)).storyId).toBeNull()
    await town.until('aa.orders-worker', (n) => n.state === 'Healthy')
  })

  test('hand-set effects and a story work together, and a story started elsewhere shows in the bar', async ({ town, page }) => {
    await town.open()
    await town.effect('bb.ledger-api', 'Down')
    await town.request.post(`${API}/api/fake/story/play`, { data: { id: 'orders-trouble', speed: 2 } })

    await expect(page.locator('#story-bar')).toHaveAttribute('data-state', 'playing')
    await expect(page.locator('#story-speed')).toHaveText('2x')
    await expect(page.locator('#story-select')).toHaveValue('orders-trouble')
    await town.request.post(`${API}/api/fake/story/seek`, { data: { seconds: 25 } })
    await town.until('aa.orders-worker', (n) => n.state === 'Down')
    await town.until('bb.ledger-api', (n) => n.state === 'Down')
  })
})
