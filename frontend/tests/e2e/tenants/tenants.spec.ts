import { test, expect } from '../support/test'
import { API } from '../support/city'

// Environments, tenants and service groups on the tenants-town registry (two pillars, three environments). Everything is read from the scene's
// state (window.city), not pixels.
//
//   prod     default: acme, borealis, cygnus (customers) + smoke (test)
//   staging  acme, borealis (customers) + qa, smoke (test) + ghost-co (in the readings but not on the list)
//   dev      three test tenants; the billing pillar and the cron are left out
//
//   aa  orders service: orders-api, orders-worker, orders-db (a database for each tenant); audit-cache and tools-cron have no service
//   bb  billing service: billing-api, billing-db (a database for each tenant); shared-db has no service

const DB = 'aa.orders-db'

test.describe('environments', () => {
  test('the page shows the default environment unless it is asked for another', async ({ town, page }) => {
    await town.open()
    expect(await page.evaluate(() => (window as any).city.seen.last.environment)).toBe('prod')
    expect(await page.evaluate(() => (window as any).city.seen.last.environments.map((e: any) => e.id))).toEqual(['dev', 'staging', 'prod'])
  })

  test('?env= shows that environment, with its own tenants', async ({ town, page }) => {
    town.env = 'staging'
    await town.open()
    expect(await page.evaluate(() => (window as any).city.seen.last.environment)).toBe('staging')
    expect(await page.evaluate(() => (window as any).city.seen.last.tenants.map((t: any) => t.id))).toEqual(['acme', 'borealis', 'qa', 'smoke', 'ghost-co'])
  })

  test('an environment drops what it excludes, and its island with it when nothing is left', async ({ town }) => {
    town.env = 'staging'
    await town.open()
    expect((await town.island('bb')).buildings).toBe(3)
    expect((await town.island('aa')).buildings).toBe(5)

    town.env = 'dev'
    await town.open()
    expect(await town.page.evaluate(() => (window as any).city.inspectIsland('bb'))).toBeNull()
    expect((await town.island('aa')).buildings).toBe(4) // tools-cron is left out
  })

  test('an environment that does not exist shows no town, never another one', async ({ town, page }) => {
    await town.reset()
    await page.goto('/?test=1&quality=low&env=nope')
    await expect(page.locator('#banner')).toBeVisible()
    await expect(page.locator('#banner')).toContainText('nope')
    expect(await page.evaluate(() => (window as any).city.seen.snapshots)).toBe(0)
  })

  test('effects steer one environment and leave the others alone', async ({ town, request }) => {
    town.env = 'staging'
    await town.open()
    await town.effect('aa.orders-api', 'Down')
    await town.until('aa.orders-api', (n) => n.state === 'Down')
    // production is untouched
    const prod = await (await request.get(`${API}/api/snapshot/latest?env=prod`)).json()
    const api = prod.groups.flatMap((g: any) => g.nodes).find((n: any) => n.id === 'aa.orders-api')
    expect(api.state).toBe('Healthy')
  })

  test('the Try it panel shows the default environment when the address names none', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#env-select')).toHaveValue('prod')
    await expect(page.locator('.env')).toHaveText('Production')
  })

  test('the Try it panel and the address agree on the environment', async ({ town, page }) => {
    town.env = 'staging'
    await town.open()
    await expect(page.locator('#env-select')).toHaveValue('staging')
    await expect(page.locator('.env')).toHaveText('Staging')
  })
})

test.describe('the tenant yard', () => {
  test.beforeEach(async ({ town }) => {
    town.env = 'staging'
    await town.open()
    await town.step(10)
  })

  test('a database with a tenant pattern is a yard with a unit for each tenant', async ({ town }) => {
    const yard = await town.yard(DB)
    expect(yard.units.map((u) => u.id)).toEqual(['acme', 'borealis', 'qa', 'smoke', 'ghost-co'])
    expect(yard.sign.text).toBe('5 tenants, 0 throttled')
    // a database with no pattern, and an API, are not yards
    expect((await town.inspect('aa.audit-cache')).tenants).toBeNull()
    expect((await town.inspect('aa.orders-api')).tenants).toBeNull()
  })

  test('test tenants are paler, and a tenant nobody listed is unknown', async ({ town }) => {
    const yard = await town.yard(DB)
    const by = Object.fromEntries(yard.units.map((u) => [u.id, u]))
    expect([by.qa.test, by.smoke.test, by.acme.test, by.borealis.test]).toEqual([true, true, false, false])
    expect(by['ghost-co'].unknown).toBe(true)
    expect(by.acme.unknown).toBe(false)
    expect(yard.sign.note).toContain('1 unknown')
  })

  test('each tenant has its own units on each tenant database', async ({ town }) => {
    expect((await town.yard('bb.billing-db')).units.length).toBe(5)
    expect((await town.yard(DB)).units.length).toBe(5)
  })

  test('throttling one tenant turns only its unit red and counts it in the sign', async ({ town }) => {
    await town.effect(`${DB}#acme`, 'Saturate')
    await town.until(DB, (n) => (n.throttled ?? 0) > 0)
    await town.step(8)
    const yard = await town.yard(DB)
    const by = Object.fromEntries(yard.units.map((u) => [u.id, u]))
    expect(by.acme.level).toBe('red')
    expect(by.acme.throttled).toBe(true)
    expect(by.borealis.level).toBe('green')
    expect(yard.sign.text).toBe('5 tenants, 1 throttled')
    // the other pillar's database is not touched
    expect((await town.yard('bb.billing-db')).sign.text).toBe('5 tenants, 0 throttled')
  })

  test('the store follows its worst customer, and the service sign with it', async ({ town }) => {
    await town.effect(`${DB}#acme`, 'Saturate')
    await town.until(DB, (n) => n.state !== 'Healthy')
    await town.step(8)
    expect((await town.inspect(DB)).state).not.toBe('Healthy')
    const orders = (await town.services('aa')).find((s) => s.name === 'Orders')!
    expect(orders.state).not.toBe('Healthy')
  })

  test('trouble on a test tenant is amber at worst and does not turn the store red', async ({ town }) => {
    await town.effect(`${DB}#qa`, 'Saturate')
    await town.until(DB, () => true)
    await town.nextSnapshot()
    await town.nextSnapshot()
    await town.step(10)
    const yard = await town.yard(DB)
    expect(yard.units.find((u) => u.id === 'qa')!.level).toBe('amber')
    expect((await town.inspect(DB)).state).toBe('Healthy')
    expect((await town.inspect(DB)).beacon).not.toBe('red')
  })

  test('a tenant nobody listed can be throttled and shows red, still marked unknown', async ({ town }) => {
    await town.effect(`${DB}#ghost-co`, 'Saturate')
    await town.until(DB, (n) => (n.throttled ?? 0) > 0)
    await town.step(10)
    const u = (await town.yard(DB)).units.find((x) => x.id === 'ghost-co')!
    expect(u.unknown).toBe(true)
    expect(u.level).toBe('red')
  })

  test('only a Saturate effect may name a tenant', async ({ request }) => {
    const r = await request.post(`${API}/api/fake/effects?env=staging`, { data: { target: `${DB}#acme`, kind: 'Latency', intensity: 0.5 } })
    expect(r.status()).toBe(400)
    const bare = await request.post(`${API}/api/fake/effects?env=staging`, { data: { target: `${DB}#`, kind: 'Saturate', intensity: 1 } })
    expect(bare.status()).toBe(400)
  })

  test('hiding test tenants takes their units out of the yard and out of the sign', async ({ town, page }) => {
    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: true, tenant: null }))
    await town.step(1)
    const yard = await town.yard(DB)
    expect(yard.units.filter((u) => u.shown).map((u) => u.id)).toEqual(['acme', 'borealis', 'ghost-co'])
    expect(yard.sign.text).toBe('3 tenants, 0 throttled')
    expect(yard.sign.note).toContain('2 test hidden')
    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: false, tenant: null }))
    expect((await town.yard(DB)).sign.text).toBe('5 tenants, 0 throttled')
  })

  test('the Try it panel throttles the chosen tenant', async ({ town, page }) => {
    await page.selectOption('#tenant-select', 'borealis')
    await page.evaluate(() => (window as any).city.step(1))
    await page.locator('#tenant-throttle').click()
    await expect.poll(async () => (await (await town.request.get(`${API}/api/fake?env=staging`)).json()).effects.map((e: any) => e.target)).toContain('*#borealis')
  })
})

test.describe('tenant traffic', () => {
  test.beforeEach(async ({ town }) => {
    town.env = 'staging'
    await town.open()
    await town.effect('*', 'Traffic', 1)
    await town.step(30)
  })

  test('cars carry tenants in proportion to what the databases report', async ({ page }) => {
    const { byTenant } = await page.evaluate(() => (window as any).city.drawnCars())
    expect(Object.keys(byTenant).length).toBeGreaterThan(1)
    expect(byTenant['']).toBeUndefined() // staging has tenants, so every car has one
  })

  test('following one tenant draws only its cars', async ({ page }) => {
    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: false, tenant: 'acme' }))
    await page.evaluate(() => (window as any).city.step(1))
    const { byTenant, drawn } = await page.evaluate(() => (window as any).city.drawnCars())
    expect(Object.keys(byTenant)).toEqual(['acme'])
    expect(drawn).toBeGreaterThan(0)
  })

  test('hiding test tenants draws none of their cars', async ({ page }) => {
    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: true, tenant: null }))
    await page.evaluate(() => (window as any).city.step(1))
    const { byTenant } = await page.evaluate(() => (window as any).city.drawnCars())
    expect(byTenant.qa).toBeUndefined()
    expect(byTenant.smoke).toBeUndefined()
    expect(Object.keys(byTenant).length).toBeGreaterThan(0)
  })

  test('a followed tenant that leaves the environment is let go', async ({ page }) => {
    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: false, tenant: 'not-a-tenant' }))
    await page.waitForFunction(() => (window as any).city.tenantView().tenant === null, null, { timeout: 15_000 })
  })
})

test.describe('services', () => {
  test.beforeEach(async ({ town }) => {
    town.env = 'staging'
    await town.open()
    await town.step(10)
  })

  test('systems of one service share a pad, wherever the file lists them, and the others stand alone', async ({ town }) => {
    const aa = await town.services('aa')
    expect(aa.map((s) => s.name)).toEqual(['Orders', 'Audit cache', 'Tools run'])
    expect(aa[0].systems.sort()).toEqual(['aa.orders-api', 'aa.orders-db', 'aa.orders-worker'])
    expect(aa[1].systems).toEqual(['aa.audit-cache'])
    const bb = await town.services('bb')
    expect(bb.map((s) => s.name)).toEqual(['Billing', 'Shared DB'])
  })

  test('a healthy service shows a green sign, and one system down turns it red', async ({ town }) => {
    expect((await town.services('aa')).every((s) => s.state === 'Healthy')).toBe(true)
    await town.effect('aa.orders-worker', 'Down')
    await town.until('aa.orders-worker', (n) => n.state === 'Down')
    await town.step(1)
    const aa = await town.services('aa')
    expect(aa.find((s) => s.name === 'Orders')!.state).toBe('Down')
    expect(aa.find((s) => s.name === 'Audit cache')!.state).toBe('Healthy')
  })

  test('the sign shows no data while its systems have gone quiet', async ({ town }) => {
    await town.effect('aa.audit-cache', 'Stale')
    await town.until('aa.audit-cache', (n) => n.state === 'Stale')
    await town.step(1)
    expect((await town.services('aa')).find((s) => s.name === 'Audit cache')!.state).toBe('Stale')
  })

  test('opening a service lists its systems and their numbers', async ({ town, page }) => {
    await town.effect(`${DB}#acme`, 'Saturate')
    await town.until(DB, (n) => (n.throttled ?? 0) > 0)
    await page.evaluate(() => (window as any).city.openService('aa/orders'))
    const panel = page.locator('#service-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Orders')
    await expect(panel.locator('.sys')).toHaveCount(3)
    await expect(panel).toContainText('5 tenants, 1 throttled')
    await panel.locator('#service-close').click()
    await expect(panel).toBeHidden()
  })

  test('a hit box over every service makes the sign and hedge clickable', async ({ page }) => {
    const keys = await page.evaluate(() => (window as any).city.town.serviceHits().map((h: any) => h.userData.serviceKey))
    expect(new Set(keys)).toEqual(new Set(['aa/orders', 'aa.audit-cache', 'aa.tools-cron', 'bb/billing', 'bb.shared-db']))
  })
})
