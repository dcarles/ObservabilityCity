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

  test('the top bar names the environment and has no title taking its room', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#env-button')).toContainText('Production')
    await expect(page.locator('#topbar .brand')).toHaveCount(0)
  })

  test('the environment name is a dropdown of every environment, and picking one loads that one', async ({ town, page }) => {
    town.env = 'staging'
    await town.open()
    await expect(page.locator('#env-button')).toContainText('Staging')
    await page.locator('#env-button').click()
    await expect(page.locator('#env-list .vb-row')).toHaveText([/Development/, /Staging/, /Production/])
    await page.locator('#env-list .vb-row', { hasText: 'Development' }).click()
    await page.waitForURL(/env=dev/)
    await page.waitForFunction(() => (window as any).city?.seen.last?.environment === 'dev')
    await expect(page.locator('#env-button')).toContainText('Development')
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

  test('the inspector lists the tenant that is turning requests away first, with its own figure', async ({ town, page }) => {
    await town.effect(`${DB}#borealis`, 'Saturate')
    await town.until(DB, (n) => (n.throttled ?? 0) > 0)
    await town.step(8)
    await page.locator('#search-input').fill('Orders DB')
    await page.locator('#search-results .hit').first().click()
    const rows = page.locator('#inspector h4', { hasText: 'Tenants' }).locator('~ .row')
    await expect(rows.first()).toContainText('% throttled')
    const names = await page.evaluate(() => (window as any).city.seen.last.tenants.map((t: any) => t.name))
    expect(names).toContain((await rows.first().locator('span').first().textContent())!.trim())
    // every tenant shows its own figure, the others at 0%
    const total = await rows.count()
    await expect(rows.filter({ hasText: 'throttled' })).toHaveCount(total)
    await expect(rows.filter({ hasText: ' 0% throttled' }).first()).toBeVisible()
    await expect(rows.filter({ hasText: 'refused' })).toHaveCount(0)
    // the Overview names who throttles, and the yard sign names them too
    await expect(page.locator('#inspector .row', { hasText: 'Throttled' }).first()).toContainText(await rows.first().locator('span').first().textContent() ?? '')
    expect((await town.yard(DB)).sign.note).toContain('throttled:')
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
    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: true, tenants: [] }))
    await town.step(1)
    const yard = await town.yard(DB)
    expect(yard.units.filter((u) => u.shown).map((u) => u.id)).toEqual(['acme', 'borealis', 'ghost-co'])
    expect(yard.sign.text).toBe('3 tenants, 0 throttled')
    expect(yard.sign.note).toContain('2 test hidden')
    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: false, tenants: [] }))
    expect((await town.yard(DB)).sign.text).toBe('5 tenants, 0 throttled')
  })

  test('Break things throttles the tenant picked in the top bar', async ({ town, page }) => {
    await page.locator('#tenant-button').click()
    await page.locator('#tenant-list .vb-row', { hasText: 'Borealis' }).click()
    await page.locator('#tenant-button').click() // closes the list
    // the target first, then the scenario: a tenant scenario needs one store
    await page.locator('#target').fill(DB)
    await page.locator('#target-results .hit').first().click()
    await page.locator('[data-scenario="tenant-db"]').click()
    await expect.poll(async () => (await (await town.request.get(`${API}/api/fake?env=staging`)).json()).effects.map((e: any) => e.target)).toContain(`${DB}#borealis`)
  })
})

test.describe('the tenant dropdown', () => {
  test.beforeEach(async ({ town }) => {
    town.env = 'staging'
    await town.open()
    await town.step(5)
    await town.page.locator('#tenant-button').click()
  })

  test('starts on all tenants, and lists names with their ids in groups', async ({ page }) => {
    await expect(page.locator('#tenant-button')).toContainText('All tenants')
    await expect(page.locator('#tenant-list .vb-group')).toHaveText(['Customers', 'Test tenants', 'Unknown (not on the list)'])
    const acme = page.locator('#tenant-list .vb-row', { hasText: 'Acme' })
    await expect(acme.locator('small')).toHaveText('acme') // the id sits beside the name
  })

  test('finds a tenant by a part of its id', async ({ page }) => {
    await page.locator('#tenant-query').fill('ghost')
    await expect(page.locator('#tenant-list .vb-row[data-act=tenant]')).toHaveCount(1)
    await expect(page.locator('#tenant-list .vb-group')).toHaveText(['Unknown (not on the list)'])
    await page.locator('#tenant-query').fill('bore')
    await expect(page.locator('#tenant-list .vb-row[data-act=tenant]')).toContainText('Borealis')
    await page.locator('#tenant-query').fill('nothing like it')
    await expect(page.locator('#tenant-list .vb-none')).toBeVisible()
  })

  test('ticking tenants follows them, and the button says so', async ({ page }) => {
    await page.locator('#tenant-list .vb-row', { hasText: 'Acme' }).first().click()
    await expect(page.locator('#tenant-button')).toContainText('Acme')
    await page.locator('#tenant-list .vb-row', { hasText: 'Borealis' }).click()
    await expect(page.locator('#tenant-button')).toContainText('2 tenants')
    expect(await page.evaluate(() => (window as any).city.tenantView().tenants)).toEqual(['acme', 'borealis'])
    await page.locator('#tenant-list [data-act=all]').click()
    await expect(page.locator('#tenant-button')).toContainText('All tenants')
    expect(await page.evaluate(() => (window as any).city.tenantView().tenants)).toEqual([])
  })

  test('the hide test tenants switch is in the list and hides their units', async ({ town, page }) => {
    await page.locator('#hide-test').check()
    await expect(page.locator('#tenant-button')).toContainText('no test')
    expect((await town.yard(DB)).sign.text).toBe('3 tenants, 0 throttled')
  })

  test('a tenant in trouble has a dot in the list', async ({ town, page }) => {
    await town.effect(`${DB}#acme`, 'Saturate')
    await town.until(DB, (n) => (n.throttled ?? 0) > 0)
    await expect(page.locator('#tenant-list .vb-row', { hasText: 'Acme' }).locator('.dot')).toHaveCount(1)
    await expect(page.locator('#tenant-list .vb-row', { hasText: 'Borealis' }).locator('.dot')).toHaveCount(0)
  })

  test('Escape closes the list and keeps the choice', async ({ page }) => {
    await page.locator('#tenant-list .vb-row', { hasText: 'Acme' }).first().click()
    await page.keyboard.press('Escape')
    await expect(page.locator('#tenant-list')).toHaveCount(0)
    await expect(page.locator('#tenant-button')).toContainText('Acme')
  })
})

test.describe('the numbers in the top bar', () => {
  test('follow the tenants chosen: their share of the traffic, and their own databases for degraded', async ({ town, page }) => {
    await town.open()
    const all = await page.evaluate(() => ({ totals: (window as any).city.totals(), shares: (window as any).city.seen.last.tenants }))
    expect(all.totals.tenantShare).toBe(1)
    await expect(page.locator('#chip-requests')).not.toHaveAttribute('title', /of the environment/)

    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: false, tenants: ['acme'] }))
    const acme = await page.evaluate(() => (window as any).city.totals())
    const share = all.shares.find((t: any) => t.id === 'acme').share / all.shares.reduce((a: number, t: any) => a + t.share, 0)
    expect(acme.tenantShare).toBeCloseTo(share, 5)
    expect(acme.requestsPerSecond).toBeCloseTo(all.totals.requestsPerSecond * share, 3)
    expect(acme.requestsPerSecond).toBeLessThan(all.totals.requestsPerSecond)
    await expect(page.locator('#chip-requests')).toHaveAttribute('title', /of the environment's traffic/)
    // errors are not split by tenant, and the tooltip says so
    await expect(page.locator('#topbar .chip', { hasText: 'errors' })).toHaveAttribute('title', /Not split by tenant/)
  })

  test('count a throttled tenant database as degraded only while that tenant is followed', async ({ town, page }) => {
    await town.open()
    await town.effect(`${DB}#borealis`, 'Saturate')
    await town.until(DB, (n) => (n.throttled ?? 0) > 0)
    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: false, tenants: ['acme'] }))
    const acme = await page.evaluate(() => (window as any).city.totals())
    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: false, tenants: ['borealis'] }))
    const borealis = await page.evaluate(() => (window as any).city.totals())
    expect(borealis.degraded + borealis.down).toBeGreaterThan(acme.degraded + acme.down)
  })

  test('the chip shows what the totals say', async ({ town, page }) => {
    await town.open()
    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: false, tenants: ['acme'] }))
    const t = await page.evaluate(() => (window as any).city.totals())
    const text = await page.locator('#chip-requests b').textContent()
    expect(Number.parseFloat(text!.replace(/[^\d.]/g, ''))).toBeGreaterThan(0)
    expect(t.requestsPerSecond).toBeGreaterThan(0)
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
    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: false, tenants: ['acme'] }))
    await page.evaluate(() => (window as any).city.step(1))
    const { byTenant, drawn } = await page.evaluate(() => (window as any).city.drawnCars())
    expect(Object.keys(byTenant)).toEqual(['acme'])
    expect(drawn).toBeGreaterThan(0)
  })

  test('hiding test tenants draws none of their cars', async ({ page }) => {
    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: true, tenants: [] }))
    await page.evaluate(() => (window as any).city.step(1))
    const { byTenant } = await page.evaluate(() => (window as any).city.drawnCars())
    expect(byTenant.qa).toBeUndefined()
    expect(byTenant.smoke).toBeUndefined()
    expect(Object.keys(byTenant).length).toBeGreaterThan(0)
  })

  test('a followed tenant that leaves the environment is let go', async ({ page }) => {
    await page.evaluate(() => (window as any).city.setTenantView({ hideTest: false, tenants: ['not-a-tenant'] }))
    await page.waitForFunction(() => (window as any).city.tenantView().tenants.length === 0, null, { timeout: 15_000 })
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
