import { readFileSync } from 'node:fs'
import { test, expect } from '../support/test'
import type { Town, Status } from '../support/city'

// The three themes, each drawing the two sample towns for real: every kind of building, every signal (beacons, floors, dead letters, backlog,
// weather, tenant yards, service pads) on a bad day, traffic, the picker that switches between them, and the words of the legend.

const contract = JSON.parse(readFileSync(new URL('../../../../shared-test-data/themes/theme-contract.json', import.meta.url), 'utf8')) as {
  themes: string[]
  buildingKinds: string[]
  beacons: Record<string, string>
}

const SHOP = 'droid-shop'

const THEME_NAMES: Record<string, string> = { 'harbour-town': 'Harbour town', space: 'Space colony', factory: 'Works' }
const OWN_WORDS: Record<string, string> = { 'harbour-town': 'Blue car', space: 'Hover pod', factory: 'Blue-cab van' }

async function kindsOf(town: Town): Promise<{ kinds: Set<string>; all: Status[] }> {
  const all = await town.allBuildings()
  return { kinds: new Set(all.map((b) => b.kind)), all }
}

// what lands at the airport in each theme
const AIRPORT_LOOK: Record<string, string> = { 'harbour-town': 'airliner', factory: 'cargo plane', space: 'saucer' }

for (const theme of contract.themes) {
  test.describe(`the ${theme} theme`, () => {
    test('opens from the address, builds the town under its own colours, and logs no errors', async ({ town, page }) => {
      await town.open(`&theme=${theme}`)
      expect(await page.evaluate(() => (window as any).city.themeId())).toBe(theme)
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
      await expect(page.locator('#theme-button')).toContainText(THEME_NAMES[theme])
      // the colours the page was built with are this theme's, and the beacons are the contract's in every theme
      const palette = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).city.palette())))
      expect(palette.beacon).toMatchObject(contract.beacons)
      expect(await page.evaluate(() => (window as any).city.hasStars())).toBe(theme === 'space')
      expect(await page.evaluate(() => (window as any).city.seen.rejected)).toBe(0)
    })

    test('the airport is the theme\'s own: its own craft arrive and land', async ({ town, page }) => {
      await town.open(`&theme=${theme}`)
      await town.step(60)
      const a = await page.evaluate(() => (window as any).city.inspectAirport())
      expect(a.look).toBe(AIRPORT_LOOK[theme])
      expect(a.landed).toBeGreaterThan(0)
      expect(a.planes).toBeLessThanOrEqual(4)
    })

    test('draws every kind of building, across the two sample towns', async ({ town }) => {
      const seen = new Set<string>()
      for (const id of [null, SHOP]) {
        town.townId = id
        await town.open(`&theme=${theme}`)
        const { kinds, all } = await kindsOf(town)
        for (const k of kinds) seen.add(k)
        expect(all.length).toBeGreaterThan(20)
        // each one is lit, has floors, a beacon, and is readable: green on a calm day
        for (const b of all) {
          // a data store with a database for each tenant is a yard of units, not floors
          if (!b.tenants) expect.soft(b.floors, `${b.id} floors`).toBeGreaterThan(0)
          expect.soft(b.beacon, `${b.id} beacon`).toBe('green')
        }
      }
      expect([...seen].sort()).toEqual([...contract.buildingKinds].sort())
    })

    test('keeps every signal readable on a bad day', async ({ town, page }) => {
      await town.open(`&theme=${theme}`)
      await town.step(5)
      const yard0 = await town.yard('cl.ledger-db')
      const tenant = yard0.units[0].id

      await town.effect('cl.ledger-api', 'Down')
      await town.effect('pay.payments-api', 'Errors', 0.8)
      await town.effect('pay.refunds-worker', 'UnhealthyInstances', 0.5)
      await town.effect('cl.posting-worker', 'Poison')
      await town.effect('pay.payments-worker', 'Backlog')
      await town.effect('cl.session-cache', 'Stale')
      await town.effect(`cl.ledger-db#${tenant}`, 'Saturate')
      await town.effect('frd', 'Incident', 0.9)
      await town.until('cl.ledger-api', (n) => n.state === 'Down')
      await town.until('cl.posting-worker', (n) => (n.deadLetters ?? 0) >= 20)
      await town.until('pay.payments-worker', (n) => (n.oldestMessageSeconds ?? 0) >= 60)
      await page.waitForFunction(() => (window as any).city.seen.last.groups.find((g: any) => g.id === 'frd').incidents.length > 0, null, { timeout: 20_000 })
      await town.step(20)

      // down: a steady red light, a closed sign, every floor dark
      const down = await town.inspect('cl.ledger-api')
      expect(down).toMatchObject({ beacon: 'red', beaconSteady: true, closedSign: true })
      expect(down.darkFloors).toBe(down.floors)
      // failing requests: red, on that system only
      expect((await town.inspect('pay.payments-api')).beacon).toBe('red')
      expect((await town.inspect('pay.refunds-api')).beacon).toBe('green')
      // sick instances: dark floors, in the same share
      expect((await town.inspect('pay.refunds-worker')).darkFloors).toBeGreaterThan(0)
      // no fresh data: grey, never healthy
      expect((await town.inspect('cl.session-cache')).beacon).toBe('grey')
      // dead letters: the pen, and the harbour light
      const cl = await town.island('cl')
      expect(cl.alarm).toBe(true)
      expect(cl.brokenCrates).toBeGreaterThan(0)
      await expect(page.locator('#topbar .chip.dlq')).toHaveClass(/bad/)
      // a backlog: crates on the pier
      expect((await town.island('pay')).crates).toBeGreaterThan(0)
      // an incident: weather over that island only
      const sky = (id: string) => page.evaluate((i) => (window as any).city.inspectIsland(i).sky, id)
      expect((await sky('frd')).severity).toBe(1)
      expect((await sky('cl')).severity).toBeNull()
      // a throttled tenant: its unit turns from the calm colour
      const yard = await town.yard('cl.ledger-db')
      expect(yard.units.find((u) => u.id === tenant)!.throttled).toBe(true)
      expect(yard.sign.text).toContain('1 throttled')
      // the services keep their signs, and their worst state
      const services = await town.services('pay')
      expect(services.length).toBeGreaterThan(0)
      expect(services.some((s) => s.state === 'Down' || s.state === 'Degraded')).toBe(true)

      await town.removeEffects()
    })

    test('sends cars over the bridges and boats along the sea lanes', async ({ town, page }) => {
      await town.open(`&theme=${theme}`)
      await town.effect('*', 'Traffic')
      await town.step(10)
      const most = await town.mostBoats(40)
      expect(most).toBeGreaterThan(0)
      const cars = await page.evaluate(() => (window as any).city.drawnCars())
      expect(cars.sent).toBeGreaterThan(5)
      expect(cars.drawn).toBeGreaterThan(0)
    })

    test('words the legend for what it draws, and keeps the meaning of every colour', async ({ town, page }) => {
      await town.open(`&theme=${theme}&legend=1`)
      await expect(page.locator('#legend')).toBeVisible()
      await expect(page.locator('#legend [data-id="car"]')).toContainText(OWN_WORDS[theme])
      await expect(page.locator('#legend [data-id="beacon-red"] .swatch')).toHaveClass(/red/)
      await expect(page.locator('#legend [data-id="grey"] .swatch')).toHaveClass(/grey/)
      expect(await page.locator('#legend .entry').count()).toBeGreaterThanOrEqual(29)
    })

    test('shows Day and Dusk, and Dusk lights the windows brighter', async ({ town, page }) => {
      await town.open(`&theme=${theme}&light=day`)
      const day = await page.evaluate(() => (window as any).city.windowGlow())
      await page.locator('#lighting').click()
      await town.step(3)
      expect(await page.evaluate(() => (window as any).city.stage.lightingProgress)).toBe(1)
      expect(await page.evaluate(() => (window as any).city.lighting())).toBe('dusk')
      expect(await page.evaluate(() => (window as any).city.windowGlow())).toBeGreaterThan(day)
    })
  })
}

test.describe('the theme picker', () => {
  test('lists the three themes', async ({ town, page }) => {
    await town.open()
    await page.locator('#theme-button').click()
    await expect(page.locator('#theme-list .vb-row')).toHaveText([/Harbour town/, /Space colony/, /Works/])
    await expect(page.locator('#theme-list .vb-row.sel')).toContainText('Harbour town')
  })

  for (const next of ['space', 'factory']) {
    test(`switching to ${next} builds the town again in that theme, puts it in the address and is remembered`, async ({ town, page }) => {
      await town.open()
      expect(await page.evaluate(() => (window as any).city.themeId())).toBe('harbour-town')
      await page.locator('#theme-button').click()
      await Promise.all([
        page.waitForURL(new RegExp(`theme=${next}`)),
        page.locator(`#theme-list .vb-row[data-id="${next}"]`).click(),
      ])
      await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
      expect(await page.evaluate(() => (window as any).city.themeId())).toBe(next)
      expect(await page.evaluate(() => (window as any).city.palette().island.grass)).not.toBe('#8bd05f')
      expect(await page.evaluate(() => (window as any).city.town.buildings.size)).toBeGreaterThan(20)
      expect(await page.evaluate(() => localStorage.getItem('oc.theme'))).toBe(next)

      // a page opened with no theme in the address comes back in the one this browser last chose
      await page.goto('/?test=1&quality=low')
      await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
      expect(await page.evaluate(() => (window as any).city.themeId())).toBe(next)
    })
  }

  test('the address wins over what the browser remembered, and keeps the theme through the island filter', async ({ town, page }) => {
    await town.open('&theme=space')
    await page.goto('/?test=1&quality=low&theme=factory')
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    expect(await page.evaluate(() => (window as any).city.themeId())).toBe('factory')
    const islands = (await page.evaluate(() => (window as any).city.islandChoices())) as { id: string }[]
    await page.evaluate((id) => (window as any).city.setIslands([id]), islands[0].id)
    expect(page.url()).toContain('theme=factory')
    expect(page.url()).toContain(`islands=${islands[0].id}`)
  })

  test('a theme that does not exist is said so, and the harbour town is shown', async ({ town, page }) => {
    await town.open('&theme=castle')
    await expect(page.locator('#banner')).toContainText('no theme "castle"')
    expect(await page.evaluate(() => (window as any).city.themeId())).toBe('harbour-town')
  })

  test('picking the theme already shown does nothing', async ({ town, page }) => {
    await town.open('&theme=space')
    await page.locator('#theme-button').click()
    await page.locator('#theme-list .vb-row[data-id="space"]').click()
    await town.step(1)
    expect(page.url()).toContain('theme=space')
    expect(await page.evaluate(() => (window as any).city.themeId())).toBe('space')
  })
})
