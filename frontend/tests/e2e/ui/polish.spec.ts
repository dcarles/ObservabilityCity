import type { Page } from '@playwright/test'
import { test, expect } from '../support/test'

// Quality presets and the Dusk preset, on mini-town. (Town.open pins ?quality=low, so a test that cares about the usual start opens the page itself.)

const city = <T>(page: Page, fn: string): Promise<T> => page.evaluate((f) => new Function('c', `return (${f})(c)`)((window as any).city), fn) as Promise<T>

async function waitForTown(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
}

test.describe('the quality list', () => {
  test('is in the top bar with High, Medium and Low, and shows the level in use', async ({ town, page }) => {
    await town.open() // pinned to Low
    await expect(page.locator('#quality-button')).toHaveText(/Quality: Low/)
    await page.locator('#quality-button').click()
    await expect(page.locator('#quality-list [data-act="quality"]')).toHaveCount(3)
    await expect(page.locator('#quality-list')).toContainText('High')
    await expect(page.locator('#quality-list')).toContainText('Medium')
    await expect(page.locator('#quality-list .sel')).toContainText('Low')
  })

  test('High draws sharp with shadows every frame and all the traffic', async ({ town, page }) => {
    await town.open()
    await page.locator('#quality-button').click()
    await page.locator('#quality-list [data-id="high"]').click()
    expect(await city<string>(page, 'c => c.quality()')).toBe('high')
    const s = await city<any>(page, 'c => ({ sun: c.stage.sun.castShadow, auto: c.stage.renderer.shadowMap.autoUpdate, map: c.stage.sun.shadow.mapSize.x, ratio: c.stage.renderer.getPixelRatio(), cars: c.town.cars.density, boats: c.town.boats.density })')
    expect(s).toMatchObject({ sun: true, auto: true, map: 4096, cars: 1, boats: 1 })
    expect(s.ratio).toBeLessThanOrEqual(2)
    await expect(page.locator('#quality-button')).toHaveText(/Quality: High/)
  })

  test('Medium redraws shadows a few times a second on a smaller map, with most of the traffic', async ({ town, page }) => {
    await town.open()
    await page.locator('#quality-button').click()
    await page.locator('#quality-list [data-id="medium"]').click()
    const s = await city<any>(page, 'c => ({ sun: c.stage.sun.castShadow, auto: c.stage.renderer.shadowMap.autoUpdate, map: c.stage.sun.shadow.mapSize.x, ratio: c.stage.renderer.getPixelRatio(), cars: c.town.cars.density, boats: c.town.boats.density })')
    expect(s).toMatchObject({ sun: true, auto: false, map: 2048, cars: 0.7, boats: 0.7 })
    expect(s.ratio).toBeLessThanOrEqual(1.5)
  })

  test('Low draws at normal resolution without shadows and with less than half the traffic', async ({ town, page }) => {
    await town.open('&quality=high') // the first ?quality= in the address is the one that counts, so this opens on Low and the click below changes it
    await page.locator('#quality-button').click()
    await page.locator('#quality-list [data-id="high"]').click()
    await page.locator('#quality-button').click()
    await page.locator('#quality-list [data-id="low"]').click()
    expect(await city<string>(page, 'c => c.quality()')).toBe('low')
    const s = await city<any>(page, 'c => ({ sun: c.stage.sun.castShadow, ratio: c.stage.renderer.getPixelRatio(), map: c.stage.sun.shadow.mapSize.x, cars: c.town.cars.density, boats: c.town.boats.density })')
    expect(s).toMatchObject({ sun: false, ratio: 1, map: 1024, cars: 0.4, boats: 0.4 })
  })

  test('the level is remembered by this browser, and the address still wins', async ({ town, page }) => {
    await town.reset()
    await page.goto('/?test=1')
    await waitForTown(page)
    expect(await city<string>(page, 'c => c.quality()')).toBe('high')
    await page.locator('#quality-button').click()
    await page.locator('#quality-list [data-id="medium"]').click()

    await page.goto('/?test=1')
    await waitForTown(page)
    expect(await city<string>(page, 'c => c.quality()')).toBe('medium')
    await page.goto('/?test=1&quality=low')
    await waitForTown(page)
    expect(await city<string>(page, 'c => c.quality()')).toBe('low')
  })

  test('a wall opens on Medium, and ?quality=low gives it the lowest level', async ({ town, page }) => {
    await town.reset()
    await page.goto('/?test=1&wall=1')
    await waitForTown(page)
    expect(await city<string>(page, 'c => c.quality()')).toBe('medium')
    await page.goto('/?test=1&wall=1&quality=low')
    await waitForTown(page)
    expect(await city<string>(page, 'c => c.quality()')).toBe('low')
    expect(await city<number>(page, 'c => c.town.cars.density')).toBe(0.4)
  })

  test('sends fewer cars at Low than at High', async ({ town, page }) => {
    await town.reset()
    const carsSent = async (quality: string): Promise<number> => {
      await page.goto(`/?test=1&quality=${quality}`)
      await waitForTown(page)
      return page.evaluate(() => {
        const c = (window as any).city
        const before = c.drawnCars().sent
        for (let i = 0; i < 40; i++) c.step(0.5)
        return c.drawnCars().sent - before
      })
    }
    const high = await carsSent('high')
    const low = await carsSent('low')

    expect(high).toBeGreaterThan(2)
    expect(low).toBeGreaterThan(0)
    expect(low).toBeLessThan(high * 0.7)
  })

  test('is not on offer in the top bar of a wall, which has no bar', async ({ town, page }) => {
    await town.open('&wall=1')
    await expect(page.locator('#quality-button')).toBeHidden()
  })
})

test.describe('Dusk', () => {
  const elevation = (page: Page) => city<number>(page, 'c => { const s = c.stage.sun.position, t = c.stage.sun.target.position; return Math.atan2(s.y - t.y, Math.hypot(s.x - t.x, s.z - t.z)) }')

  test('makes lit windows glow more and lowers the sun, and Day puts both back', async ({ town, page }) => {
    await town.open()
    await town.step(3)
    const day = { glow: await city<number>(page, 'c => c.windowGlow()'), sun: await elevation(page) }
    expect(day.glow).toBeCloseTo(1, 1)

    await page.locator('#lighting').click()
    await town.step(3)
    const dusk = { glow: await city<number>(page, 'c => c.windowGlow()'), sun: await elevation(page) }
    expect(dusk.glow).toBeGreaterThan(2)
    expect(dusk.sun).toBeLessThan(day.sun * 0.7)
    expect(dusk.sun).toBeGreaterThan(0.15)

    await page.locator('#lighting').click()
    await town.step(3)
    expect(await city<number>(page, 'c => c.windowGlow()')).toBeCloseTo(1, 1)
    expect(await elevation(page)).toBeCloseTo(day.sun, 1)
  })

  test('moves toward the glow over about a second rather than jumping', async ({ town, page }) => {
    await town.open()
    await page.locator('#lighting').click()
    await town.step(0.3)
    const part = await city<number>(page, 'c => c.windowGlow()')
    expect(part).toBeGreaterThan(1)
    expect(part).toBeLessThan(2.5)
  })

  test('the town still has a sun that casts shadows at Dusk', async ({ town, page }) => {
    await town.open('&light=dusk')
    await town.step(3)
    expect(await city<number>(page, 'c => c.stage.sun.intensity')).toBeGreaterThanOrEqual(1.5)
    expect(await city<number>(page, 'c => c.stage.renderer.toneMappingExposure')).toBeGreaterThanOrEqual(0.95)
  })
})

test.describe('a server with one town', () => {
  test('has no town switcher', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#town-button')).toHaveCount(0)
    expect(await city<unknown[]>(page, 'c => c.towns()')).toHaveLength(1)
  })

  test('lists its one town', async ({ request }) => {
    const r = await request.get(`${process.env.E2E_API_URL ?? `http://127.0.0.1:${process.env.E2E_API_PORT ?? 5290}`}/api/towns`)
    expect(await r.json()).toEqual([{ id: 'mini-town', name: 'Mini Town', isDefault: true }])
  })
})
