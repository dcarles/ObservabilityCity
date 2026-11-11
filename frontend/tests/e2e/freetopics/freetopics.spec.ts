import { test, expect } from '../support/test'

// A demo town whose topics have names of their own (free-topics-town): orders.created and orders.cancelled from one service, billing.invoice.paid
// from another, billing.audit that no service publishes, and the hub's platform.broadcast. No template names them; the file that
// lists a topic owns it. The piers, the boats and the drawer come out as they do for a town whose topics are named after services.

test.describe('a town whose topics are named after events', () => {
  test('gives every island with messaging a pier, and the broker counts every topic', async ({ town }) => {
    await town.open()
    await town.step(5)

    for (const id of ['ord', 'bil', 'shp']) expect((await town.island(id)).pier, id).toBe(true)
    expect(await town.hub()).toMatchObject({ topics: 5, subscriptions: 6, piers: 3 })
    expect((await town.hub()).sign.counts).toBe('5 topics · 6 subscriptions · 3 piers')
  })

  test('sails boats from the island that publishes orders.created and to the islands that read it', async ({ town }) => {
    await town.open()
    await town.step(20)
    const sea = await town.sea()

    expect(sea.unreachable).toEqual([])
    // the orders island sends what its service publishes, and the shipping island, which only reads, receives
    expect(sea.routes.some((r) => r.from === 'ord' && r.rate > 0)).toBe(true)
    expect(sea.routes.some((r) => r.to === 'shp' && r.rate > 0)).toBe(true)
    for (const id of sea.harbours) expect(sea.routes.some((r) => r.to === id), id).toBe(true)
    expect(await town.mostBoats(120)).toBeGreaterThan(0)
  })

  test('lists both topics of one service in its drawer, and the reader\'s subscription with its publisher', async ({ town, page }) => {
    await town.open()

    await page.evaluate(() => (window as any).city.openSystem('ord.orders-api'))
    await page.locator('#inspector [data-tab="links"]').click()
    await expect(page.locator('#inspector')).toContainText('orders.created')
    await expect(page.locator('#inspector')).toContainText('orders.cancelled')

    await page.evaluate(() => (window as any).city.openSystem('shp.shipping-worker'))
    await page.locator('#inspector [data-tab="links"]').click()
    await expect(page.locator('#inspector')).toContainText('billing.audit')
    await expect(page.locator('#inspector')).toContainText('bil → shp.shipping-worker')
    await expect(page.locator('#inspector')).toContainText('platform.broadcast')
    await expect(page.locator('#inspector')).toContainText('hub → shp.shipping-worker')
  })
})
