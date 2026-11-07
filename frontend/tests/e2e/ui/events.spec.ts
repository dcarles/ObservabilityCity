import type { Page } from '@playwright/test'
import { test, expect } from '../support/test'

// The Konami code plays one scripted event per theme on a real island, using its own buildings: pirates in the harbour town, zombies in the
// factory, aliens in space. The town stays in view, and Escape (or the end of the event) puts the camera back and leaves the town as it was.

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']
const city = <T>(page: Page, fn: string): Promise<T> => page.evaluate((f) => new Function('c', `return (${f})(c)`)((window as any).city), fn) as Promise<T>
const typeCode = async (page: Page): Promise<void> => {
  for (const k of KONAMI) await page.keyboard.press(k)
}

const THEMES: { theme: string; event: string; caption: RegExp; key: string }[] = [
  { theme: 'harbour-town', event: 'pirates', caption: /pirate ship/i, key: 'burning' },
  { theme: 'factory', event: 'zombies', caption: /armoured car/i, key: 'shotsFired' },
  { theme: 'space', event: 'aliens', caption: /saucers/i, key: 'shotsFired' },
]

for (const { theme, event, caption, key } of THEMES) {
  test.describe(`${theme}: ${event}`, () => {
    test('starts on the Konami code, on a real island, with the town still there', async ({ town, page }, info) => {
      await town.open(`&theme=${theme}`)
      expect(await city<string>(page, 'c => c.event.id()')).toBe(event)
      expect(await city<boolean>(page, 'c => c.event.playing()')).toBe(false)
      const camera0 = await city<number[]>(page, 'c => c.stage.camera.position.toArray()')
      await typeCode(page)
      await page.waitForFunction(() => (window as any).city.event.playing() && (window as any).city.event.inspect() !== null, null, { timeout: 60_000 })
      // it plays on one of the town's own islands
      const spot = await city<{ island: string } | null>(page, 'c => c.event.placement()')
      expect(spot).not.toBeNull()
      expect(await city<string[]>(page, 'c => c.event.islands()')).toContain(spot!.island)
      // the town is still drawn, and the caption says what is happening
      expect(await city<boolean>(page, 'c => c.town.root.visible')).toBe(true)
      await expect(page.locator('#event-caption')).toHaveText(caption)
      await town.step(2)
      await info.attach(`${theme}-start`, { body: await page.screenshot(), contentType: 'image/png' })
      // the camera has gone to the island
      expect(await city<number[]>(page, 'c => c.stage.camera.position.toArray()')).not.toEqual(camera0)
    })

    test('plays, moves on with time, and gives the camera back at the end', async ({ town, page }, info) => {
      await town.open(`&theme=${theme}`)
      await city(page, 'c => c.event.play()')
      const camera0 = await city<number[]>(page, 'c => c.stage.camera.position.toArray()')
      await city(page, 'c => c.event.setTime(30)')
      await town.step(1)
      const mid = await city<Record<string, number>>(page, 'c => c.event.inspect()')
      expect(mid[key]).toBeGreaterThan(0)
      await info.attach(`${theme}-middle`, { body: await page.screenshot(), contentType: 'image/png' })
      await city(page, 'c => c.event.setTime(c.event.time() + 0.01)')
      // run it to its end
      for (let i = 0; i < 8 && (await city<boolean>(page, 'c => c.event.playing()')); i++) {
        await city(page, 'c => c.event.setTime(Math.min(c.event.time() + 12, 1e6))')
        await town.step(1)
      }
      await expect.poll(() => city<boolean>(page, 'c => c.event.playing()')).toBe(false)
      expect(await city<string>(page, 'c => c.event.caption()')).toBe('')
      await town.step(4)
      const back = await city<number[]>(page, 'c => c.stage.camera.position.toArray()')
      expect(back.map((v) => Math.round(v))).toEqual(camera0.map((v) => Math.round(v)))
    })

    test('hits real buildings of the island, and leaves the town exactly as it was afterwards', async ({ town, page }) => {
      await town.open(`&theme=${theme}`)
      const before = await city<string>(page, 'c => JSON.stringify([c.stage.scene.children.length, c.town.eventSites().map((e) => [e.source.id, e.source.blocks.length])])')
      await city(page, 'c => c.event.play()')
      await city(page, 'c => c.event.setTime(c.event.time() + 0.01)')
      expect(await city<number>(page, 'c => c.stage.scene.children.length')).toBeGreaterThan(JSON.parse(before)[0])
      await city(page, 'c => c.event.setTime(c.event.time() + 40)')
      await town.step(1)
      // some of the island's own buildings have been hit by now
      const hits = await city<Record<string, number>>(page, 'c => c.event.hits()')
      expect(Object.keys(hits).length).toBeGreaterThan(0)
      expect(Object.values(hits).some((h) => h < 1e8)).toBe(true)
      await city(page, 'c => c.event.setTime(1e6)')
      await town.step(2)
      await expect.poll(() => city<boolean>(page, 'c => c.event.playing()')).toBe(false)
      expect(await city<string>(page, 'c => JSON.stringify([c.stage.scene.children.length, c.town.eventSites().map((e) => [e.source.id, e.source.blocks.length])])')).toBe(before)
    })

    test('Escape while the models are still loading cancels it', async ({ town, page }) => {
      await town.open(`&theme=${theme}`)
      await page.evaluate(() => { void (window as any).city.event.play(); (window as any).city.event.stop() })
      await page.waitForTimeout(1500)
      expect(await city<boolean>(page, 'c => c.event.playing()')).toBe(false)
      expect(await city(page, 'c => c.event.inspect()')).toBeNull()
    })

    test('stops on Escape and can be played again', async ({ town, page }) => {
      await town.open(`&theme=${theme}`)
      await typeCode(page)
      await page.waitForFunction(() => (window as any).city.event.inspect() !== null, null, { timeout: 60_000 })
      await page.keyboard.press('Escape')
      expect(await city<boolean>(page, 'c => c.event.playing()')).toBe(false)
      await expect(page.locator('#event-caption')).toBeHidden()
      await typeCode(page)
      await page.waitForFunction(() => (window as any).city.event.playing(), null, { timeout: 30_000 })
    })
  })
}

test('the code does nothing when typed into a box', async ({ town, page }) => {
  await town.open()
  await page.locator('#search-input').click()
  await typeCode(page)
  expect(await city<boolean>(page, 'c => c.event.playing()')).toBe(false)
})

test('the dashboard view ignores the Konami code and shows no event', async ({ page }) => {
  await page.goto('/?test=1&view=dashboard')
  await page.waitForTimeout(1500)
  await typeCode(page)
  await page.waitForTimeout(500)
  await expect(page.locator('#event-caption')).toHaveCount(0)
  expect(await page.evaluate(() => document.body.classList.contains('event-playing'))).toBe(false)
})
