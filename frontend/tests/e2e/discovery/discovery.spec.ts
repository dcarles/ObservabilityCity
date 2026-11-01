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
