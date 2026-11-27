import { test, expect } from '../support/test'

// Where a car came from and where it is going, on mini-town: a card for the car under the pointer, a click to keep it, and small signs on the nearest cars once
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

  test('pointing at a car shows both ends and its route, and nothing else on the screen says it', async ({ town, page }) => {
    await town.open()
    await drive(page)
    const at = await aCar(page)
    await page.mouse.move(at.x, at.y)
    const shown = await page.evaluate(() => { const c = (window as any).city; c.step(0.02, 0.02); return { ...c.carSigns.shown(), route: c.town.cars.highlighted, far: c.stage.camera.position.distanceTo(c.stage.controls.target) } })

    expect(shown.card).toMatch(/^\S+ → \S+$/)
    expect(shown.route).toBeGreaterThanOrEqual(0)
    expect(shown.far).toBeGreaterThan(70) // from the air: a card, but no signs over the other cars
    expect(shown.signs).toEqual([])
  })

  test('the card names the real ends of the request: the system it comes from (or outside) and the system it goes to', async ({ town, page }) => {
    await town.open()
    await drive(page)
    const at = await aCar(page)
    await page.mouse.move(at.x, at.y)
    const both = await page.evaluate(() => {
      const c = (window as any).city
      c.step(0.02, 0.02)
      const id = c.carSigns.hovered
      const car = c.town.cars.find(id)
      const ids = c.inspectRoutes().map((r: any) => `${r.source ?? 'outside'} → ${r.dest}`)
      return { card: c.carSigns.shown().card, to: car.to.node.id, from: car.from?.node?.id ?? null, ids }
    })
    const [from, to] = both.card!.split(' → ')
    expect(both.card).not.toContain('?')
    expect(to).toContain('.')
    expect(from === 'outside' || from.includes('.')).toBe(true)
    expect(both.ids).toContain(`${both.from ?? 'outside'} → ${both.to}`)
  })

  test('a click keeps the card on that car until the next click', async ({ town, page }) => {
    await town.open()
    await drive(page)
    const at = await aCar(page)
    await page.mouse.move(at.x, at.y)
    await page.evaluate(() => (window as any).city.step(0.02, 0.02))
    await page.mouse.click(at.x, at.y)
    const kept = await page.evaluate(() => { const c = (window as any).city; c.step(1, 0.1); return c.carSigns.shown() })
    expect(kept.pinned).toBe(true)
    expect(kept.card).toMatch(/→/)

    await page.mouse.move(5, 5)
    await page.mouse.click(5, 5)
    const let_go = await page.evaluate(() => { const c = (window as any).city; c.step(0.1); return c.carSigns.shown() })
    expect(let_go.pinned).toBe(false)
    expect(let_go.card).toBeNull()
  })

  test('close up, the cars nearest the middle carry a "from → to" sign, at most eight', async ({ town, page }) => {
    await town.open()
    await drive(page)
    const near = await page.evaluate(() => {
      const c = (window as any).city
      const car = c.town.cars.nearest(0, 0, 1e6, 1)[0]
      c.stage.focus(new c.THREE.Vector3(car.x, 0, car.z), 30, true)
      for (let i = 0; i < 10; i++) c.step(0.1)
      return { ...c.carSigns.shown(), distance: c.stage.camera.position.distanceTo(c.stage.controls.target) }
    })
    expect(near.distance).toBeLessThan(70)
    expect(near.signs.length).toBeGreaterThan(0)
    expect(near.signs.length).toBeLessThanOrEqual(8)
    for (const s of near.signs) expect(s).toMatch(/^\S+ → \S+$/)
  })
})
