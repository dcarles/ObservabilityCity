import type { Page } from '@playwright/test'
import { test, expect } from '../support/test'

// The top bar with a very long town name: the name shows once (in the town dropdown), and nothing in the bar overlaps or is cut off by
// another control, at the widths a window really has.

const LONG = 'Example Credit Platform With A Long Name Production'
const TOWNS = [
  { id: 'mini-town', name: 'Mini Town', isDefault: true },
  { id: 'long-town', name: LONG, isDefault: false },
]

/** Feeds a snapshot with the long name and reads the bar in the same step, so the next live snapshot cannot undo it. */
async function measure(page: Page, name: string) {
  return page.evaluate((townName) => {
    const city = (window as any).city
    city.feed({ ...city.seen.last, townName })
    const box = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { l: r.left, r: r.right, t: r.top, b: r.bottom }
    }
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
    }
    const items = [...document.querySelectorAll('#topbar .vb-btn, #topbar #search-input, #topbar .chip, #topbar .status, #topbar #tools button, #topbar #town-name')]
      .filter(visible)
      .map((el) => ({ id: el.id || el.className || el.textContent?.slice(0, 20) || '', ...box(el) }))
    const bar = box(document.getElementById('topbar')!)
    const right = box(document.getElementById('topbar-right')!)
    const chips = [...document.querySelectorAll('#topbar .chip')].filter(visible).map(box)
    const townBtn = document.getElementById('town-button')
    return {
      items, bar, right, chips,
      nameShown: !!document.getElementById('town-name') && visible(document.getElementById('town-name')!),
      townButton: townBtn ? { text: townBtn.textContent, title: townBtn.getAttribute('title'), cut: townBtn.scrollWidth > townBtn.clientWidth, ...box(townBtn) } : null,
    }
  }, name)
}

function overlaps(a: { l: number; r: number; t: number; b: number }, b: { l: number; r: number; t: number; b: number }): boolean {
  return a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5
}

test.describe('the top bar with a long town name', () => {
  for (const width of [1920, 1440, 1360, 1320, 1280, 960]) {
    test(`shows the name once, and nothing overlaps or is cut off at ${width}px`, async ({ town, page }) => {
      await page.route('**/api/towns', (route) => route.fulfill({ json: TOWNS }))
      await page.setViewportSize({ width, height: 800 })
      await town.open()
      // the widest ordinary font, so a machine whose fonts are wider than the developer's does not make the bar overflow
      await page.addStyleTag({ content: "* { font-family: 'DejaVu Sans', sans-serif !important; }" })
      await expect(page.locator('#town-button')).toBeVisible()

      const m = await measure(page, LONG)

      // one name: the dropdown, not a second box beside it
      expect(m.nameShown, 'the town name is drawn twice').toBe(false)
      expect(m.townButton!.text).toContain(LONG)
      // the dropdown may shorten a long name with an ellipsis, and the full name is still there to read
      expect(m.townButton!.title ?? '').toContain(LONG)
      // nothing overlaps, and everything stays inside the bar
      for (let i = 0; i < m.items.length; i++) {
        expect(m.items[i].l, `${m.items[i].id} starts left of the bar`).toBeGreaterThanOrEqual(m.bar.l - 0.5)
        expect(m.items[i].r, `${m.items[i].id} ends right of the bar`).toBeLessThanOrEqual(m.bar.r + 0.5)
        for (let j = i + 1; j < m.items.length; j++)
          expect(overlaps(m.items[i], m.items[j]), `${m.items[i].id} overlaps ${m.items[j].id}`).toBe(false)
      }
      // the counters are all there, none clipped by the box they sit in
      for (const c of m.chips) expect(c.r).toBeLessThanOrEqual(m.right.r + 0.5)
      // Wall mode stays reachable: its button, or (when the bar gave the buttons up) the "⋯" menu that holds it
      const wallReachable = await page.evaluate(() => {
        const shown = (id: string) => { const e = document.getElementById(id); return !!e && e.offsetParent !== null }
        return shown('wall-button') || shown('more-button')
      })
      expect(wallReachable, 'neither the Wall button nor the ⋯ menu is on the bar').toBe(true)
      // the search keeps room to type in
      const search = m.items.find((i) => i.id === 'search-input')!
      expect(search.r - search.l).toBeGreaterThanOrEqual(80)
      // the list that opens shows the full name
      await page.locator('#town-button').click()
      await expect(page.locator('#town-list')).toContainText(LONG)
    })
  }

  test('a town with no other town to switch to still shows its name, once', async ({ town, page }) => {
    await page.route('**/api/towns', (route) => route.fulfill({ json: [] }))
    await town.open()
    await expect(page.locator('#town-button')).toHaveCount(0)
    await expect(page.locator('#town-name')).toHaveText('Mini Town')
    expect(await page.locator('#topbar').getByText('Mini Town').count()).toBe(1)
  })
})

test.describe('the ⋯ menu a full top bar keeps its buttons in', () => {
  test('is not on the bar while the buttons fit', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#more-button')).toBeHidden()
    await expect(page.locator('#wall-button')).toBeVisible()
  })

  test('takes Wall, Dashboard and Day/Dusk when the bar is at its last step, and each still works', async ({ town, page }) => {
    // a long town name in the widest font at 1320px fills the bar to its last step
    await page.route('**/api/towns', (route) => route.fulfill({ json: TOWNS }))
    await page.setViewportSize({ width: 1320, height: 800 })
    await town.open()
    await page.addStyleTag({ content: "* { font-family: 'DejaVu Sans', sans-serif !important; }" })
    await expect(page.locator('#topbar.fit-7')).toHaveCount(1)
    await expect(page.locator('#more-button')).toBeVisible()
    for (const id of ['wall-button', 'view-switch', 'lighting']) await expect(page.locator(`#${id}`)).toBeHidden()

    await page.locator('#more-button').click()
    await expect(page.locator('#more-menu button')).toHaveText(['Wall', 'Dashboard', /Day|Dusk/])
    await page.keyboard.press('Escape')
    await expect(page.locator('#more-menu')).toBeHidden()

    await page.locator('#more-button').click()
    const before = await page.evaluate(() => (window as any).city.lighting())
    await page.locator('#more-menu button[data-for="lighting"]').click()
    expect(await page.evaluate(() => (window as any).city.lighting())).not.toBe(before)
    await expect(page.locator('#more-menu')).toBeHidden()

    await page.locator('#more-button').click()
    await page.locator('#more-menu button[data-for="wall-button"]').click()
    await page.waitForFunction(() => document.body.classList.contains('wall') && (window as any).city?.seen.snapshots > 0)
    expect(await page.evaluate(() => localStorage.getItem('oc.wall'))).toBe('1')
  })
})
