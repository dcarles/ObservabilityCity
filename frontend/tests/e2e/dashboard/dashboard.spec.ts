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
    // hold back the server's snapshots: a redraw while the test clicks on the rows detached them and timed the click out
    await page.evaluate(() => (window as any).dash.hold(true))
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

  /** Feeds the page a snapshot made from the live one and reads the table in the same breath, and holds back the server's own snapshots so a newer one cannot undo it before the test clicks on what it fed (that race made the dead-letter tests fail on a slow runner). */
  async function withSnapshot<T>(page: Page, edit: string, read: string): Promise<T> {
    return page.evaluate(async ([editCode, readCode]) => {
      const s = await (await fetch('/api/snapshot/latest')).json()
      const node = (id: string) => s.groups.flatMap((g: any) => g.nodes).find((n: any) => n.id === id)
      new Function('s', 'node', editCode)(s, node)
      ;(window as any).dash.hold(true)
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

  test('the Dead letters card lists each queue with dead letters, worst first, and a row opens that service', async ({ town, page }) => {
    await open(town, page)
    const edit = `for (const m of s.groups.flatMap(g => g.nodes)) { m.deadLetters = 0; m.queues = [] }
      const a = node('aa.orders-api'); a.absent = a.absent.filter(x => x !== 'deadLetters'); a.state = 'Healthy'; a.deadLetters = 9; s.totals.deadLetters = 9; a.queues = [{ name: 'q-small', backlog: 0, deadLetters: 2 }, { name: 'q-big', backlog: 0, deadLetters: 7 }]`
    const read = `const c = document.querySelector('#kpi-dlq'); return { total: c.querySelector('b').textContent, head: c.querySelector('.dh')?.textContent, rows: [...c.querySelectorAll('.dl')].map(r => r.textContent) }`
    const got = await withSnapshot<{ total: string; head: string; rows: string[] }>(page, edit, read)
    expect(got.total).toBe('9')
    expect(got.head).toBe('2 queues with dead letters')
    expect(got.rows).toHaveLength(2)
    expect(got.rows[0]).toContain('q-big · 7 dead')
    expect(got.rows[1]).toContain('q-small · 2 dead')
    // small text and no scroll bar: the card grows with the list
    const look = await page.locator('#kpi-dlq').evaluate((c) => ({ size: getComputedStyle(c.querySelector('.dl .what')!).fontSize, scrolls: [...c.querySelectorAll('*')].some((e) => e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY)) }))
    expect(look).toEqual({ size: '12px', scrolls: false })
    await page.locator('#kpi-dlq .dl').first().click()
    await expect(page.locator('#inspector')).toBeVisible()
  })

  test('dead letters in two regions: the Dead letters card has a row for each region with its tag, counts one queue, and the drawer links each region to its own tool', async ({ town, page }) => {
    await open(town, page)
    const edit = `for (const m of s.groups.flatMap(g => g.nodes)) { m.deadLetters = 0; m.queues = [] }
      const a = node('aa.orders-api'); a.absent = a.absent.filter(x => x !== 'deadLetters'); a.state = 'Healthy'; a.deadLetters = 11; s.totals.deadLetters = 11
      a.queues = [{ name: 'q-split', backlog: 0, deadLetters: 11, deadLetterRegions: [{ region: 'northeurope', label: 'North', count: 3, link: { name: 'Support North', url: 'https://north.example.test/q' } }, { region: 'westeurope', label: 'West', count: 8, link: { name: 'Support West', url: 'https://west.example.test/q' } }] }]`
    // the tag is small text on the same line as the queue and the count, not a big number on a line of its own (read in the same breath as the feed)
    const read = `const c = document.querySelector('#kpi-dlq'); const r = c.querySelector('.dl'); const tag = r.querySelector('.qreg'); const box = tag.getBoundingClientRect(); const line = r.querySelector('.q').getBoundingClientRect()
      return { head: c.querySelector('.dh').textContent, rows: [...c.querySelectorAll('.dl')].map(r => r.textContent), look: { size: getComputedStyle(tag).fontSize, display: getComputedStyle(tag).display, inside: box.top >= line.top - 1 && box.bottom <= line.bottom + 1, oneLine: line.height < 20 } }`
    const got = await withSnapshot<{ head: string; rows: string[]; look: object }>(page, edit, read)
    expect(got.look).toEqual({ size: '12px', display: 'inline', inside: true, oneLine: true })
    expect(got.head).toBe('1 queue with dead letters')
    expect(got.rows).toHaveLength(2)
    expect(got.rows[0]).toContain('q-split · West · 8 dead') // worst first
    expect(got.rows[1]).toContain('q-split · North · 3 dead')

    await page.locator('#kpi-dlq .dl').first().click()
    const row = page.locator('#inspector .row.queue[data-queue="q-split"]')
    await expect(row).toContainText('North 3 dead')
    await expect(row).toContainText('West 8 dead')
    const links = row.locator('a.out')
    await expect(links).toHaveCount(2)
    await expect(links.nth(0)).toHaveAttribute('href', 'https://north.example.test/q')
    await expect(links.nth(1)).toHaveAttribute('href', 'https://west.example.test/q')
  })

  test('a snapshot fed by hand stays on screen while the server sends its own', async ({ town, page }) => {
    await open(town, page)
    const edit = `for (const m of s.groups.flatMap(g => g.nodes)) { m.deadLetters = 0; m.queues = [] }
      const a = node('aa.orders-api'); a.absent = a.absent.filter(x => x !== 'deadLetters'); a.state = 'Healthy'; a.deadLetters = 4; s.totals.deadLetters = 4
      a.queues = [{ name: 'q-held', backlog: 0, deadLetters: 4 }]`
    await withSnapshot<string[]>(page, edit, `return [...document.querySelectorAll('#kpi-dlq .dl')].map(r => r.textContent)`)
    await page.waitForTimeout(3000) // long enough for the server to have sent several of its own
    await expect(page.locator('#kpi-dlq .dl')).toHaveCount(1)
    await expect(page.locator('#kpi-dlq .dl')).toContainText('q-held')
  })

  test('the Dead letters card says so when no queue has dead letters', async ({ town, page }) => {
    await open(town, page)
    const read = `return document.querySelector('#kpi-dlq .dlist').textContent`
    const text = await withSnapshot<string>(page, `for (const m of s.groups.flatMap(g => g.nodes)) { m.deadLetters = 0; m.queues = [] }`, read)
    expect(text).toBe('No queue has dead letters right now.')
  })

  const FLOW = `const aa = s.groups.find(g => g.id === 'aa'); const bb = s.groups.find(g => g.id === 'bb')
      for (const g of s.groups) { g.flow = undefined; for (const n of g.nodes) n.queues = [] }
      aa.flow = { sentPerSecond: 3200, receivedPerSecond: 0, windowSeconds: 900 }
      bb.flow = { sentPerSecond: null, receivedPerSecond: 40, windowSeconds: 900 }`

  test('the Message flow tile lists the pillars by what they send and receive, and the cards say the same', async ({ town, page }) => {
    await open(town, page)
    const read = `const t = document.querySelector('#kpi-flow'); return { lines: [...t.querySelectorAll('.fl')].map(l => l.textContent), bar: t.querySelector('.fbar i').style.width, button: !!t.querySelector('[data-flows-all]'), window: t.querySelector('.fwin')?.textContent ?? null, alpha: document.querySelector('[data-pillar="aa"] .pflow [data-flow]')?.textContent ?? null, billing: document.querySelector('[data-pillar="bb"] .pflow [data-flow]')?.textContent ?? null }`
    const got = await withSnapshot<{ lines: string[]; bar: string; button: boolean; window: string | null; alpha: string | null; billing: string | null }>(page, FLOW, read)
    expect(got.lines).toHaveLength(2)
    expect(got.lines[0]).toMatch(/sends ext3\.2k msg\/s/)
    expect(got.lines[0]).toContain('no messages received')
    expect(got.lines[1]).toContain('receives40 msg/s')
    expect(got.bar).toBe('100%')
    expect(got.button).toBe(false)
    expect(got.window).toBe('Average over the last 15 min')
    expect(got.alpha).toMatch(/^sends ext 3\.2k msg\/s · no messages received$/)
    expect(got.billing).toMatch(/^receives 40 msg\/s$/)
    await page.locator('[data-pillar="aa"] [data-toggle]').click()
    await expect(page.locator('[data-pillar="aa"] .pflowx')).toContainText('Sends outside')
    await expect(page.locator('[data-pillar="aa"] .pflowx')).toContainText('3.2k msg/s')
    await expect(page.locator('[data-pillar="aa"] .pflowx')).toContainText('no messages received')
    await page.locator('[data-pillar="bb"] [data-toggle]').click()
    await expect(page.locator('[data-pillar="bb"] .pflowx')).toContainText('Receives')
  })

  test('the Message flow tile is absent when no pillar moves a message', async ({ town, page }) => {
    await open(town, page)
    const present = await withSnapshot<boolean>(page, `for (const g of s.groups) { g.flow = g.isHub ? undefined : { sentPerSecond: 0, receivedPerSecond: 0, windowSeconds: 900 }; for (const n of g.nodes) n.queues = [] }`, `return !!document.querySelector('#kpi-flow')`)
    expect(present).toBe(false)
  })

  test('the summary cards share one row on a big screen and the Total traffic card lists the pillars', async ({ town, page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 })
    await open(town, page)
    const got = await withSnapshot<{ tops: number[]; rows: number; total: string | null; over: number }>(page, FLOW, `const k = [...document.querySelectorAll('#dash-root .sum .kpi')]; return { tops: k.map(x => Math.round(x.getBoundingClientRect().top)), rows: document.querySelectorAll('#kpi-traffic [data-pillar-traffic]').length, total: document.querySelector('#kpi-flow > b')?.textContent ?? null, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }`)
    expect(got.tops.length).toBeGreaterThanOrEqual(3)
    expect(new Set(got.tops).size).toBe(1)
    expect(got.rows).toBeGreaterThan(0)
    expect(got.over).toBeLessThanOrEqual(0)
  })

  test('the Message flow tile fits a phone screen without sideways scrolling', async ({ town, page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await open(town, page)
    const over = await withSnapshot<number>(page, FLOW, `return document.documentElement.scrollWidth - document.documentElement.clientWidth`)
    expect(over).toBeLessThanOrEqual(0)
    await expect(page.locator('#kpi-flow')).toBeVisible()
  })

  test('a queue whose dead letters were replayed leaves the Dead letters card on the next snapshot', async ({ town, page }) => {
    await open(town, page)
    const base = `for (const m of s.groups.flatMap(g => g.nodes)) { m.deadLetters = 0; m.queues = [] }
      const a = node('aa.orders-api'); a.absent = a.absent.filter(x => x !== 'deadLetters'); a.state = 'Healthy'; `
    const read = `return [...document.querySelectorAll('#kpi-dlq .dl')].map(r => r.textContent)`
    const before = await withSnapshot<string[]>(page, `${base}a.deadLetters = 12; s.totals.deadLetters = 12; a.queues = [{ name: 'q-replayed', backlog: 0, deadLetters: 12 }]`, read)
    expect(before).toHaveLength(1)
    const after = await withSnapshot<string[]>(page, `${base}a.deadLetters = 0; s.totals.deadLetters = 0; a.queues = [{ name: 'q-replayed', backlog: 0, deadLetters: 0 }]`, read)
    expect(after).toEqual([])
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

  test('the "?" in the menu opens a short legend inside the screen, and Escape or a click elsewhere closes it', async ({ town, page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await open(town, page)
    const pop = page.locator('#dash-legend')
    await expect(pop).toBeHidden()
    await page.locator('#dash-legend-button').click()
    await expect(pop).toBeVisible()
    await expect(pop).toContainText('What the colours mean')
    await expect(pop).toContainText('Never read as healthy')
    expect(await pop.locator('.dl-row').count()).toBeLessThanOrEqual(10)
    const box = (await pop.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    await page.keyboard.press('Escape')
    await expect(pop).toBeHidden()
    await page.locator('#dash-legend-button').click()
    await page.locator('#dash-brand').click()
    await expect(pop).toBeHidden()
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

  /** Waits for an element's background to settle on dark or light: the drawer redraws when its logs load and a new control takes its colour a moment later. */
  const expectScheme = (page: Page, selector: string, dark: boolean) =>
    expect.poll(async () => { const b = await brightness(page, selector); return b >= 0 && b < 128 === dark }, { message: `${selector} should be ${dark ? 'dark' : 'light'}` }).toBe(true)

  test('in dark mode the drawer and the tenant list are dark, in light mode they are light', async ({ town, page }) => {
    for (const [scheme, dark] of [['dark', true], ['light', false]] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await open(town, page)
      await page.locator('#tenant-button').click()
      await expect(page.locator('#tenant-list')).toBeVisible()
      await expectScheme(page, '#tenant-list', dark)
      await expectScheme(page, '#tenant-query', dark)
      await expectScheme(page, '#tenant-button', dark)
      await page.keyboard.press('Escape')
      const card = page.locator('[data-pillar="aa"]')
      await card.locator('[data-toggle]').click()
      await openGroup(page, 'aa', 'orders')
      await card.locator('tr.row[data-system="aa.orders-api"] td').first().click()
      await expect(page.locator('#inspector')).toBeVisible()
      await expectScheme(page, '#inspector', dark)
      await page.locator('#inspector [data-tab="logs"]').click()
      await expect(page.locator('#inspector [data-refresh-logs]')).toBeVisible()
      await expectScheme(page, '#inspector [data-refresh-logs]', dark)
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

  test('the environment and tenant lists sit side by side, and each opens under its own button', async ({ town, page }) => {
    await open(town, page)
    const boxes = await page.evaluate(() => [...document.querySelectorAll('#dash-filters .vb')].map((e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom } }))
    expect(boxes.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < boxes.length; i++) {
      expect(Math.abs(boxes[i].t - boxes[0].t), 'on one line').toBeLessThan(2)
      expect(boxes[i].l, 'to the right of the one before').toBeGreaterThanOrEqual(boxes[i - 1].r)
    }
    await page.locator('#dash-filters .vb-btn').first().click()
    const list = page.locator('#dash-filters .vb-list:visible').first()
    await expect(list).toBeVisible()
    const l = await list.boundingBox()
    const first = await page.locator('#dash-filters .vb').first().boundingBox()
    expect(Math.abs(l!.x - first!.x)).toBeLessThan(2) // under its own button
    expect(l!.y).toBeGreaterThanOrEqual(first!.y + first!.height)
  })

  test.describe('wall mode', () => {
    interface DashWall { mode: string; stop: { key: string; kind: string; cut: boolean } | null; open: string[]; focus: string | null; note: string | null; controls: { exitShown: boolean } | null }
    const wall = (page: Page) => page.evaluate(() => (window as any).dash.wall() as DashWall | null)
    const step = (page: Page, s: number) => page.evaluate((x) => (window as any).dash.wallStep(x), s)
    const remembered = (page: Page) => page.evaluate(() => localStorage.getItem('oc.wall'))

    test('the dashboard is not a wall unless asked for', async ({ town, page }) => {
      await open(town, page)
      expect(await wall(page)).toBeNull()
      await expect(page.locator('#wall-strip')).toHaveCount(0)
      await expect(page.locator('#dash-menu')).toBeVisible()
      await expect(page.locator('#wall-button-dash')).toBeVisible()
    })

    test('?wall=1&view=dashboard is a wall: no menu, big type, a strip, and no 3D town', async ({ town, page }) => {
      await open(town, page, '&wall=1&hold=2&overview=0')
      await expect(page.locator('#wall-strip')).toBeVisible()
      await expect(page.locator('#wall-headline')).toHaveText('ALL SYSTEMS HEALTHY')
      await expect(page.locator('#dash-menu')).toBeHidden()
      expect(await page.evaluate(() => (window as any).city)).toBeUndefined()
      const zoom = await page.locator('#dash-root').evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('zoom')))
      expect(zoom).toBeGreaterThan(1)
      expect((await wall(page))?.mode).toBe('calm')
    })

    test('the tour opens one pillar at a time and picks the service out', async ({ town, page }) => {
      await open(town, page, '&wall=1&hold=2&overview=0')
      const seen: string[] = []
      for (let i = 0; i < 6; i++) {
        await step(page, 2.05)
        const w = (await wall(page))!
        seen.push(w.stop!.key)
        if (w.stop!.key.startsWith('island:')) {
          const id = w.stop!.key.slice('island:'.length)
          expect(w.open).toEqual([id])
          await expect(page.locator(`[data-pillar="${id}"] table.svc`)).toBeVisible()
          await expect(page.locator('#dash-pillars table.svc')).toHaveCount(1)
        }
      }
      expect(seen.some((k) => k.startsWith('island:'))).toBe(true)
    })

    test('with trouble, the tour opens with a pillar overview (all pillars closed, top of the page) and comes back to it after the last stop', async ({ town, page }) => {
      await open(town, page, '&wall=1&hold=2&overview=4')
      await step(page, 11)
      const feed = (state: string) => page.evaluate(async (st) => {
        const s = await (await fetch('/api/snapshot/latest')).json()
        for (const n of s.groups.flatMap((g: any) => g.nodes)) n.state = n.id === 'aa.orders-api' ? st : 'Healthy'
        s.totals.down = st === 'Down' ? 1 : 0
        ;(window as any).dash.hold(true)
        ;(window as any).dash.feed(s)
      }, state)
      await feed('Healthy')
      await feed('Down')
      expect((await wall(page))!.stop).toMatchObject({ key: 'down:aa.orders-api', cut: true })
      await step(page, 2.05)
      const w = (await wall(page))!
      expect(w.stop).toMatchObject({ kind: 'overview', cut: false })
      await expect(page.locator('#wall-caption')).toHaveText('Overview: 1 system needs attention across 1 island')
      expect(w.open).toEqual([])
      await expect(page.locator('#dash-pillars table.svc')).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(5) // the scroll back to the top glides
      await step(page, 4)
      expect((await wall(page))!.stop).toMatchObject({ key: 'down:aa.orders-api', cut: false })
    })

    test('new trouble cuts to its service at once, picks it out, and a resolved note comes when it ends', async ({ town, page }) => {
      await open(town, page, '&wall=1&hold=2&overview=0')
      await step(page, 11)
      const feed = (state: string) => page.evaluate(async (st) => {
        const s = await (await fetch('/api/snapshot/latest')).json()
        for (const n of s.groups.flatMap((g: any) => g.nodes)) n.state = n.id === 'aa.orders-api' ? st : 'Healthy'
        s.totals.down = st === 'Down' ? 1 : 0 // the strip counts from the snapshot's totals
        ;(window as any).dash.hold(true)
        ;(window as any).dash.feed(s)
      }, state)
      await feed('Healthy')
      await feed('Down')
      const w = (await wall(page))!
      expect(w.mode).toBe('alert')
      expect(w.stop).toMatchObject({ key: 'down:aa.orders-api', cut: true })
      expect(w.open).toEqual(['aa'])
      expect(w.focus).toBe('aa.orders-api')
      await expect(page.locator('#dash-pillars tr.row.wall-focus')).toHaveAttribute('data-system', 'aa.orders-api')
      await expect(page.locator('#wall-strip')).toHaveAttribute('data-tone', 'bad')
      await feed('Healthy')
      expect((await wall(page))!.note).toContain('healthy again')
    })

    test('a system with dead letters is a stop of its own, named by queue, and is not counted as degraded', async ({ town, page }) => {
      await open(town, page, '&wall=1&hold=2&overview=0')
      await step(page, 11)
      const feed = (dead: number) => page.evaluate(async (n) => {
        const s = await (await fetch('/api/snapshot/latest')).json()
        for (const x of s.groups.flatMap((g: any) => g.nodes)) { x.state = 'Healthy'; x.deadLetters = 0; x.queues = [] }
        const node = s.groups.flatMap((g: any) => g.nodes).find((x: any) => x.id === 'aa.orders-api')
        node.absent = node.absent.filter((a: string) => a !== 'deadLetters')
        node.deadLetters = n
        node.queues = n ? [{ name: 'q-orders', backlog: 0, deadLetters: n }] : []
        ;(window as any).dash.hold(true)
        ;(window as any).dash.feed(s)
      }, dead)
      await feed(0)
      await feed(130)
      const w = (await wall(page))!
      expect(w.stop).toMatchObject({ key: 'deadLetters:aa.orders-api', kind: 'deadLetters', cut: true })
      expect(w.open).toEqual(['aa'])
      expect(w.focus).toBe('aa.orders-api')
      await expect(page.locator('#wall-caption')).toContainText('has 130 dead letters in q-orders')
      await expect(page.locator('#wall-headline')).not.toContainText('DEGRADED')
      await expect(page.locator('#kpi-services')).toContainText('0 down · 0 degraded')
      await expect(page.locator('#dash-pillars tr.row.wall-focus')).toHaveAttribute('data-system', 'aa.orders-api')
    })

    test('a frozen feed greys the wall and the strip says so', async ({ town, page }) => {
      await open(town, page, '&wall=1&hold=2&overview=0')
      await page.evaluate(() => (window as any).dash.muteFeed(true, 1000))
      await expect(page.locator('#wall-connection')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('#wall-connection')).toContainText('may be out of date')
    })

    test('the Wall button makes the page a wall, remembers it, and a reload stays a wall', async ({ town, page }) => {
      await open(town, page)
      await page.locator('#wall-button-dash').click()
      await page.waitForFunction(() => (window as any).dash?.wall()?.mode)
      await expect(page.locator('#wall-strip')).toBeVisible()
      expect(await remembered(page)).toBe('1')
      expect(new URL(page.url()).searchParams.has('wall')).toBe(false)
      await page.reload()
      await page.waitForFunction(() => (window as any).dash?.wall()?.mode)
    })

    test('Esc leaves wall mode and forgets it', async ({ town, page }) => {
      await open(town, page, '&wall=1')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0 && (window as any).dash.wall() === null)
      await expect(page.locator('#dash-menu')).toBeVisible()
      expect(await remembered(page)).toBe('0')
    })

    test('the Exit wall chip shows when the mouse moves, and leaves wall mode', async ({ town, page }) => {
      await open(town, page, '&wall=1')
      await expect(page.locator('#wall-exit')).toBeHidden()
      await page.mouse.move(200, 200)
      await page.mouse.move(260, 240)
      await expect(page.locator('#wall-exit')).toBeVisible()
      await page.locator('#wall-exit').click()
      await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0 && (window as any).dash.wall() === null)
      expect(await remembered(page)).toBe('0')
    })

    test('?wall=0 beats a remembered wall and forgets it', async ({ town, page }) => {
      await town.reset()
      await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('oc.wall', '1') } })
      await page.goto('/?view=dashboard&wall=0')
      await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)
      expect(await wall(page)).toBeNull()
      expect(await remembered(page)).toBe('0')
    })

    test('a remembered wall opens as a wall with nothing in the address', async ({ town, page }) => {
      await town.reset()
      await page.addInitScript(() => localStorage.setItem('oc.wall', '1'))
      await page.goto('/?view=dashboard')
      await page.waitForFunction(() => (window as any).dash?.wall()?.mode)
      await expect(page.locator('#wall-strip')).toBeVisible()
    })
  })
})
