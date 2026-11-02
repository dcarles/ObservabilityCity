import { test, expect, type Page } from '@playwright/test'

// A live town whose pillar files say nothing about messaging: no topic, no subscription. The queue names alone say who publishes what and who reads it
// (bus.<publisher pillar>.<publisher service>.<reader service>.out), so the piers, the island to island boats and the queue rows come from the broker.

async function open(page: Page): Promise<void> {
  await page.goto('/?test=1&quality=low')
  await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
  // the inventory is read on the first poll and the broker's numbers after it
  await page.waitForFunction(
    () => (window as any).city.seen.last.groups.flatMap((g: any) => g.messaging?.subscriptions ?? []).length > 0,
    undefined, { timeout: 30_000 },
  )
}

type Sea = { harbours: string[]; unreachable: string[]; routes: { from: string | null; to: string; scheduler: boolean; rate: number }[] }
const sea = (page: Page): Promise<Sea> => page.evaluate(() => (window as any).city.town.inspectSea())

test.describe('the town the queue names build', () => {
  test('has the topics and the subscriptions the names say, though no pillar file does', async ({ page }) => {
    await open(page)

    const groups = await page.evaluate(() => (window as any).city.seen.last.groups.map((g: any) => ({ id: g.id, topics: g.messaging.topics.map((t: any) => t.name), subs: g.messaging.subscriptions.map((s: any) => `${s.publisher}>${s.consumer}`) })))
    const of = (id: string) => groups.find((g: any) => g.id === id)

    expect(of('aa').topics).toContain('bus.aa.orders.ledger.out') // aa's orders publishes what bb's ledger reads
    expect(of('bb').subs).toContain('aa>bb.ledger-worker')
    expect(of('aa').subs).toContain('bb>aa.orders-worker')
  })

  test('sail as boats from the publisher\'s island to the reader\'s, at the rate the queue gets messages', async ({ page }) => {
    await open(page)
    await page.waitForFunction(() => (window as any).city.town.inspectSea().routes.some((r: any) => r.from === 'bb' && r.to === 'aa' && r.rate > 0), undefined, { timeout: 15_000 })

    const s = await sea(page)

    expect(s.unreachable).toEqual([])
    expect(s.routes.some((r) => r.from === 'bb' && r.to === 'aa' && r.rate >= 1 / 30 - 1e-9)).toBe(true)
    expect(s.routes.some((r) => r.from === 'aa' && r.to === 'bb' && r.rate >= 1 / 30 - 1e-9)).toBe(true)
  })

  test('list each queue in the reader\'s drawer, with its messages a second', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.openSystem('aa.orders-worker'))

    const row = page.locator('#inspector .row.queue[data-queue="bus.bb.ledger.orders.out"]')
    await expect(row).toContainText('5 waiting')
    await expect(row).toContainText('6.0 msg/s') // 600 messages in each of three minutes, over the 300 second window of the source
  })
})
