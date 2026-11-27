import { test, expect } from '../support/test'

// Where a car came from and where it is going, on mini-town: nothing on hover, a click for a card with the route, and small signs on the nearest cars once
// the camera is close. The page is told where a car is, since cars move; the test reads the text the page shows, not pixels.

test.describe('car signs', () => {
  async function drive(page: import('@playwright/test').Page): Promise<void> {
    await page.evaluate(() => { const c = (window as any).city; for (let i = 0; i < 80; i++) c.step(0.5) })
  }
  /** The screen position (page pixels) of the car nearest the middle of the town, after letting the traffic settle. */
  async function aCar(page: import('@playwright/test').Page): Promise<{ x: number; y: number }> {
    return page.evaluate(() => {
      const c = (window as any).city
      const car = c.town.cars.nearest(0, 0, 1e6, 1)[0]
      const v = new c.THREE.Vector3(car.x, car.y, car.z).project(c.stage.camera)
      return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight }
    })
  }

  test('pointing at a car shows nothing: no card, no route, no rings', async ({ town, page }) => {
    await town.open()
    await drive(page)
    const at = await aCar(page)
    await page.mouse.move(at.x, at.y)
    const shown = await page.evaluate(() => { const c = (window as any).city; c.step(0.02, 0.02); return { ...c.carSigns.shown(), route: c.town.cars.highlighted } })

    expect(shown.card).toBeNull()
    expect(shown.route).toBe(-1)
    expect(shown.signs).toEqual([])
  })

  test('a click shows both ends and the route of that car, from the air too, with no other sign on screen', async ({ town, page }) => {
    await town.open()
    await drive(page)
    const at = await aCar(page)
    await page.mouse.move(at.x, at.y)
    await page.mouse.click(at.x, at.y)
    const shown = await page.evaluate(() => {
      const c = (window as any).city
      c.step(0.02, 0.02)
      const car = c.town.cars.find(c.carSigns.pinned)
      return { ...c.carSigns.shown(), route: c.town.cars.highlighted, pinnedId: c.carSigns.pinned, to: car?.to.node.id, from: car?.from?.node?.id ?? null, far: c.stage.camera.position.distanceTo(c.stage.controls.target), ids: c.inspectRoutes().map((r: any) => `${r.source ?? 'outside'} → ${r.dest}`) }
    })

    expect(shown.pinned).toBe(true)
    expect(shown.card).toMatch(/^\S+ → \S+$/)
    expect(shown.card).not.toContain('?')
    expect(shown.route).toBe(shown.pinnedId)
    expect(shown.far).toBeGreaterThan(200) // from the air: a card, but no signs over the other cars
    expect(shown.signs).toEqual([])
    expect(shown.ids).toContain(`${shown.from ?? 'outside'} → ${shown.to}`) // the real ends of a real route
  })

  test('a second click on the car, or a click anywhere else, lets go', async ({ town, page }) => {
    await town.open()
    await drive(page)
    const again = async (): Promise<{ x: number; y: number }> => {
      const at = await page.evaluate(() => { const c = (window as any).city; const car = c.town.cars.find(c.carSigns.pinned); const v = new c.THREE.Vector3(car.x, car.y, car.z).project(c.stage.camera); return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight } })
      return at
    }
    const at = await aCar(page)
    await page.mouse.click(at.x, at.y)
    await page.evaluate(() => (window as any).city.step(0.5, 0.1))
    expect((await page.evaluate(() => (window as any).city.carSigns.shown())).pinned).toBe(true)

    const on = await again()
    await page.mouse.click(on.x, on.y)
    expect((await page.evaluate(() => { const c = (window as any).city; c.step(0.1); return c.carSigns.shown() })).pinned).toBe(false)

    await page.mouse.click(at.x, at.y)
    await page.evaluate(() => (window as any).city.step(0.5, 0.1))
    await page.mouse.click(5, 5)
    const gone = await page.evaluate(() => { const c = (window as any).city; c.step(0.1); return { ...c.carSigns.shown(), route: c.town.cars.highlighted } })
    expect(gone.pinned).toBe(false)
    expect(gone.card).toBeNull()
    expect(gone.route).toBe(-1)
  })

  test('close up, the cars nearest the middle carry a "from → to" sign, at most eight', async ({ town, page }) => {
    await town.open()
    await drive(page)
    const near = await page.evaluate(() => {
      const c = (window as any).city
      const car = c.town.cars.nearest(0, 0, 1e6, 1)[0]
      c.stage.focus(new c.THREE.Vector3(car.x, 0, car.z), 150, true)
      for (let i = 0; i < 10; i++) c.step(0.1)
      return { ...c.carSigns.shown(), distance: c.stage.camera.position.distanceTo(c.stage.controls.target) }
    })
    expect(near.distance).toBeLessThan(200)
    expect(near.signs.length).toBeGreaterThan(0)
    expect(near.signs.length).toBeLessThanOrEqual(8)
    for (const s of near.signs) expect(s).toMatch(/^\S+ → \S+$/)
  })
})
