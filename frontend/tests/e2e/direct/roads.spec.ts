import { test, expect } from '../support/test'
import type { Page } from '@playwright/test'

// In a town whose islands call each other directly nothing goes through the central island: islands reach each other, the airport and the third
// parties over the outer ring road. direct-town: Alpha, Beta and Gamma, all with an API and calls between them, and a hub that nothing calls.

interface Roads {
  direct: boolean
  hubBridges: string[]
  ringBridges: string[]
  airport: 'ring' | 'hub' | null
  ringRoad: boolean
  loopRadius: number
  routesThroughHub: number
  routes: number
}

const roads = (page: Page) => page.evaluate(() => (window as any).city.town.inspectRoads()) as Promise<Roads>

/** The routes that run from a system on one island to a system on another, with the farthest they get from the hub's centre. */
const crossIsland = (page: Page) =>
  page.evaluate(() => {
    const t = (window as any).city.town
    const islandOf = (id: string) => id.split('.')[0]
    const ids = new Map<any, string>([...t.buildings].map(([id, b]: [string, any]) => [b, id]))
    return t.cars.routeList
      .map((r: any) => ({ from: ids.get(r.source) ?? 'airport', to: r.dest.id as string, origin: r.origin as string, far: Math.max(...r.path.map((p: any) => Math.hypot(p.x, p.z))) }))
      .filter((r: any) => r.from === 'airport' || islandOf(r.from) !== islandOf(r.to))
  }) as Promise<{ from: string; to: string; origin: string; far: number }[]>

test.describe('a town without a hub in between', () => {
  test('every island has a bridge to the ring road and none to the central island', async ({ town, page }) => {
    await town.open()
    const r = await roads(page)

    expect(r.direct).toBe(true)
    expect(r.ringRoad).toBe(true)
    expect(r.ringBridges.sort()).toEqual(['aa', 'bb', 'cc'])
    expect(r.hubBridges).toEqual([])
  })

  test('the airport is on the ring road, not on a spoke of the central island', async ({ town, page }) => {
    await town.open()

    expect((await roads(page)).airport).toBe('ring')
    expect(await page.evaluate(() => (window as any).city.inspectAirport().bridge)).toBe(true)
  })

  test('calls between islands drive out of the back gate and round the ring road', async ({ town, page }) => {
    await town.open()
    const r = await roads(page)
    const calls = (await crossIsland(page)).filter((c) => c.from !== 'airport')

    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.far, `${c.from} to ${c.to}`).toBeGreaterThanOrEqual(r.loopRadius - 1)
  })

  test('outside callers come in from the airport and drive round the ring road to the island', async ({ town, page }) => {
    await town.open()
    const r = await roads(page)
    const arrivals = (await crossIsland(page)).filter((c) => c.from === 'airport')

    expect(arrivals.length).toBeGreaterThan(0)
    for (const c of arrivals) {
      expect(c.origin).toBe('external')
      expect(c.far, `airport to ${c.to}`).toBeGreaterThanOrEqual(r.loopRadius - 1)
    }
  })

  test('no car route between islands, the airport or the third parties drives over the central island', async ({ town, page }) => {
    await town.open()

    const r = await roads(page)
    expect(r.routes).toBeGreaterThan(0)
    expect(r.routesThroughHub).toBe(0)
  })

  test('the central island has no spoke roads: its bridges are only for what it really holds', async ({ town, page }) => {
    await town.open()

    expect((await roads(page)).hubBridges).toEqual([])
    expect((await town.hub())).toMatchObject({ topics: 3 })
  })

  test('cars really appear on the ring road', async ({ town, page }) => {
    await town.open()
    await town.effect('*', 'Traffic')
    const r = await roads(page)
    await town.step(20)
    const farthest = await page.evaluate(() => {
      const c = (window as any).city
      let far = 0
      for (let i = 0; i < 600; i++) {
        c.step(0.2)
        for (const car of c.town.cars.cars) far = Math.max(far, Math.hypot(car.x, car.z))
      }
      return far
    })

    expect(farthest).toBeGreaterThanOrEqual(r.loopRadius - 2)
  })
})
