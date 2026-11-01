import { test, expect, type Page } from '@playwright/test'
import { API } from '../support/city'

// A live town whose environment finds links from its dependency data. A recording stands in for the workspace, so nothing is read here; what an earlier
// run found is saved under _discovered/links/prod/ and the town shows it. The fixture holds a link seen on three days (drawn), one seen on a single day
// (not drawn), a link that is also declared, and an address no rule explains (a notice).

const node = async (request: any, id: string) => (await (await request.get(`${API}/api/snapshot/latest`)).json()).groups.flatMap((g: any) => g.nodes).find((n: any) => n.id === id)
const detail = async (request: any, id: string) => (await request.get(`${API}/api/systems/${id}`)).json()

async function openLinks(page: Page, name: string): Promise<void> {
  await page.goto('/?test=1&quality=low')
  await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
  await page.locator('#search-input').fill(name)
  await page.locator('#search-results .hit').first().click()
  await page.locator('#inspector [data-tab="links"]').click()
}

test.describe('a live town that finds links in its dependency data', () => {
  test('a link seen on enough days is in the snapshot the town is drawn from, as a gateway call or an ordinary call', async ({ request }) => {
    expect((await node(request, 'aa.orders-worker')).gatewayCalls).toContain('bb.ledger-api')
    expect((await node(request, 'bb.ledger-worker')).calls).toContain('bb.ledger-api')
  })

  test('a link seen on a single day is not drawn', async ({ request }) => {
    expect((await node(request, 'aa.orders-api')).gatewayCalls).not.toContain('bb.ledger-worker')
  })

  test('the declared links are all still there', async ({ request }) => {
    expect((await node(request, 'bb.ledger-worker')).calls).toContain('bb.ledger-db')
    expect((await node(request, 'aa.orders-api')).calls).toContain('aa.orders-db')
  })

  test('the inspector says, at both ends, which links were found and when they were last seen', async ({ request }) => {
    const caller = await detail(request, 'aa.orders-worker')
    const found = caller.gatewayCalls.find((l: any) => l.id === 'bb.ledger-api')
    expect(found).toMatchObject({ found: true, lastSeen: '2026-10-03' })
    const callee = await detail(request, 'bb.ledger-api')
    expect(callee.gatewayCalledBy.find((l: any) => l.id === 'aa.orders-worker')).toMatchObject({ found: true, lastSeen: '2026-10-03' })
    expect(caller.calls.find((l: any) => l.id === 'aa.orders-db')).toMatchObject({ found: false, lastSeen: null })
    expect(caller.config.find((c: any) => c.key === 'discoverLinks')).toMatchObject({ value: 'yes' })
  })

  test('the Links tab tags a found link "Seen in calls" and a declared one "Declared"', async ({ page }) => {
    await openLinks(page, 'Ledger worker')
    const foundRow = page.locator('#inspector .link', { hasText: 'Ledger API' })
    await expect(foundRow.locator('i.origin')).toHaveText('Seen in calls')
    await expect(foundRow.locator('i.origin')).toHaveAttribute('title', /last seen 2026-10-02/)
    await expect(page.locator('#inspector .link', { hasText: 'Ledger DB' }).locator('i.origin')).toHaveText('Declared')
  })

  test('an address no rule explains is listed under the notices, naming who called it and what is missing', async ({ page }) => {
    await page.goto('/?test=1&quality=low')
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    await page.click('#notices-toggle')
    const notice = page.locator('#notices li', { hasText: 'Unresolved call' })
    await expect(notice).toContainText("'aa.orders-api' calls mystery.a.example.test/q")
    await expect(notice).toContainText('no links rule explains it')
  })

  test('calls to a pillar the town does not have are a note, apart from the problems, and are not counted as one', async ({ page, request }) => {
    await page.goto('/?test=1&quality=low')
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    // one real problem (the address no rule explains) and one note (the pillar zz)
    await expect(page.locator('#notices-toggle')).toHaveText(/^1 config problem · 1 note /)
    await page.click('#notices-toggle')
    const note = page.locator('#notices li.note')
    await expect(note).toHaveCount(1)
    await expect(note).toContainText("Pillar 'zz' is not in the town yet")
    await expect(page.locator('#notices li:not(.note)')).toHaveCount(1)
    const snapshot = await (await request.get(`${API}/api/snapshot/latest`)).json()
    expect(snapshot.notes).toHaveLength(1)
    expect(snapshot.notices.some((n: string) => n.includes('/zz/'))).toBe(false)
  })
})

// The Logs tab of a live town. The recording beside the telemetry recording (telemetry.logs.json) stands in for the answer to the logs query, which is only
// asked when the tab is opened. Its rows are grouped by the query already; the town groups repeats of the same text and result, and keeps four sections.
test.describe('the Logs tab of a live town', () => {
  async function openLogs(page: Page, name: string): Promise<void> {
    await page.goto('/?test=1&quality=low')
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    await page.locator('#search-input').fill(name)
    await page.locator('#search-results .hit').first().click()
    await page.locator('#inspector [data-tab="logs"]').click()
  }

  test('an API has four separate sections, repeats grouped with a count and each request linking to its trace', async ({ page }) => {
    await openLogs(page, 'Orders API')
    const sections = page.locator('#inspector h4[data-section]')
    await expect(sections).toHaveText(['5xx requests', /^Slow requests \(over/, 'Warnings and errors', 'Exceptions'])
    // the two 500 groups of the same request are one line with the count added up, the newest operation behind its link
    const merged = page.locator('#inspector .log', { hasText: 'GET /api/orders' })
    await expect(merged).toHaveCount(1)
    await expect(merged).toContainText('×7')
    await expect(merged).toContainText('500')
    await expect(merged.locator('a.out')).toHaveAttribute('href', 'https://tracing.example.test/prod/trace/op-new')
    await expect(page.locator('#inspector .log', { hasText: 'POST /api/orders' })).toContainText('503')
    await expect(page.locator('#inspector .log', { hasText: 'GET /api/statements' })).toContainText('×7')
    // an entry with no operation has no link, and warnings and errors keep their colours
    const warn = page.locator('#inspector .log.warn', { hasText: 'Cache is cold' })
    await expect(warn).toContainText('×2')
    await expect(warn.locator('a.out')).toHaveCount(0)
    await expect(page.locator('#inspector .log.error', { hasText: 'Connection to the store was reset' }).locator('a.out')).toHaveCount(1)
    await expect(page.locator('#inspector .log', { hasText: 'TimeoutException' })).toContainText('×9')
  })

  test('a worker keeps only the warnings, errors and exceptions', async ({ page }) => {
    await openLogs(page, 'Orders worker')
    await expect(page.locator('#inspector h4[data-section]')).toHaveText(['Warnings and errors', 'Exceptions'])
    await expect(page.locator('#inspector .log', { hasText: 'GET /api/orders' })).toHaveCount(0)
  })

  test('a system with no telemetry name has no logs, and Refresh asks again', async ({ page }) => {
    await openLogs(page, 'Orders DB')
    await expect(page.locator('#inspector')).toContainText('no telemetry name')
    await expect(page.locator('#inspector h4[data-section]')).toHaveCount(0)
    const asked: string[] = []
    page.on('request', (r) => { if (r.url().includes('/logs')) asked.push(r.url()) })
    await page.locator('#inspector [data-refresh-logs]').click()
    await expect.poll(() => asked.length).toBe(1)
  })

  test('the tab asks once when it opens and is not polled', async ({ page }) => {
    const asked: string[] = []
    page.on('request', (r) => { if (r.url().includes('/logs')) asked.push(r.url()) })
    await openLogs(page, 'Orders API')
    await expect(page.locator('#inspector h4[data-section]').first()).toBeVisible()
    await page.waitForTimeout(3500)
    expect(asked).toHaveLength(1)
  })

  test('the endpoint answers the same sections', async ({ request }) => {
    const logs = await (await request.get(`${API}/api/systems/aa.orders-api/logs`)).json()
    expect(logs.configured).toBe(true)
    expect(logs.window).toBe('4h')
    expect(logs.sections.map((s: any) => s.id)).toEqual(['failed', 'slow', 'logs', 'exceptions'])
  })
})
