import { test, expect } from '../support/test'

// A town whose islands call each other directly (no hub in between): when the island filter hides an island, the traffic to and from it has no
// common place to go, so each island that talks to a hidden one gets a signpost. direct-town: Beta and Gamma call Alpha's orders API.

test.describe('hidden islands in a town without a hub', () => {
  test('an island that talks to a hidden island has a signpost naming it, with the traffic each way', async ({ town, page }) => {
    await town.open('&islands=aa')
    await town.step(2)
    const edge = await page.evaluate(() => (window as any).city.inspectEdge())
    expect(edge.mode).toBe('signpost')
    expect(edge.plazaRoutes).toEqual([])
    const sign = edge.signposts.find((s: any) => s.island === 'aa')
    expect(sign, 'Alpha has a signpost').toBeTruthy()
    const text = sign.lines.join('\n')
    expect(text).toContain('Beta')
    expect(text).toContain('Gamma')
    expect(text).toContain('←') // they call in
    expect(text).not.toContain('→') // Alpha calls nobody outside
  })

  test('no island is hidden, no signpost', async ({ town, page }) => {
    await town.open()
    const edge = await page.evaluate(() => (window as any).city.inspectEdge())
    expect(edge.signposts.every((s: any) => s.lines.length === 0)).toBe(true)
  })

  test('an island whose neighbours are all on screen has no signpost', async ({ town, page }) => {
    await town.open('&islands=aa,bb,cc')
    const edge = await page.evaluate(() => (window as any).city.inspectEdge())
    expect(edge.signposts.every((s: any) => s.lines.length === 0)).toBe(true)
  })

  test('showing the hidden island takes the signpost away, without a reload', async ({ town, page }) => {
    await town.open('&islands=aa')
    await page.locator('#islands-button').click()
    await page.locator('[data-act="all-islands"]').click()
    await page.waitForFunction(() => (window as any).city.seen.last.view.islands.length === 0)
    await town.step(1)
    const edge = await page.evaluate(() => (window as any).city.inspectEdge())
    expect(edge.signposts.every((s: any) => s.lines.length === 0)).toBe(true)
  })
})

test.describe('the legend in a town without a hub', () => {
  test('explains the ring road and the direct way between islands, and not the hub', async ({ town, page }) => {
    await town.open('&legend=1')
    await town.step(1)
    await page.locator('#legend-tab-traffic').click()
    for (const id of ['flow-direct', 'flow-outside-direct', 'flow-vendor-direct', 'signpost']) await expect(page.locator(`#legend [data-id="${id}"]`)).toBeVisible()
    await expect(page.locator('#legend [data-id="flow-hub"]')).toHaveCount(0)
    await page.locator('#legend-tab-islands').click()
    await expect(page.locator('#legend [data-id="ring-direct"]')).toBeVisible()
    await expect(page.locator('#legend [data-id="spoke"]')).toHaveCount(0)
  })
})
