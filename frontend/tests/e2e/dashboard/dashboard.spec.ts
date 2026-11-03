import { test, expect } from '../support/test'
import type { Page } from '@playwright/test'

// The plain dashboard on the tenants town (pillars Alpha and Billing; aa.orders-db and bb.billing-db keep a database for each tenant).
// Everything is read from what the page draws.

const dash = (page: Page) => page.locator('#dash-root')

async function open(town: { reset(): Promise<void> }, page: Page, query = ''): Promise<void> {
  await town.reset()
  await page.goto(`/?view=dashboard${query}`)
  await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)
  await expect(page.locator('#dash-pillars .card').first()).toBeVisible()
}

/** Waits until the page has taken `n` more snapshots. */
/** Opens a group of the table unless it opened by itself. */
async function openGroup(page: Page, pillar: string, name: string): Promise<void> {
  const group = page.locator(`[data-pillar="${pillar}"] tr.g`, { hasText: name })
  if ((await group.getAttribute('aria-expanded')) === 'false') await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'true')
}

async function snapshots(page: Page, n: number): Promise<void> {
  const from = await page.evaluate(() => (window as any).dash.seen.snapshots)
  await page.waitForFunction((t) => (window as any).dash.seen.snapshots >= t, from + n)
}

test.describe('the dashboard view', () => {
  test('opens without the 3D town: no three.js, no canvas, the company name from config in the menu', async ({ town, page }) => {
    const loaded: string[] = []
    page.on('request', (r) => { if (/three/i.test(r.url())) loaded.push(r.url()) })
    await open(town, page)
    expect(loaded).toEqual([])
    expect(await page.evaluate(() => (window as any).city)).toBeUndefined()
    await expect(page.locator('#town')).toBeHidden()
    await expect(page.locator('#dash-brand')).toHaveText('Tenants Town')
    await expect(page.locator('#vs-dash')).toHaveAttribute('aria-pressed', 'true')
  })

  test('the switch goes to the town and back, and the browser remembers the last view', async ({ town, page }) => {
    await open(town, page)
    await page.locator('#vs-town').click()
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    expect(new URL(page.url()).searchParams.get('view')).toBe('town')
    await page.goto('/') // no ?view=: this browser last chose the town
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    await page.locator('#view-switch').click()
    await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)
    await page.goto('/') // now the dashboard is what it remembers
    await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)
    await expect(dash(page)).toBeVisible()
  })

  test('a healthy pillar card shows only its name; the summary says everything is healthy', async ({ town, page }) => {
    await open(town, page)
    await expect(page.locator('#kpi-services')).toContainText('0 down · 0 degraded')
    await expect(page.locator('#kpi-services')).toContainText('All services are healthy')
    const card = page.locator('[data-pillar="aa"]')
    await expect(card.locator('h3')).toContainText('Alpha')
    await expect(card.locator('.m')).toHaveCount(0)
    await expect(card.locator('.issues')).toHaveCount(0)
    await expect(card).not.toHaveClass(/warn|bad/)
    // nothing below the menu speaks of towns, cities, buildings or islands
    const words = (await page.locator('#dash-sum').innerText()) + (await page.locator('#dash-pillars').innerText())
    expect(words).not.toMatch(/\b(town|city|building|island)s?\b/i)
  })

  test('a failing service shows counts, a chip with its reason, and opens its group by itself', async ({ town, page }) => {
    await open(town, page)
    await town.effect('aa.orders-api', 'Errors', 1)
    await expect(page.locator('#kpi-services')).not.toContainText('0 down · 0 degraded', { timeout: 30_000 })
    const card = page.locator('[data-pillar="aa"]')
    await expect(card).toHaveClass(/warn|bad/)
    await expect(card.locator('.issues .chip', { hasText: 'Orders API' })).toContainText('error rate')
    await expect(page.locator('#kpi-services .ch', { hasText: 'Orders API' })).toContainText('Alpha')
    await card.locator('[data-toggle]').click()
    const group = card.locator('tr.g', { hasText: 'orders' })
    await expect(group).toHaveAttribute('aria-expanded', 'true') // the group with the problem opens by itself
    await expect(card.locator('tr.row[data-system="aa.orders-api"]')).toBeVisible()
  })

  test('a database with a tenant database each expands to one line per tenant, with the test tenants tagged and hideable', async ({ town, page }) => {
    await open(town, page)
    const card = page.locator('[data-pillar="aa"]')
    await card.locator('[data-toggle]').click()
    await openGroup(page, 'aa', 'orders')
    const dbRow = card.locator('tr.row[data-system="aa.orders-db"]')
    await expect(dbRow).toContainText('tenants')
    await dbRow.locator('[data-db]').click()
    await expect(card.locator('tr.sub')).not.toHaveCount(0)
    await expect(card.locator('tr.sub', { hasText: /smoke/i }).locator('.test')).toHaveText('test')
    // the tenant filter in the menu is the town's: hide test tenants removes those lines
    await page.locator('#tenant-button').click()
    await page.locator('#hide-test').check({ force: true })
    await expect(card.locator('tr.sub', { hasText: /smoke/i })).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).dash.tenantView().hideTest)).toBe(true)
  })

  test('hiding a pillar removes its card, offers it back, and the choice is the same in the town', async ({ town, page }) => {
    await open(town, page)
    await page.locator('[data-pillar="bb"] [data-hide]').click()
    await expect(page.locator('[data-pillar="bb"]')).toHaveCount(0)
    await expect(page.locator('#hidden-pillars [data-show="bb"]')).toBeVisible()
    expect(new URL(page.url()).searchParams.get('islands')).toBe('aa')
    await page.locator('#vs-town').click()
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    expect(await page.evaluate(() => (window as any).city.islands())).toEqual(['aa'])
    await page.locator('#view-switch').click()
    await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)
    await page.locator('#hidden-pillars [data-show="bb"]').click()
    await expect(page.locator('[data-pillar="bb"]')).toBeVisible()
    await page.locator('#pillars-button').click()
    await expect(page.locator('#pillar-menu input')).toHaveCount(2)
    await page.locator('#pillar-menu input[data-pillar-box="aa"]').uncheck()
    await expect(page.locator('[data-pillar="aa"]')).toHaveCount(0)
  })

  test('what the viewer opened stays open, and the page does not jump, when new snapshots arrive', async ({ town, page }) => {
    await open(town, page)
    const card = page.locator('[data-pillar="aa"]')
    await card.locator('[data-toggle]').click()
    await openGroup(page, 'aa', 'orders')
    await expect(card.locator('tr.row[data-system="aa.orders-api"]')).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, 120))
    await snapshots(page, 3)
    await expect(card.locator('tr.row[data-system="aa.orders-api"]')).toBeVisible()
    expect(await page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(120)
  })

  test('a click on a row opens the detail drawer', async ({ town, page }) => {
    await open(town, page)
    const card = page.locator('[data-pillar="aa"]')
    await card.locator('[data-toggle]').click()
    await openGroup(page, 'aa', 'orders')
    await card.locator('tr.row[data-system="aa.orders-api"]').locator('td').first().click()
    await expect(page.locator('#inspector')).toBeVisible()
    await expect(page.locator('#inspector')).toContainText('Orders API')
  })

  for (const [name, width] of [['desktop', 1280], ['phone', 390]] as const)
    for (const scheme of ['light', 'dark'] as const)
      test(`no sideways scrolling on ${name} in ${scheme}`, async ({ town, page }) => {
        await page.setViewportSize({ width, height: 800 })
        await page.emulateMedia({ colorScheme: scheme })
        await open(town, page)
        for (const id of ['aa', 'bb']) {
          await page.locator(`[data-pillar="${id}"] [data-toggle]`).click()
          for (const g of await page.locator(`[data-pillar="${id}"] tr.g`).all()) await g.click()
        }
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        expect(over).toBeLessThanOrEqual(0)
        expect(await page.evaluate(() => document.body.dataset.mode)).toBe(scheme)
      })

  test('the narrow screen drops the minor columns and keeps traffic, connections and the details button', async ({ town, page }) => {
    await page.setViewportSize({ width: 700, height: 800 })
    await open(town, page)
    await page.locator('[data-pillar="aa"] [data-toggle]').click()
    for (const h of ['Errors', 'Latency', 'Load']) await expect(page.locator('[data-pillar="aa"] thead th', { hasText: h }).first()).toBeHidden()
    for (const h of ['Service', 'Traffic', 'Connections']) await expect(page.locator('[data-pillar="aa"] thead th', { hasText: h }).first()).toBeVisible()
    await openGroup(page, 'aa', 'orders')
    await expect(page.locator('[data-pillar="aa"] tr.row[data-system="aa.orders-api"] .det')).toBeVisible()
  })

  test('the table has the new columns and says nothing about queues', async ({ town, page }) => {
    await open(town, page)
    await page.locator('[data-pillar="aa"] [data-toggle]').click()
    const heads = await page.locator('[data-pillar="aa"] thead th').evaluateAll((cells) => cells.map((c) => c.firstChild?.textContent ?? ''))
    expect(heads).toEqual(['Service', 'Traffic', 'Errors', 'Latency', 'Load', 'Connections', ''])
    const text = await page.locator('[data-pillar="aa"] table.svc').innerText()
    expect(text).not.toMatch(/backlog|waiting|queue/i)
    // a group header is words, not an id
    await expect(page.locator('[data-pillar="aa"] tr.g .nm').first()).not.toHaveText(/[-_.]/)
  })

  test('the connections button opens the callers and calls under its row and closes them again', async ({ town, page }) => {
    await open(town, page)
    await page.locator('[data-pillar="aa"] [data-toggle]').click()
    await openGroup(page, 'aa', 'orders')
    const row = page.locator('[data-pillar="aa"] tr.row[data-system="aa.orders-api"]')
    const button = row.locator('.conn')
    await expect(button).toHaveText(/caller|call/)
    await expect(page.locator('[data-pillar="aa"] .cx')).toHaveCount(0)
    await button.click()
    await expect(page.locator('[data-pillar="aa"] .cx')).toHaveCount(1)
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await snapshots(page, 2)
    await expect(page.locator('[data-pillar="aa"] .cx')).toHaveCount(1) // stays open across snapshots
    await button.click()
    await expect(page.locator('[data-pillar="aa"] .cx')).toHaveCount(0)
  })

  /** Feeds the page a snapshot made from the live one and reads the table in the same breath, so a newer snapshot cannot undo it. */
  async function withSnapshot<T>(page: Page, edit: string, read: string): Promise<T> {
    return page.evaluate(async ([editCode, readCode]) => {
      const s = await (await fetch('/api/snapshot/latest')).json()
      const node = (id: string) => s.groups.flatMap((g: any) => g.nodes).find((n: any) => n.id === id)
      new Function('s', 'node', editCode)(s, node)
      ;(window as any).dash.feed(s)
      return new Function('document', readCode)(document)
    }, [edit, read]) as Promise<T>
  }

  test('a service with dead letters shows a red DLQ on its line and turns amber, with its group and pillar', async ({ town, page }) => {
    await open(town, page)
    await page.locator('[data-pillar="aa"] [data-toggle]').click()
    await openGroup(page, 'aa', 'orders')
    const read = `const c = document.querySelector('[data-pillar="aa"]'); const r = c.querySelector('tr.row[data-system="aa.orders-api"]')
      return { line: r.querySelector('.ind .dlq')?.textContent, lineClass: r.querySelector('.ind .dlq')?.className, dot: r.querySelector('.dot')?.className, group: c.querySelector('tr.g .dot')?.className, pillar: c.className, head: c.querySelector('.head .m b.bad')?.textContent }`
    const got = await withSnapshot<Record<string, string>>(page, `const n = node('aa.orders-api'); n.deadLetters = 3; n.absent = n.absent.filter(a => a !== 'deadLetters'); for (const m of s.groups.flatMap(g => g.nodes)) if (m.id !== n.id) m.deadLetters = 0`, read)
    expect(got.line).toBe('DLQ 3')
    expect(got.lineClass).toContain('bad')
    expect(got.dot).toContain('warn')
    expect(got.pillar).toContain('warn')
    expect(got.head).toBe('3')
  })

  test('Details on a service row opens the drawer on the Overview tab', async ({ town, page }) => {
    await open(town, page)
    const card = page.locator('[data-pillar="aa"]')
    await card.locator('[data-toggle]').click()
    await openGroup(page, 'aa', 'orders')
    await card.locator('tr.row[data-system="aa.orders-api"] .det').click()
    await expect(page.locator('#inspector')).toBeVisible()
    await expect(page.locator('#inspector')).toContainText('Orders API')
    await expect(page.locator('#inspector [data-tab].on')).toHaveText(/Overview/)
  })

  test('errors are green at zero and red above, and latency is green under its target, amber near it and red over it', async ({ town, page }) => {
    await open(town, page)
    await page.locator('[data-pillar="aa"] [data-toggle]').click()
    await openGroup(page, 'aa', 'orders')
    const cls = (id: string, sel: string) => `return document.querySelector('[data-pillar="aa"] tr.row[data-system="${id}"] ${sel}')?.className`
    const zero = await withSnapshot<string>(page, `node('aa.orders-api').errorRate = 0`, cls('aa.orders-api', 'td:nth-child(3) span'))
    expect(zero).toBe('errok')
    const some = await withSnapshot<string>(page, `node('aa.orders-api').errorRate = 0.004`, cls('aa.orders-api', 'td:nth-child(3) span'))
    expect(some).toBe('err')
    for (const [p99, want] of [[400, 'ok'], [95, 'warn'], [130, 'bad']] as const) {
      const got = await withSnapshot<string>(page, `const n = node('aa.orders-api'); n.p99Ms = ${p99}; n.slaP99Ms = ${want === 'ok' ? 500 : 100}`, cls('aa.orders-api', 'td:nth-child(4) .lat'))
      expect(got).toBe(`lat ${want}`)
    }
    const sla = await withSnapshot<string>(page, `const n = node('aa.orders-api'); n.p99Ms = 400; n.slaP99Ms = 500`, `return document.querySelector('[data-pillar="aa"] tr.row[data-system="aa.orders-api"] .sla')?.textContent`)
    expect(sla).toBe('SLA 500 ms')
  })

  test('a service in two regions shows its instances, traffic share, CPU and memory for each region', async ({ town, page }) => {
    await open(town, page)
    await page.locator('[data-pillar="aa"] [data-toggle]').click()
    await openGroup(page, 'aa', 'orders')
    const edit = `const n = node('aa.orders-api')
      n.regions = [{ region: 'a', label: 'North', instances: 2, cpu: 0.35, memory: 0.6, share: 0.62 }, { region: 'b', label: 'West', instances: 1, cpu: 0.41, memory: 0.66, share: 0.38 }]`
    const read = `const r = document.querySelector('[data-pillar="aa"] tr.row[data-system="aa.orders-api"]')
      return { name: r.querySelector('.ind small').textContent, traffic: r.querySelector('.rl')?.textContent, segs: r.querySelectorAll('.ld .rseg').length, tags: [...r.querySelectorAll('.ld .lrow:first-child .rt')].map(x => x.textContent), figures: [...r.querySelectorAll('.ld .lrow:first-child .mv')].map(x => x.textContent) }`
    const got = await withSnapshot<{ name: string; traffic: string; segs: number; tags: string[]; figures: string[] }>(page, edit, read)
    expect(got.name).toContain('2 North · 1 West')
    expect(got.traffic).toBe('North 62% · West 38%')
    expect(got.segs).toBe(4)
    expect(got.tags).toEqual(['N', 'W'])
    expect(got.figures).toEqual(['35%', '41%'])
  })

  test('a database shows the max throughput of its worst tenant, and each tenant line its own', async ({ town, page }) => {
    await open(town, page)
    await page.locator('[data-pillar="aa"] [data-toggle]').click()
    await openGroup(page, 'aa', 'orders')
    const edit = `const t = node('aa.orders-db').tenants
      t.forEach((u, i) => { u.utilisation = 0.2 + i * 0.01; u.limit = 1000 * (i + 1); u.throttled = 0 })
      t[0].utilisation = 0.9; t[0].limit = 4000`
    const read = `const r = document.querySelector('[data-pillar="aa"] tr.row[data-system="aa.orders-db"] .mx')
      return { db: r?.textContent, lines: [...document.querySelectorAll('[data-pillar="aa"] tr.sub .mx')].map(x => x.textContent) }`
    const got = await withSnapshot<{ db: string; lines: string[] }>(page, edit, read)
    expect(got.db).toContain('max 4,000 RU/s')
    expect(got.lines).toContain('max 4,000 RU/s')
    expect(got.lines.length).toBeGreaterThan(1)
  })

  test('the column titles stay under the menu while the table scrolls, and leave when the last service row reaches them', async ({ town, page }) => {
    await page.setViewportSize({ width: 1300, height: 380 })
    await open(town, page)
    await page.locator('[data-pillar="aa"] [data-toggle]').click()
    for (const g of await page.locator('[data-pillar="aa"] tr.g').all()) if ((await g.getAttribute('aria-expanded')) === 'false') await g.click()
    const measure = () => page.evaluate(() => {
      const t = document.querySelector('[data-pillar="aa"] table.svc')!
      const th = t.querySelector('thead th')!.getBoundingClientRect()
      const rows = t.querySelectorAll('tbody tr.row')
      const last = rows[rows.length - 1]!.getBoundingClientRect()
      const menu = document.getElementById('dash-menu')!.getBoundingClientRect()
      return { thTop: th.top, thBottom: th.bottom, lastTop: last.top, menuBottom: menu.bottom }
    })
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(150)
    const start = await measure()
    expect(start.thTop).toBeGreaterThan(start.menuBottom) // before the table scrolls they sit in their own place
    // scrolled into the table: stuck right under the menu
    await page.evaluate(() => window.scrollTo(0, document.querySelector('[data-pillar="aa"] table.svc thead')!.getBoundingClientRect().top + window.scrollY + 150))
    await page.waitForTimeout(150)
    const mid = await measure()
    expect(Math.abs(mid.thTop - mid.menuBottom)).toBeLessThan(2)
    // scrolled until the last row is just below the titles: they sit on it and go up with it
    await page.evaluate(() => { const rows = document.querySelectorAll('[data-pillar="aa"] table.svc tbody tr.row'); const r = rows[rows.length - 1]!; window.scrollTo(0, window.scrollY + r.getBoundingClientRect().top - 130) })
    await page.waitForTimeout(150)
    const end = await measure()
    expect(end.thBottom).toBeLessThanOrEqual(end.lastTop + 1)
    // and back to the top: they return to their own place
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(150)
    const top = await measure()
    expect(top.thTop).toBeCloseTo(start.thTop, 0)
  })

  test('the hub list starts closed with a one-line summary, opens on a click and stays open across snapshots', async ({ town, page }) => {
    await open(town, page)
    const hub = page.locator('details[data-section="hub"]')
    await expect(hub).toBeVisible()
    await expect(hub).not.toHaveAttribute('open', '')
    await expect(hub.locator('summary')).toContainText(/\d+ resources?/)
    await hub.locator('summary').click()
    await expect(hub.locator('tbody tr')).not.toHaveCount(0)
    await snapshots(page, 3)
    await expect(hub).toHaveAttribute('open', '')
    expect(await page.evaluate(() => [...(window as any).dash.ui.sections])).toEqual(['hub'])
  })

  test('the freshness marker counts up, the popup lists the sources inside the screen, and the marker turns amber when snapshots stop', async ({ town, page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await open(town, page)
    const button = page.locator('#fresh-button')
    await expect(button).toContainText(/Connected · snapshot \d+ s ago/)
    await expect(button).not.toHaveClass(/late/)
    await button.click()
    const pop = page.locator('#fresh-pop')
    await expect(pop).toBeVisible()
    await expect(pop).toContainText('Data freshness')
    const box = (await pop.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    await page.keyboard.press('Escape')
    await expect(pop).toBeHidden()
    await button.click()
    await page.locator('#dash-brand').click()
    await expect(pop).toBeHidden()
    await page.evaluate(() => (window as any).dash.ageFeed(120))
    await expect(button).toHaveClass(/late/)
    await snapshots(page, 1)
    await expect(button).not.toHaveClass(/late/)
  })

  /** The brightness (0 to 255) of an element's background, from its computed colour. */
  const brightness = (page: Page, selector: string) =>
    page.locator(selector).first().evaluate((el) => {
      // a control that was just drawn has no colour for a moment (it fades in): -1 means "not yet"
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)
      if (!m) return -1
      const [r, g, b] = m.map(Number)
      return (r + g + b) / 3
    })

  test('in dark mode the drawer and the tenant list are dark, in light mode they are light', async ({ town, page }) => {
    for (const [scheme, dark] of [['dark', true], ['light', false]] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await open(town, page)
      await page.locator('#tenant-button').click()
      await expect(page.locator('#tenant-list')).toBeVisible()
      expect((await brightness(page, '#tenant-list')) < 128).toBe(dark)
      expect((await brightness(page, '#tenant-query')) < 128).toBe(dark)
      expect((await brightness(page, '#tenant-button')) < 128).toBe(dark)
      await page.keyboard.press('Escape')
      const card = page.locator('[data-pillar="aa"]')
      await card.locator('[data-toggle]').click()
      await openGroup(page, 'aa', 'orders')
      await card.locator('tr.row[data-system="aa.orders-api"] td').first().click()
      await expect(page.locator('#inspector')).toBeVisible()
      expect((await brightness(page, '#inspector')) < 128).toBe(dark)
      await page.locator('#inspector [data-tab="logs"]').click()
      await expect(page.locator('#inspector [data-refresh-logs]')).toBeVisible()
      await expect.poll(() => brightness(page, '#inspector [data-refresh-logs]')).toBeGreaterThanOrEqual(0)
      expect((await brightness(page, '#inspector [data-refresh-logs]')) < 128).toBe(dark)
    }
  })

  test('the page scrolls down when it is longer than the screen, and so does an open drawer', async ({ town, page }) => {
    await page.setViewportSize({ width: 1000, height: 420 })
    await open(town, page)
    for (const id of ['aa', 'bb']) {
      await page.locator(`[data-pillar="${id}"] [data-toggle]`).click()
      for (const g of await page.locator(`[data-pillar="${id}"] tr.g`).all()) await g.click()
    }
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight > window.innerHeight)).toBe(true)
    // the town's stylesheet locks the page; the dashboard must not inherit that
    expect(await page.evaluate(() => [getComputedStyle(document.documentElement).overflowY, getComputedStyle(document.body).overflowY])).not.toContain('hidden')
    await page.mouse.move(300, 300)
    await page.mouse.wheel(0, 400)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
    await page.locator('[data-pillar="aa"] tr.row').first().locator('td').first().click()
    await expect(page.locator('#inspector')).toBeVisible()
    const body = page.locator('#inspector .body')
    const scrollable = await body.evaluate((el) => el.scrollHeight > el.clientHeight)
    if (scrollable) {
      await body.hover()
      await page.mouse.wheel(0, 300)
      await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    }
    const box = (await page.locator('#inspector').boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(420)
  })

  test('the status dot sits level with the text in the Services chips', async ({ town, page }) => {
    await open(town, page)
    await town.effect('aa.orders-api', 'Errors', 1)
    const chip = page.locator('#kpi-services .ch').first()
    await expect(chip).toBeVisible({ timeout: 30_000 })
    const [dot, box] = await Promise.all([chip.locator('.dot').boundingBox(), chip.boundingBox()])
    expect(Math.abs(dot!.y + dot!.height / 2 - (box!.y + box!.height / 2))).toBeLessThanOrEqual(3)
    expect(box!.height).toBeLessThan(40) // one line, the dot is not on a line of its own
  })
})
