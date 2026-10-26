import { test, expect } from '../support/test'

// The top bar, the island filter, the layer toggles, the inspector drawer, the legend card, Day/Dusk and the theme picker, on mini-town
// (islands aa Alpha, bb Beta, cc Gamma; hub-and-spoke; vendors ext.bureau (called from aa) and ext.mailer (from cc and bb)).

test.describe('the top bar', () => {
  test('has the controls, and panels start below it however many rows it wraps to', async ({ town, page }) => {
    await town.open()
    for (const id of ['#islands-button', '#layers-button', '#theme-button', '#lighting', '#legend-button', '#home', '#search-input', '#town-name'])
      await expect(page.locator(id)).toBeVisible()
    await expect(page.locator('#town-name')).toHaveText('Mini Town')
    const bar = (await page.locator('#topbar').boundingBox())!
    const panel = (await page.locator('#break-panel').boundingBox())!
    expect(panel.y).toBeGreaterThanOrEqual(bar.y + bar.height)
    for (const width of [960, 600]) {
      await page.setViewportSize({ width, height: 700 })
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      expect(wide, `the page scrolls sideways at ${width}px`).toBe(false)
      const b = (await page.locator('#topbar').boundingBox())!
      expect(b.x + b.width).toBeLessThanOrEqual(width)
    }
  })

  test('Home frames the town again', async ({ town, page }) => {
    await town.open()
    await page.evaluate(() => (window as any).city.stage.focus((window as any).city.town.root.position, 20))
    await page.locator('#home').click()
    await town.step(3)
    expect(await page.evaluate(() => (window as any).city.stage.camera.position.length())).toBeGreaterThan(40)
  })
})

test.describe('the island filter', () => {
  test('the dropdown lists every island, with the whole town as the default', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#islands-button')).toContainText('All islands')
    await page.locator('#islands-button').click()
    await expect(page.locator('#islands-list [data-act="island"]')).toHaveCount(3)
    await expect(page.locator('#islands-list')).toContainText('Alpha')
    await expect(page.locator('#islands-list')).toContainText('Gamma')
  })

  test('picking an island shows only that island and the hub, and puts the choice in the address', async ({ town, page }) => {
    await town.open()
    await page.locator('#islands-button').click()
    await page.locator('#islands-list [data-id="aa"]').click()
    await page.waitForFunction(() => (window as any).city.seen.last.view.islands.join() === 'aa')
    await expect(page.locator('#islands-button')).toContainText('Alpha')
    expect(page.url()).toContain('islands=aa')
    const shown = await page.evaluate(() => (window as any).city.seen.last.groups.map((g: any) => g.id).sort())
    expect(shown.filter((g: string) => !['aa'].includes(g) && !g.startsWith('hub'))).toEqual([])
    // the list still has the others, marked as hidden, so they can be picked back
    await expect(page.locator('#islands-list [data-id="bb"]')).toContainText('hidden')
    // picking the second adds it; "All islands" clears the choice again
    await page.locator('#islands-list [data-id="cc"]').click()
    await page.waitForFunction(() => (window as any).city.seen.last.view.islands.join() === 'aa,cc')
    await expect(page.locator('#islands-button')).toContainText('2 of 3 islands')
    await page.locator('#islands-list [data-act="all-islands"]').click()
    await page.waitForFunction(() => (window as any).city.seen.last.view.islands.length === 0)
    expect(page.url()).not.toContain('islands=')
  })

  test('?islands= opens the page already filtered', async ({ town, page }) => {
    await town.open('&islands=bb')
    expect(await page.evaluate(() => (window as any).city.islands())).toEqual(['bb'])
    expect(await page.evaluate(() => (window as any).city.seen.last.groups.some((g: any) => g.id === 'aa'))).toBe(false)
    expect(await page.evaluate(() => (window as any).city.inspectIsland('aa'))).toBeNull()
    expect(await page.evaluate(() => (window as any).city.inspectIsland('bb'))).not.toBeNull()
  })

  test('the numbers count only what is on screen, and the third parties only while a caller is', async ({ town, page }) => {
    await town.open()
    const whole = await page.evaluate(() => ({ totals: (window as any).city.seen.last.totals, vendors: (window as any).city.seen.last.vendors.map((v: any) => v.node.id).sort() }))
    expect(whole.vendors).toEqual(['ext.bureau', 'ext.mailer'])
    await town.open('&islands=aa')
    const one = await page.evaluate(() => ({ totals: (window as any).city.seen.last.totals, vendors: (window as any).city.seen.last.vendors.map((v: any) => v.node.id) }))
    expect(one.vendors).toEqual(['ext.bureau'])
    expect(one.totals.requestsPerSecond).toBeLessThan(whole.totals.requestsPerSecond)
    // the chip says the same as the snapshot
    const chip = await page.locator('#chip-requests').getAttribute('title')
    expect(chip).toContain('only the islands on screen')
  })

  test('an island the town does not have is left out and said so, and the whole town comes back', async ({ town, page }) => {
    await town.open('&islands=zz')
    await expect(page.locator('#banner')).toContainText('zz')
    await page.waitForFunction(() => (window as any).city.islands().length === 0)
    await page.waitForFunction(() => (window as any).city.seen.last.groups.filter((g: any) => !g.isHub).length === 3)
    expect(page.url()).not.toContain('zz')
  })

  test('in a hub-and-spoke town a call to a hidden island ends at the hub plaza', async ({ town, page }) => {
    // Gamma's notify API calls Alpha's and Beta's APIs through the gateway; with only Gamma on screen those cars end at the plaza
    await town.open('&islands=cc')
    await town.step(3)
    const edge = await page.evaluate(() => (window as any).city.inspectEdge())
    expect(edge.mode).toBe('plaza')
    expect(edge.plazaRoutes.length).toBeGreaterThan(0)
    for (const r of edge.plazaRoutes) {
      expect(r.from).toBe('cc.notify-api')
      expect(r.to).toBe('hub.apim')
    }
    expect(edge.signposts.every((s: any) => s.lines.length === 0)).toBe(true)
  })

  test('and a call from a hidden island starts at the plaza, not at a building that is not there', async ({ town, page }) => {
    await town.open('&islands=aa')
    await town.step(3)
    const sources = await page.evaluate(() => {
      const c = (window as any).city
      const idOf = (b: any) => [...c.town.buildings].find(([, x]: any) => x === b)?.[0] ?? null
      return c.town.cars.routeList.filter((r: any) => r.dest.id === 'aa.orders-api').map((r: any) => idOf(r.source))
    })
    expect(sources.length).toBeGreaterThan(0)
    for (const id of sources) expect(String(id)).not.toMatch(/^(bb|cc)\./)
  })

  test('searching the list finds an island by a part of its name', async ({ town, page }) => {
    await town.open()
    await page.locator('#islands-button').click()
    await page.locator('#island-query').fill('gam')
    await expect(page.locator('#islands-list [data-act="island"]')).toHaveCount(1)
    await expect(page.locator('#islands-list [data-act="island"]')).toContainText('Gamma')
  })
})

test.describe('the layers', () => {
  test('all are on but Dependencies, and the button says nothing is off', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#layers-button')).toContainText(/^Layers\s/)
    await expect(page.locator('#layers-button')).not.toContainText('off')
    await page.locator('#layers-button').click()
    for (const l of ['traffic', 'messaging', 'databases', 'workers'])
      await expect(page.locator(`#layer-${l} input`)).toBeChecked()
    await expect(page.locator('#layer-dependencies input')).not.toBeChecked()
  })

  test('Traffic off stops the cars, and on again brings them back', async ({ town, page }) => {
    await town.open()
    await town.step(8)
    expect((await page.evaluate(() => (window as any).city.inspectLayers())).cars).toBeGreaterThan(0)
    await page.locator('#layers-button').click()
    await page.locator('#layer-traffic').click()
    await town.step(3)
    expect((await page.evaluate(() => (window as any).city.inspectLayers())).cars).toBe(0)
    await expect(page.locator('#layers-button')).toContainText('1 off')
    expect(page.url()).toContain('hide=traffic')
    await page.locator('#layer-traffic').click()
    await town.step(8)
    expect((await page.evaluate(() => (window as any).city.inspectLayers())).cars).toBeGreaterThan(0)
    expect(page.url()).not.toContain('hide=')
  })

  test('Databases off hides the stores, and they cannot be hovered or clicked', async ({ town, page }) => {
    await town.open()
    const before = await page.evaluate(() => (window as any).city.town.hitMeshes().length)
    await page.locator('#layers-button').click()
    await page.locator('#layer-databases').click()
    const layers = await page.evaluate(() => (window as any).city.inspectLayers())
    expect(layers.hiddenBuildings).toEqual(expect.arrayContaining(['aa.orders-db', 'bb.ledger-db', 'cc.notify-db', 'hub.customer-db']))
    expect(layers.hiddenBuildings).not.toContain('aa.orders-api')
    expect(await page.evaluate(() => (window as any).city.town.hitMeshes().length)).toBeLessThan(before)
  })

  test('Workers off hides the workers and nothing else', async ({ town, page }) => {
    await town.open()
    await page.locator('#layers-button').click()
    await page.locator('#layer-workers').click()
    const hidden = (await page.evaluate(() => (window as any).city.inspectLayers())).hiddenBuildings as string[]
    expect(hidden.sort()).toEqual(['aa.orders-worker', 'bb.ledger-worker', 'cc.notify-worker'])
  })

  test('Messaging off hides the boats, the harbours and the lighthouse', async ({ town, page }) => {
    await town.open()
    await town.step(10)
    const on = await page.evaluate(() => (window as any).city.inspectLayers())
    expect(on.boatsDrawn).toBe(true)
    expect(on.harbours.every((h: boolean) => h)).toBe(true)
    await page.locator('#layers-button').click()
    await page.locator('#layer-messaging').click()
    await town.step(2)
    const off = await page.evaluate(() => (window as any).city.inspectLayers())
    expect(off.boatsDrawn).toBe(false)
    expect(off.boats).toBe(0)
    expect(off.harbours.some((h: boolean) => h)).toBe(false)
    expect(off.lighthouse).not.toBe(true)
  })

  test('the layers in the address are the layers on the page', async ({ town, page }) => {
    await town.open('&hide=traffic,workers&show=dependencies')
    const layers = (await page.evaluate(() => (window as any).city.inspectLayers())).layers
    expect(layers).toEqual({ traffic: false, messaging: true, databases: true, workers: false, dependencies: true })
    await expect(page.locator('#layers-button')).toContainText('2 off')
    expect((await page.evaluate(() => (window as any).city.overlay())).visible).toBe(true)
  })

  test('layers keep working after the island filter changes the town', async ({ town, page }) => {
    await town.open('&hide=databases')
    await page.locator('#islands-button').click()
    await page.locator('#islands-list [data-id="aa"]').click()
    await page.waitForFunction(() => (window as any).city.seen.last.view.islands.join() === 'aa')
    await town.step(1)
    const hidden = (await page.evaluate(() => (window as any).city.inspectLayers())).hiddenBuildings as string[]
    expect(hidden).toContain('aa.orders-db')
  })
})

test.describe('the inspector drawer', () => {
  async function openByName(page: import('@playwright/test').Page, name: string) {
    // empty first, so typing the same words again still opens the list
    await page.locator('#search-input').fill('')
    await page.locator('#search-input').fill(name)
    await page.locator('#search-results .hit').first().click()
    await page.waitForFunction(() => (window as any).city.inspector().id !== null)
  }

  test('search opens it on the Overview of the system, with its numbers', async ({ town, page }) => {
    await town.open()
    await openByName(page, 'Orders API')
    expect(await page.evaluate(() => (window as any).city.inspector())).toEqual({ id: 'aa.orders-api', tab: 'overview' })
    await expect(page.locator('#inspector')).toBeVisible()
    await expect(page.locator('#inspector .head')).toContainText('Orders API')
    await expect(page.locator('#inspector .head')).toContainText('Alpha')
    await expect(page.locator('#inspector .rows')).toContainText('Requests')
    await expect(page.locator('#inspector .rows')).toContainText('p99 / SLA')
    await expect(page.locator('#inspector .fine')).toBeVisible()
  })

  test('says in words why a system is not healthy', async ({ town, page }) => {
    await town.open()
    await openByName(page, 'Orders API')
    await town.effect('aa.orders-api', 'Errors', 1)
    await town.until('aa.orders-api', (n) => n.errorRate > 0.05)
    await expect(page.locator('#inspector .why li').first()).toContainText(/Errors are at/)
    await expect(page.locator('#inspector .why li').first()).toContainText('past the')
  })

  test('says a system with no fresh data has none, and shows no numbers for it', async ({ town, page }) => {
    await town.open()
    await openByName(page, 'Notify API')
    await town.effect('cc.notify-api', 'Stale')
    await town.until('cc.notify-api', (n) => n.state === 'Stale')
    await expect(page.locator('#inspector .why li')).toContainText('No fresh data')
    await expect(page.locator('#inspector .rows')).toContainText('none fresh')
  })

  test('Links lists who it calls and who calls it, and a click opens that system', async ({ town, page }) => {
    await town.open()
    await openByName(page, 'Orders API')
    await page.locator('#inspector [data-tab="links"]').click()
    await expect(page.locator('#inspector .body')).toContainText('Calls')
    await expect(page.locator('#inspector .body')).toContainText('Orders DB')
    await expect(page.locator('#inspector .body')).toContainText('Called from outside')
    await expect(page.locator('#inspector .body')).toContainText('Mobile app')
    await expect(page.locator('#inspector .body')).toContainText('Credit bureau')
    await page.locator('#inspector .link[data-go="aa.orders-db"]').click()
    await page.waitForFunction(() => (window as any).city.inspector().id === 'aa.orders-db')
    await expect(page.locator('#inspector .head')).toContainText('Orders DB')
  })

  test('a link to a system the island filter hides says so and does not open', async ({ town, page }) => {
    await town.open('&islands=aa')
    await openByName(page, 'Orders API')
    await page.locator('#inspector [data-tab="links"]').click()
    const gateway = page.locator('#inspector .link.off')
    await expect(gateway.first()).toContainText('not on screen')
    await gateway.first().click()
    expect(await page.evaluate(() => (window as any).city.inspector().id)).toBe('aa.orders-api')
  })

  test('Logs shows the latest lines, narrows to errors, and follows new ones', async ({ town, page }) => {
    await town.open()
    await openByName(page, 'Orders API')
    await page.locator('#inspector [data-tab="logs"]').click()
    await expect(page.locator('#inspector .log').first()).toBeVisible()
    const calm = await page.locator('#inspector .log.error').count()
    await town.effect('aa.orders-api', 'Errors', 1)
    await town.until('aa.orders-api', (n) => n.errorRate > 0.05)
    await expect.poll(() => page.locator('#inspector .log.error').count(), { timeout: 15_000 }).toBeGreaterThan(calm)
    await page.locator('#inspector [data-level="error"]').click()
    expect(await page.locator('#inspector .log:not(.error)').count()).toBe(0)
    await page.locator('#inspector [data-level="warn"]').click()
    expect(await page.locator('#inspector .log.info').count()).toBe(0)
  })

  test('Config lists each value with the file layer it comes from, and the file', async ({ town, page }) => {
    await town.open()
    await openByName(page, 'Orders API')
    await page.locator('#inspector [data-tab="config"]').click()
    await expect(page.locator('#inspector .body')).toContainText('aa.yaml')
    const role = page.locator('#inspector .cfg-row[data-key="role"]')
    await expect(role).toContainText('api')
    await expect(role.locator('.o')).toHaveText('this system')
    // a value nobody set comes from the defaults, and says so
    const origins = await page.locator('#inspector .cfg .o').allTextContents()
    expect(origins.some((o) => o === 'defaults.yaml' || o === 'built in' || o === 'pillar defaults')).toBe(true)
    // the ones the system sets itself are listed first
    expect(origins[0]).toBe('this system')
  })

  test('closes with the cross, with Escape, and with a click on the sea', async ({ town, page }) => {
    await town.open()
    await openByName(page, 'Orders API')
    await page.locator('#inspector-close').click()
    await expect(page.locator('#inspector')).toBeHidden()
    await openByName(page, 'Orders API')
    await page.keyboard.press('Escape')
    await expect(page.locator('#inspector')).toBeHidden()
    await openByName(page, 'Orders API')
    await page.mouse.click(4, 590)
    await expect(page.locator('#inspector')).toBeHidden()
    expect(await page.evaluate(() => (window as any).city.inspector().id)).toBeNull()
  })

  test('opening a system closes a service panel, and opening a service closes the drawer', async ({ town, page }) => {
    await town.open()
    await openByName(page, 'Orders API')
    await page.evaluate(() => (window as any).city.openService('aa/orders'))
    await expect(page.locator('#service-panel')).toBeVisible()
    await expect(page.locator('#inspector')).toBeHidden()
    await openByName(page, 'Orders API')
    await expect(page.locator('#service-panel')).toBeHidden()
    await expect(page.locator('#inspector')).toBeVisible()
  })

  test('closes by itself when the system leaves the town', async ({ town, page }) => {
    await town.open()
    await openByName(page, 'Orders API')
    await page.locator('#islands-button').click()
    await page.locator('#islands-list [data-id="bb"]').click()
    await page.waitForFunction(() => (window as any).city.inspector().id === null)
    await expect(page.locator('#inspector')).toBeHidden()
  })

  test('a state list click opens it too', async ({ town, page }) => {
    await town.open()
    await town.effect('cc.notify-api', 'Down')
    await town.until('cc.notify-api', (n) => n.state === 'Down')
    await page.locator('[data-list="Down"]').click()
    await page.locator('#state-list .hit').first().click()
    await page.waitForFunction(() => (window as any).city.inspector().id === 'cc.notify-api')
    await expect(page.locator('#inspector .why li')).toContainText('Down')
  })
})

test.describe('the legend', () => {
  test('is closed in automated runs, and the question mark opens and closes it', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#legend')).toBeHidden()
    await page.locator('#legend-button').click()
    await expect(page.locator('#legend')).toBeVisible()
    await expect(page.locator('#legend')).toContainText('Red beacon')
    await expect(page.locator('#legend')).toContainText('Dead letters')
    await page.locator('#legend-button').click()
    await expect(page.locator('#legend')).toBeHidden()
    await page.locator('#legend-button').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('#legend')).toBeHidden()
  })

  test('opens by itself on a first visit and not on the next', async ({ town, page }) => {
    await town.open('&legend=first')
    await expect(page.locator('#legend')).toBeVisible()
    await page.locator('#legend-close').click()
    await page.goto('/?test=1&quality=low&legend=first')
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    await expect(page.locator('#legend')).toBeHidden()
  })

  test('uses red only for errors', async ({ town, page }) => {
    await town.open()
    await page.locator('#legend-button').click()
    const red = await page.locator('#legend .swatch.red').locator('xpath=..').locator('b').allTextContents()
    expect(red.sort()).toEqual(['Broken crates in a pen, a red beam and a count', 'Red beacon', 'Red flag on a car'])
  })
})

test.describe('Day and Dusk', () => {
  test('the button switches the light, and the choice is kept for the next visit', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#lighting')).toHaveText('Day')
    await page.locator('#lighting').click()
    await expect(page.locator('#lighting')).toHaveText('Dusk')
    await town.step(6)
    expect(await page.evaluate(() => (window as any).city.lighting())).toBe('dusk')
    expect(await page.evaluate(() => document.documentElement.dataset.lighting)).toBe('dusk')
    await page.goto('/?test=1&quality=low')
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    expect(await page.evaluate(() => (window as any).city.lighting())).toBe('dusk')
    // the address wins over what the browser remembers
    await page.goto('/?test=1&quality=low&light=day')
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    expect(await page.evaluate(() => (window as any).city.lighting())).toBe('day')
    await page.evaluate(() => localStorage.clear())
  })

  test('Dusk really changes the sky and the sea, and Day brings them back', async ({ town, page }) => {
    await town.open()
    const colours = () => page.evaluate(() => { const s = (window as any).city.stage; return { fog: s.scene.fog.color.getHexString(), exposure: s.renderer.toneMappingExposure } })
    const day = await colours()
    await page.locator('#lighting').click()
    await town.step(6)
    const dusk = await colours()
    expect(dusk.fog).not.toBe(day.fog)
    await page.locator('#lighting').click()
    await town.step(6)
    expect((await colours()).fog).toBe(day.fog)
    await page.evaluate(() => localStorage.clear())
  })
})

test.describe('the theme picker', () => {
  test('lists the themes and names the one in use', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#theme-button')).toContainText('Harbour town')
    await page.locator('#theme-button').click()
    await expect(page.locator('#theme-list .vb-row.sel')).toContainText('Harbour town')
    await page.locator('#theme-list .vb-row').first().click()
    expect(await page.evaluate(() => (window as any).city.themeId())).toBe('harbour-town')
  })

  test('a theme the page does not have is said so and the default is shown', async ({ town, page }) => {
    await town.open('&theme=nope')
    await expect(page.locator('#banner')).toContainText('no theme "nope"')
    expect(await page.evaluate(() => (window as any).city.themeId())).toBe('harbour-town')
  })
})
