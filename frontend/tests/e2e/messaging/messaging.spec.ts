import { test, expect, type Page } from '@playwright/test'

// A live town whose broker's backlog and dead letters come from the platform metrics, split by queue name. The same checks run on two towns that write
// everything differently (messaging-town-a: queue names with codes, averages, a peak of dead letters, an address over pillar and service codes;
// messaging-town-b: queue names with ids, a total, an address over the environment and the system). The town shows the same thing in both, which is the
// proof that the rules, not the program, know the naming.

const B = process.env.E2E_SUITE === 'messagingb'
const link = B
  ? { name: 'Parked messages', url: 'https://parked.example.test/prod/aa.orders-worker' }
  : { name: 'Support tool', url: 'https://support.example.test/queues?team=al&service=ord' }

type Reading = { id: string; state: string; queueDepth: number | null; deadLetters: number | null; absent: string[] }

async function open(page: Page): Promise<void> {
  await page.goto('/?test=1&quality=low')
  await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
  // the inventory is read on the first poll and the broker's numbers after it, so wait until the consumer has its backlog
  await page.waitForFunction(
    () => (window as any).city.seen.last.groups.flatMap((g: any) => g.nodes).some((n: any) => n.id === 'aa.orders-worker' && n.queueDepth != null),
    undefined, { timeout: 30_000 },
  )
}

const reading = (page: Page, id: string): Promise<Reading> =>
  page.evaluate((want) => {
    const n = (window as any).city.seen.last.groups.flatMap((g: any) => g.nodes).find((x: any) => x.id === want)
    return { id: n.id, state: n.state, queueDepth: n.queueDepth, deadLetters: n.deadLetters, absent: n.absent }
  }, id)

test.describe(`the broker's backlog and dead letters (${B ? 'ids, a total' : 'codes, a peak'})`, () => {
  test('reach the consumers, and only them', async ({ page }) => {
    await open(page)

    const orders = await reading(page, 'aa.orders-worker')
    expect(orders.queueDepth).toBe(175) // its inbox, its changefeed and the outbox addressed to it
    expect(orders.deadLetters).toBe(2)
    expect(orders.state).toBe('Degraded') // more than the count threshold waits
    expect(orders.absent).not.toContain('backlog')

    const ledger = await reading(page, 'bb.ledger-worker')
    expect([ledger.queueDepth, ledger.deadLetters, ledger.state]).toEqual([3, 0, 'Healthy'])

    // an API consumes nothing: no backlog, rather than a zero
    expect((await reading(page, 'aa.orders-api')).queueDepth).toBeNull()
  })

  test('show in the consumer\'s drawer, with a link to its dead letters in the support tool', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.openSystem('aa.orders-worker'))

    await expect(page.locator('#inspector .row', { hasText: 'Dead letters' }).first()).toContainText('2')
    const row = page.locator('#inspector .row.dead-letters')
    await expect(row).toHaveCount(1)
    const anchor = row.locator('a.out')
    await expect(anchor).toContainText(link.name)
    await expect(anchor).toHaveAttribute('href', link.url)
    await expect(anchor).toHaveAttribute('target', '_blank')
  })

  test('are not linked for a system that consumes nothing', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.openSystem('aa.orders-api'))

    await expect(page.locator('#inspector')).toContainText('Orders API')
    await expect(page.locator('#inspector .row.dead-letters')).toHaveCount(0)
  })

  test('sail as boats from the island that publishes to the island that reads', async ({ page }) => {
    await open(page)
    const sea = await page.evaluate(() => (window as any).city.town.inspectSea() as { harbours: string[]; unreachable: string[]; routes: { from: string | null; to: string }[] })

    expect(sea.unreachable).toEqual([])
    expect(sea.routes.some((r) => r.from === 'bb' && r.to === 'aa')).toBe(true) // aa's worker reads bb's outbox
  })
})
