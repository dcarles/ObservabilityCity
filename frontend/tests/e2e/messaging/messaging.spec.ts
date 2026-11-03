import { test, expect, type Page } from '@playwright/test'

// A live town whose broker's backlog and dead letters come from the platform metrics, split by queue name. The same checks run on two towns that write
// everything differently (messaging-town-a: queue names with codes, averages, a peak of dead letters, an address over pillar and service codes;
// messaging-town-b: queue names with ids, a total, an address over the environment and the system). The town shows the same thing in both, which is the
// proof that the rules, not the program, know the naming.

const B = process.env.E2E_SUITE === 'messagingb'
const tool = B ? 'Parked messages' : 'Support tool'
const inbox = B ? 'bus.aa.orders.in' : 'sbq-al-ord-inbox'
const queues = B ? ['bus.aa.orders.feed', 'bus.aa.orders.in', 'bus.bb.aa.orders.out'] : ['sbq-al-led-ord-outbox', 'sbq-al-ord-changefeed', 'sbq-al-ord-inbox']
const inboxLink = B ? 'https://parked.example.test/prod/aa.orders-worker/bus.aa.orders.in' : 'https://support.example.test/queues/sbq-al-ord-inbox?team=al&service=ord'

type Reading = { id: string; state: string; queueDepth: number | null; deadLetters: number | null; absent: string[] }

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 900 }) // wide enough for the whole top bar, which drops its DLQ number on a narrow screen
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

  test('show in the consumer\'s drawer, one row for each queue, with a link to that queue\'s dead letters in the support tool', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.openSystem('aa.orders-worker'))

    await expect(page.locator('#inspector .row', { hasText: 'Dead letters' }).first()).toContainText('2')
    const rows = page.locator('#inspector .row.queue')
    await expect(rows).toHaveCount(3)
    expect((await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-queue')))).sort()).toEqual(queues)

    const row = page.locator(`#inspector .row.queue[data-queue="${inbox}"]`)
    await expect(row).toContainText('2 dead') // the dead letters sit in the inbox
    const anchor = row.locator('a.out')
    await expect(anchor).toContainText(tool)
    await expect(anchor).toHaveAttribute('href', inboxLink)
    await expect(anchor).toHaveAttribute('target', '_blank')
  })

  test('the top bar DLQ number lists the queues with dead letters, and a click on a row opens the service that reads it', async ({ page }) => {
    await open(page)
    await page.locator('#topbar .chip.dlq').click()

    const list = page.locator('#state-list')
    await expect(list).toBeVisible()
    await expect(list.locator('.head')).toContainText('1 queue with dead letters')
    const row = list.locator('.hit')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('Orders worker')
    await expect(row).toContainText(inbox) // the queue, and how many
    await expect(row).toContainText('2 dead')
    await expect(list.locator('a')).toHaveCount(0) // no portal link in the list: the drawer has it

    await row.click()
    await expect(list).toBeHidden()
    await expect(page.locator('#inspector')).toContainText('Orders worker')
    await expect(page.locator(`#inspector .row.queue[data-queue="${inbox}"]`)).toContainText('2 dead')
    expect(await page.evaluate(() => (window as any).city.inspector().id)).toBe('aa.orders-worker')
  })

  test('the DLQ number is clicked closed again, and says so when nothing is dead', async ({ page }) => {
    await open(page)
    await page.locator('#topbar .chip.dlq').click()
    await expect(page.locator('#state-list')).toBeVisible()
    await page.locator('#topbar .chip.dlq').click()
    await expect(page.locator('#state-list')).toBeHidden()
  })

  test('a click on an island\'s pier opens that island\'s queues with dead letters', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.framePier('aa'))
    await page.waitForTimeout(600)
    const at = await page.evaluate(() => (window as any).city.screenOfPier('aa'))
    expect(at).not.toBeNull()
    await page.mouse.click(at.x, at.y)

    const list = page.locator('#state-list')
    await expect(list).toBeVisible()
    await expect(list.locator('.hit')).toHaveCount(1)
    await expect(list.locator('.hit')).toContainText('Orders worker')
    await list.locator('.hit').click()
    expect(await page.evaluate(() => (window as any).city.inspector().id)).toBe('aa.orders-worker')

    // another island's pier lists only its own: bb has no dead letters
    await page.evaluate(() => (window as any).city.framePier('bb'))
    await page.waitForTimeout(600)
    const bb = await page.evaluate(() => (window as any).city.screenOfPier('bb'))
    await page.mouse.click(bb.x, bb.y)
    await expect(page.locator('#state-list')).toContainText('No queue has dead letters right now')
  })

  test('the roof beacon of a service with dead letters is amber, not green, and one without stays as it was', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.step(2)) // time only moves when a test moves it
    const beacon = (id: string) => page.evaluate((want) => (window as any).city.inspect(want).beacon, id)
    expect(await beacon('aa.orders-worker')).toBe('amber')
    expect(await beacon('bb.ledger-worker')).not.toBe('amber')
  })

  test('are not listed for a system that reads no queue', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as any).city.openSystem('aa.orders-api'))

    await expect(page.locator('#inspector')).toContainText('Orders API')
    await expect(page.locator('#inspector .row.queue')).toHaveCount(0)
  })

  test('sail as boats from the island that publishes to the island that reads', async ({ page }) => {
    await open(page)
    const sea = await page.evaluate(() => (window as any).city.town.inspectSea() as { harbours: string[]; unreachable: string[]; routes: { from: string | null; to: string }[] })

    expect(sea.unreachable).toEqual([])
    expect(sea.routes.some((r) => r.from === 'bb' && r.to === 'aa')).toBe(true) // aa's worker reads bb's outbox
  })

  test('sail from the number of messages that arrive, even when nothing reads the broker itself', async ({ page }) => {
    await open(page)
    const state = await page.evaluate(() => (window as any).city.seen.last.groups.flatMap((g: any) => g.nodes).find((n: any) => n.kind === 'Broker')?.state)
    expect(['Stale', 'Unknown']).toContain(state) // the broker building has no source of its own
    const sea = await page.evaluate(() => (window as any).city.town.inspectSea() as { routes: { to: string; scheduler: boolean; rate: number }[] })
    expect(sea.routes.filter((r) => r.to === 'aa' && !r.scheduler).some((r) => r.rate > 0)).toBe(true) // 3 messages a second arrive in aa's inbox
  })
})
