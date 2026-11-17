import { test, expect } from '../support/test'
import type { Page } from '@playwright/test'

// The architecture view on the tenants town (pillars Alpha and Bravo, a hub with shared systems). The town has no call between its pillars, so a test that
// needs one feeds the page a snapshot with a call added. Everything is read from what the page draws.

const box = (page: Page, id: string) => page.locator(`#arch-svg .box[data-id="${id}"]`)

async function open(town: { reset(): Promise<void> }, page: Page, query = ''): Promise<void> {
  await town.reset()
  await page.goto(`/?view=architecture${query}`)
  await page.waitForFunction(() => (window as any).dash?.architecture?.()?.boxes.length > 0)
  await expect(box(page, 'aa')).toBeVisible()
}

/** Feeds the page a snapshot made from the live one (and holds back the server's own, so a newer one cannot undo it before the test reads what it fed). */
async function feed(page: Page, edit: string): Promise<void> {
  await page.evaluate(async (code) => {
    const s = await (await fetch('/api/snapshot/latest')).json()
    const node = (id: string) => s.groups.flatMap((g: any) => g.nodes).find((n: any) => n.id === id)
    new Function('s', 'node', code)(s, node)
    ;(window as any).dash.hold(true)
    ;(window as any).dash.feed(s)
  }, edit)
}

const CALL = `node('aa.orders-api').calls = [...node('aa.orders-api').calls, 'bb.billing-api']`

test.describe('the architecture view', () => {
  test('opens without the 3D town, with one box for each pillar and the shared systems in a frame of their own', async ({ town, page }) => {
    const loaded: string[] = []
    page.on('request', (r) => { if (/three/i.test(r.url())) loaded.push(r.url()) })
    await open(town, page)
    expect(loaded).toEqual([])
    expect(await page.evaluate(() => (window as any).city)).toBeUndefined()
    await expect(page.locator('#town')).toBeHidden()
    await expect(page.locator('#view-select')).toHaveValue('architecture')
    await expect(box(page, 'aa')).toContainText('Alpha')
    await expect(box(page, 'bb')).toContainText('Bravo')
    const kinds = await page.evaluate(() => (window as any).dash.architecture().boxes.map((b: any) => b.kind))
    expect(kinds.filter((k: string) => k === 'pillar')).toHaveLength(2)
    expect(kinds).toContain('shared')
    await expect(page.locator('#arch-svg .frame-label')).toContainText(['SHARED PLATFORM SYSTEMS'])
  })

  test('the totals are the dashboard\'s own boxes: down, degraded, dead letters, traffic, messages and incidents, in that order', async ({ town, page }) => {
    await open(town, page)
    // the dashboard's own boxes (one is left out when nothing measures it), so the two views cannot drift apart
    const mine = (await page.locator('#arch-sum .kpi > span:first-child').allTextContents()).map((t) => t.toLowerCase())
    expect(mine.slice(0, 4)).toEqual(['down', 'degraded', 'dead letters', 'total traffic'])
    await feed(page, `node('aa.orders-api').state = 'Down'`)
    await expect(page.locator('#arch-kpi-down b')).toHaveText('1')
    await expect(page.locator('#arch-kpi-down')).toHaveClass(/bad/)
  })

  test('the switch goes to the town and back, and the browser remembers the last view', async ({ town, page }) => {
    await open(town, page)
    await page.locator('#view-select').selectOption('town')
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    expect(new URL(page.url()).searchParams.get('view')).toBe('town')
    await page.locator('#view-switch').selectOption('architecture')
    await page.waitForFunction(() => (window as any).dash?.architecture?.()?.boxes.length > 0)
    await page.goto('/') // no ?view=: this browser last chose the diagram
    await page.waitForFunction(() => (window as any).dash?.architecture?.()?.boxes.length > 0)
    await expect(page.locator('#arch-root')).toBeVisible()
  })

  test('a pillar that goes down turns red in place, and the zoom and the box stay where they are', async ({ town, page }) => {
    await open(town, page)
    await page.locator('#arch-zoom-in').click()
    await page.waitForTimeout(300)
    const before = await page.evaluate(() => {
      document.querySelector('#arch-svg .box[data-id="aa"]')!.setAttribute('data-mark', 'same')
      return (window as any).dash.diagram().view
    })
    await feed(page, `node('aa.orders-api').state = 'Down'`)
    await expect(box(page, 'aa')).toContainText(/down/)
    await expect(box(page, 'aa')).toHaveAttribute('data-mark', 'same') // the same element, not a new one
    expect(await page.evaluate(() => (window as any).dash.architecture().boxes.find((b: any) => b.id === 'aa').level)).toBe('bad')
    expect(await page.evaluate(() => (window as any).dash.diagram().view)).toEqual(before)
  })

  test('tapping a pillar lights up its lines and dims the rest, tapping empty space clears it', async ({ town, page }) => {
    await open(town, page)
    await feed(page, CALL)
    await expect(page.locator('#arch-svg .edge')).toHaveCount(1)
    await box(page, 'aa').click()
    await expect(page.locator('#arch-svg .edge.hot')).toHaveCount(1)
    await expect(page.locator('#arch-pick')).toContainText('Alpha')
    const shared = await page.evaluate(() => (window as any).dash.architecture().boxes.find((b: any) => b.kind === 'shared').id)
    await expect(box(page, shared)).toHaveClass(/dim/)
    await expect(box(page, 'bb')).not.toHaveClass(/dim/) // the pillar at the other end of the line stays lit
    await page.locator('#arch-svg').click({ position: { x: 4, y: 4 } })
    await expect(page.locator('#arch-svg .edge.hot')).toHaveCount(0)
    await expect(page.locator('#arch-svg .box.dim')).toHaveCount(0)
    await expect(page.locator('#arch-pick')).toBeHidden()
  })

  test('a line takes the colour of the pillar that calls, and no option or glow changes that', async ({ town, page }) => {
    await open(town, page)
    await feed(page, `${CALL}; node('bb.billing-api').state = 'Down'`)
    const colour = await page.evaluate(() => (window as any).dash.architecture().boxes.find((b: any) => b.id === 'aa').color)
    expect(colour).toBeTruthy()
    await expect(page.locator('#arch-svg .edge')).toHaveAttribute('style', new RegExp(`--line:\\s*${colour.replace('#', '#?')}`, 'i'))
    await expect(page.locator('#arch-svg .edge')).toHaveCSS('filter', 'none')
    await page.locator('#arch-look-toggle').click()
    await expect(page.locator('#arch-o-colour')).toHaveCount(0)
  })

  test('line width follows traffic only when asked to', async ({ town, page }) => {
    await open(town, page)
    await feed(page, CALL)
    expect(await page.evaluate(() => (window as any).dash.options().width)).toBe(false)
    await expect(page.locator('#arch-svg .edge')).toHaveAttribute('stroke-width', '2')
  })

  test('hiding a pillar takes its box and lines away without moving the other box, and showing it puts it back where it was', async ({ town, page }) => {
    await open(town, page)
    await feed(page, CALL)
    const at = async (id: string) => box(page, id).getAttribute('transform')
    const aa = await at('aa')
    const bb = await at('bb')
    await page.evaluate(() => (window as any).dash.hold(false))
    await page.locator('#pillars-button').click()
    await page.locator('#pillar-menu input[data-pillar-box="bb"]').uncheck()
    await expect(box(page, 'bb')).toHaveCount(0)
    await expect(box(page, 'aa')).toBeVisible()
    expect(await at('aa')).toBe(aa)
    expect(new URL(page.url()).searchParams.get('islands')).toBe('aa')
    await page.locator('#pillar-menu input[data-pillar-box="bb"]').check()
    await expect(box(page, 'bb')).toBeVisible()
    expect(await at('bb')).toBe(bb)
    expect(await at('aa')).toBe(aa)
  })

  test('the Pillars list has an All pillars row that shows every pillar again', async ({ town, page }) => {
    await open(town, page)
    await page.locator('#pillars-button').click()
    await expect(page.locator('#pillar-menu input[data-pillar-all]')).toBeChecked()
    await page.locator('#pillar-menu input[data-pillar-box="aa"]').uncheck()
    await expect(box(page, 'aa')).toHaveCount(0)
    await expect(page.locator('#pillar-menu input[data-pillar-all]')).not.toBeChecked()
    await page.locator('#pillar-menu input[data-pillar-all]').check()
    await expect(box(page, 'aa')).toBeVisible()
    await expect(box(page, 'bb')).toBeVisible()
    expect(new URL(page.url()).searchParams.has('islands')).toBe(false)
  })

  test('a third party and an internal service can be hidden on their own, and come back with All pillars', async ({ town, page }) => {
    await open(town, page)
    await feed(page, `${CALL}; const v = (id, name, internal) => ({ node: { ...node('aa.orders-api'), id, name, calls: [] }, calledBy: ['aa.orders-api'], islandId: id, islandName: name, internal, calls: null }); s.vendors = [v('pay', 'Pay Co', false), v('dig', 'Digital Thing', true)]`)
    await expect(box(page, 'vendor:pay')).toBeVisible()
    await expect(box(page, 'vendor:dig')).toBeVisible()
    await page.locator('#pillars-button').click()
    await expect(page.locator('#pillar-menu .vb-group')).toHaveCount(2)
    await page.locator('#pillar-menu input[data-vendor-box="pay"]').uncheck()
    await expect(box(page, 'vendor:pay')).toHaveCount(0)
    await expect(box(page, 'vendor:dig')).toBeVisible()
    expect(new URL(page.url()).searchParams.get('hidevendors')).toBe('pay')
    await page.locator('#pillar-menu input[data-vendor-box="dig"]').uncheck()
    await expect(box(page, 'vendor:dig')).toHaveCount(0)
    await page.locator('#pillar-menu input[data-pillar-all]').check()
    await expect(box(page, 'vendor:pay')).toBeVisible()
    await expect(box(page, 'vendor:dig')).toBeVisible()
    expect(new URL(page.url()).searchParams.has('hidevendors')).toBe(false)
  })

  test('double-tapping a pillar opens it: its service groups, the other pillar closed beside it, and a way back that puts every box where it was', async ({ town, page }) => {
    await open(town, page)
    await feed(page, CALL)
    const at = async (id: string) => box(page, id).getAttribute('transform')
    const before = [await at('aa'), await at('bb')]
    await box(page, 'aa').dblclick()
    await expect(page.locator('#arch-crumb')).toContainText('Alpha')
    await expect.poll(() => page.evaluate(() => (window as any).dash.opened())).toBe('aa')
    expect(new URL(page.url()).searchParams.get('open')).toBe('aa')
    const kinds = await page.evaluate(() => (window as any).dash.architecture().boxes.map((b: any) => [b.kind, !!b.closed]))
    expect(kinds.filter((k: [string, boolean]) => k[0] === 'service').length).toBeGreaterThan(0)
    expect(kinds).toContainEqual(['pillar', true]) // Bravo, closed, because Alpha calls it
    await expect(box(page, 'aa')).toHaveCount(0)
    await expect(box(page, 'bb')).toContainText('Bravo')
    await expect(page.locator('#arch-svg .edge')).not.toHaveCount(0)
    await page.locator('#arch-back').click()
    await expect(page.locator('#arch-crumb')).toBeHidden()
    expect(new URL(page.url()).searchParams.has('open')).toBe(false)
    expect([await at('aa'), await at('bb')]).toEqual(before)
  })

  test('the Open button on the pick bar opens a pillar, Esc goes back, and tapping a closed pillar then Open jumps to it', async ({ town, page }) => {
    await open(town, page)
    await feed(page, CALL)
    await box(page, 'aa').click()
    await page.locator('#arch-pick-open').click()
    await expect.poll(() => page.evaluate(() => (window as any).dash.opened())).toBe('aa')
    await box(page, 'bb').click()
    await expect(page.locator('#arch-pick')).toContainText('Bravo')
    await page.locator('#arch-pick-open').click()
    await expect.poll(() => page.evaluate(() => (window as any).dash.opened())).toBe('bb')
    await page.keyboard.press('Escape') // first Esc lets go of the pick, if there is one
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => (window as any).dash.opened())).toBeNull()
    await expect(box(page, 'aa')).toBeVisible()
  })

  test('inside a pillar, a third party it calls is a closed box, and hiding it takes it away', async ({ town, page }) => {
    await open(town, page)
    await feed(page, `s.vendors = [{ node: { ...node('aa.orders-api'), id: 'pay', name: 'Pay Co', calls: [] }, calledBy: ['aa.orders-api'], islandId: 'pay', islandName: 'Pay Co', internal: false, calls: null }]; node('aa.orders-api').calls = [...node('aa.orders-api').calls, 'pay']`)
    await page.evaluate(() => (window as any).dash.open('aa'))
    await expect(box(page, 'vendor:pay')).toBeVisible()
    await page.locator('#pillars-button').click()
    await page.locator('#pillar-menu input[data-vendor-box="pay"]').uncheck()
    await expect(box(page, 'vendor:pay')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).dash.opened())).toBe('aa')
  })

  test('an address that opens a pillar the page does not show falls back to all of them', async ({ town, page }) => {
    await town.reset()
    await page.goto('/?view=architecture&open=nope')
    await page.waitForFunction(() => (window as any).dash?.architecture?.()?.boxes.length > 0)
    await expect(box(page, 'aa')).toBeVisible()
    expect(new URL(page.url()).searchParams.has('open')).toBe(false)
  })

  test('a pillar opened by the address stays open when new snapshots arrive', async ({ town, page }) => {
    await town.reset()
    await page.goto('/?view=architecture&open=aa')
    await page.waitForFunction(() => (window as any).dash?.opened?.() === 'aa' && (window as any).dash.architecture()?.boxes.length > 0)
    await page.locator('#arch-zoom-in').click()
    await page.waitForTimeout(300)
    const view = await page.evaluate(() => (window as any).dash.diagram().view)
    await feed(page, `node('aa.orders-api').state = 'Down'`)
    expect(await page.evaluate(() => (window as any).dash.opened())).toBe('aa')
    expect(await page.evaluate(() => (window as any).dash.diagram().view)).toEqual(view)
  })

  test('zooms with the buttons and fits again', async ({ town, page }) => {
    await open(town, page)
    const width = () => page.evaluate(() => (window as any).dash.diagram().view.w)
    const w0 = await width()
    await page.locator('#arch-zoom-in').click()
    await expect.poll(width).toBeLessThan(w0)
    await page.locator('#arch-zoom-out').click()
    await page.locator('#arch-zoom-out').click()
    await expect.poll(width).toBeGreaterThan(w0)
    await page.locator('#arch-fit').click()
    await expect.poll(async () => Math.abs((await width()) - w0)).toBeLessThan(1)
  })

  test('a box that is one system opens the drawer; a pillar does not', async ({ town, page }) => {
    await open(town, page)
    const shared = await page.evaluate(() => (window as any).dash.architecture().boxes.find((b: any) => b.kind === 'shared'))
    await box(page, 'aa').click()
    await expect(page.locator('#inspector')).toBeHidden()
    await box(page, shared.id).click()
    await expect(page.locator('#inspector')).toBeVisible()
  })

  test('the visualisation options keep their name, change the drawing, and are remembered', async ({ town, page }) => {
    await open(town, page)
    const toggle = page.locator('#arch-look-toggle')
    await expect(toggle).toHaveText('Visualisation options')
    await toggle.click()
    await expect(page.locator('#arch-o-box')).toBeVisible()
    await page.locator('#arch-o-box button[data-v="C"]').click()
    await expect(page.locator('#arch-svg .box[data-id="aa"] .shape')).toHaveAttribute('stroke-width', '2.5')
    await page.locator('#arch-look-x').click()
    await expect(page.locator('#arch-o-box')).toBeHidden()
    await expect(toggle).toHaveText('Visualisation options') // still says so after hiding them
    await page.reload()
    await page.waitForFunction(() => (window as any).dash?.architecture?.()?.boxes.length > 0)
    expect(await page.evaluate(() => (window as any).dash.options().box)).toBe('C')
  })

  test('square lines are the default', async ({ town, page }) => {
    await open(town, page)
    expect(await page.evaluate(() => (window as any).dash.options().line)).toBe('elbow')
  })

  test('on a phone the page does not scroll sideways and the diagram has the screen', async ({ town, page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await open(town, page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    const stage = await page.locator('#arch-stage').boundingBox()
    expect(stage!.height).toBeGreaterThan(400)
  })
})
