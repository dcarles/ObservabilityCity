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

test.describe('the kinds of message and the messages a second in all', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  test('a queue row lists its busiest kinds with their rate and the rest behind one line that opens the full list', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.openSystem('aa.orders-worker'))

    const types = page.locator('#inspector .types[data-types-for="bus.bb.ledger.orders.out"]')
    await expect(types.locator('.row.type')).toHaveCount(5) // the busiest five of seven
    await expect(types.locator('.row.type').first()).toContainText('OrderPlaced')
    await expect(types.locator('.row.type').first()).toContainText('2.0 msg/s') // 600 calls over the 300 second window
    await expect(types.locator('.types-toggle')).toHaveText('2 more kinds, 0.50 msg/s')

    await types.locator('.types-toggle').click()
    await expect(types.locator('.row.type')).toHaveCount(7)
    await expect(types.locator('.row.type').last()).toContainText('NoteAdded')
    await expect(types.locator('.types-toggle')).toHaveText('Show fewer kinds')

    await types.locator('.types-toggle').click()
    await expect(types.locator('.row.type')).toHaveCount(5)
  })

  test('the full list stays open when the drawer redraws with new numbers', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.openSystem('aa.orders-worker'))
    const types = page.locator('#inspector .types[data-types-for="bus.bb.ledger.orders.out"]')
    await types.locator('.types-toggle').click()
    await expect(types.locator('.row.type')).toHaveCount(7)

    await page.evaluate(() => (window as any).city.step?.(5))
    await page.waitForTimeout(500)

    await expect(page.locator('#inspector .types[data-types-for="bus.bb.ledger.orders.out"] .row.type')).toHaveCount(7)
  })

  test('the worker drawer says how many messages a second its queues take in all', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.openSystem('aa.orders-worker'))

    await expect(page.locator('#inspector h4', { hasText: 'Queues' }).locator('small')).toContainText('msg/s in total')
  })

  test('the top bar has the messages a second of the whole town, the sum of every queue', async ({ page }) => {
    await open(page)
    const sum = await page.evaluate(() => (window as any).city.seen.last.groups.flatMap((g: any) => g.nodes).flatMap((n: any) => n.queues ?? []).reduce((a: number, q: any) => a + (q.perSecond ?? 0), 0))
    expect(sum).toBeGreaterThan(0)

    const chip = page.locator('#chip-messages')
    await expect(chip).toContainText('msg/s')
    const shown = parseFloat((await chip.locator('b').innerText()).replace('k', ''))
    expect(Math.abs(shown - sum)).toBeLessThan(Math.max(0.06, sum * 0.06))
    await expect(chip).toHaveAttribute('title', /counted twice/)
  })

  test('the Service Bus drawer has the same total, as a row', async ({ page }) => {
    await open(page)
    const broker = await page.evaluate(() => (window as any).city.seen.last.groups.flatMap((g: any) => g.nodes).find((n: any) => n.kind === 'Broker')?.id)
    await page.evaluate((id) => (window as any).city.openSystem(id), broker)

    await expect(page.locator('#inspector .row', { hasText: 'Messages' })).toContainText('msg/s through the queues')
  })
})
