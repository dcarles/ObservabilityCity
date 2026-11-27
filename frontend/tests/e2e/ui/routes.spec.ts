import { test, expect } from '../support/test'

// The calls an API serves, on mini-town (the fake source makes its routes up): the drawer lists the busiest five with their rate and the split by method, and the sign of the
// island says the busiest calls when hovered. A worker or a database serves none, so its drawer has no such section.

test.describe('the calls an API serves', () => {
  test('the drawer lists the busiest calls and how the requests divide by method', async ({ town, page }) => {
    await town.open()
    await page.evaluate(() => { const c = (window as any).city; for (let i = 0; i < 6; i++) c.step(0.5); c.openSystem('aa.orders-api') })

    const calls = page.locator('#inspector .calls .row.call')
    await expect(calls).toHaveCount(5)
    await expect(calls.first()).toContainText('GET')
    await expect(calls.first()).toContainText('rps')
    const methods = page.locator('#inspector .methods .row.method-row')
    expect(await methods.count()).toBeGreaterThanOrEqual(3)
    await expect(methods.first()).toContainText('%')
    // highest first
    const rates = await calls.evaluateAll((els) => els.map((e) => parseFloat((e.querySelectorAll('span')[1].textContent ?? '0'))))
    expect([...rates].sort((a, b) => b - a)).toEqual(rates)
  })

  test('a database has no calls section', async ({ town, page }) => {
    await town.open()
    await page.evaluate(() => { const c = (window as any).city; for (let i = 0; i < 6; i++) c.step(0.5); c.openSystem('aa.orders-db') })
    await expect(page.locator('#inspector')).toBeVisible()
    await expect(page.locator('#inspector .calls')).toHaveCount(0)
  })

  test('hovering the island sign says its busiest calls and its method split, after the traffic lines', async ({ town, page }) => {
    await town.open()
    const lines = await page.evaluate(() => { const c = (window as any).city; for (let i = 0; i < 6; i++) c.step(0.5); return c.town.signSummary('aa').lines as string[] })

    const at = lines.indexOf('Top calls')
    expect(at).toBeGreaterThan(0)
    expect(lines.slice(0, at).every((l) => l.startsWith('Requests'))).toBe(true)
    expect(lines.slice(at + 1, at + 4).every((l) => / · aa\.\S+ · [\d.]+k? rps$/.test(l))).toBe(true)
    expect(lines[at + 4]).toMatch(/^Methods GET \d+% · /)
  })
})
