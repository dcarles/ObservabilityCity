import { test, expect } from '../support/test'

// The first minute or two: some sources have not answered yet, so the town is greyed under a card and notices stay hidden until they all have. The page is handed
// snapshots as if the server had sent them (the live ones are held back), because a demo town has nothing to wait for.

const feed = (page: import('@playwright/test').Page, sources: { name: string; done: boolean }[]) =>
  page.evaluate((list) => {
    const c = (window as any).city
    const s = structuredClone(c.seen.last)
    s.mode = 'live'
    s.notices = ['a pillar file was skipped']
    s.sources = list.map((x) => ({ name: x.name, lastRead: null, intervalSeconds: 10, overdue: false, firstRoundDone: x.done }))
    c.hold(true)
    c.resetLoading() // the page has already seen its demo snapshots, which end the waiting for good
    c.feed(s)
  }, sources)

test('the town greys under a loading card until every source has answered, with the top bar left alone and notices hidden', async ({ town, page }) => {
  await town.open()
  await expect(page.locator('body')).not.toHaveClass(/loading-data/) // a demo town never waits

  await feed(page, [{ name: 'metrics', done: true }, { name: 'jobs', done: false }])
  await expect(page.locator('body')).toHaveClass(/loading-data/)
  await expect(page.locator('#loading-card')).toContainText('Loading town data')
  await expect(page.locator('#loading-card')).toContainText('1 of 2 sources ready')
  await expect(page.locator('#notices')).toBeHidden()
  expect(await page.locator('#topbar').evaluate((el) => getComputedStyle(el).filter)).toBe('none')
  expect(await page.locator('#town').evaluate((el) => getComputedStyle(el).filter)).toContain('grayscale')

  await feed(page, [{ name: 'metrics', done: true }, { name: 'jobs', done: true }])
  await expect(page.locator('body')).not.toHaveClass(/loading-data/)
  await expect(page.locator('#loading-card')).toHaveCount(0)
  await expect(page.locator('#notices')).toBeVisible()
})

test('the dashboard waits in the same way', async ({ town, page }) => {
  await town.reset()
  await page.goto('/?view=dashboard')
  await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)
  await page.evaluate(async () => {
    const d = (window as any).dash
    const s = await (await fetch('/api/snapshot/latest')).json()
    d.hold(true)
    d.resetLoading()
    s.mode = 'live'
    s.sources = [{ name: 'metrics', lastRead: null, intervalSeconds: 10, overdue: false, firstRoundDone: false }]
    d.feed(s)
  })
  await expect(page.locator('body')).toHaveClass(/loading-data/)
  await expect(page.locator('#loading-card')).toContainText('0 of 1 source ready')
})
