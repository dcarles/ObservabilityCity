import { test, expect } from '../support/test'

// A demo town whose hub declares several systems of one kind (multi-hub-town): two gateways, two brokers, two databases and one egress, with islands ord, pay and stk.
// Each hub system is a building of its own with its own sign; each island still has one pier and one lane to the hub, and what stands for a kind as a whole
// (the gateways the cars go through, the port's counts, the wall's caption) adds them all up.

const HUB = ['hub.public-gateway', 'hub.partner-gateway', 'hub.event-broker', 'hub.task-broker', 'hub.egress', 'hub.customer-db', 'hub.reference-db']

test.describe('a hub with several systems of a kind', () => {
  test('stands every hub system as a building of its own, each with its own name, and none on another', async ({ town, page }) => {
    await town.open()
    await town.step(2)

    const at: { id: string; x: number; z: number }[] = []
    for (const id of HUB) {
      const b = await town.inspect(id)
      expect(b, id).not.toBeNull()
      expect(b.state, id).toBe('Healthy')
      const p = await page.evaluate((i) => { const f = (window as any).city.town.focusOf(i); return { x: f.target.x, z: f.target.z } }, id)
      at.push({ id, ...p })
    }
    for (const a of at) for (const b of at) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z), `${a.id} and ${b.id}`).toBeGreaterThan(10)
    // each broker's own building carries its own name; the port's board, which stands for them all, has the neutral words
    expect((await town.inspect('hub.event-broker')).sign).toBe('EVENT BROKER')
    expect((await town.inspect('hub.task-broker')).sign).toBe('TASK BROKER')
    expect((await town.hub()).sign.board).toBe('MESSAGING')
  })

  test('opens the drawer of each hub building found by its name', async ({ town, page }) => {
    await town.open()
    const names = await page.evaluate((ids) => ids.map((id) => (window as any).city.seen.last.groups[0].nodes.find((n: any) => n.id === id).name as string), HUB)
    for (const [i, name] of names.entries()) {
      await page.locator('#search-input').fill('')
      await page.locator('#search-input').fill(name)
      await page.locator('#search-results .hit').first().click()
      await page.waitForFunction((id) => (window as any).city.inspector().id === id, HUB[i])
      await expect(page.locator('#inspector .head')).toContainText(name)
    }
  })

  test('opens the drawer of a second broker clicked in the town', async ({ town, page }) => {
    await town.open()
    await page.evaluate(() => {
      const c = (window as any).city
      c.stage.focus(c.town.focusOf('hub.task-broker').target, 22)
    })
    await town.step(4)
    const p = await page.evaluate(() => (window as any).city.screenOf('hub.task-broker'))
    expect(p).not.toBeNull()
    await page.mouse.click(p.x, p.y)
    await page.waitForFunction(() => (window as any).city.inspector().id === 'hub.task-broker')
  })

  test('gives each island one pier, whose counts add up to the town\'s on the port', async ({ town, page }) => {
    await town.open()
    await town.step(5)

    for (const id of ['ord', 'pay', 'stk']) expect((await town.island(id)).pier, id).toBe(true)
    const hub = await town.hub()
    expect(hub).toMatchObject({ topics: 3, subscriptions: 4, piers: 3 })
    expect(hub.sign.counts).toBe('Town: 3 topics · 4 subscriptions · 3 piers')
    // one lane to the hub for each island, whatever the number of brokers
    const lanes = await page.evaluate(() => (window as any).city.town.inspectLanes().map((l: any) => l.id).sort())
    expect(lanes).toEqual(['ord', 'pay', 'stk'])

    const piers = await page.evaluate(() => ['ord', 'pay', 'stk'].map((id) => (window as any).city.town.pierSummary(id).lines as string[]))
    const topics = piers.map((lines) => Number(/^(\d+) topics? · reads (\d+)$/.exec(lines.at(-1)!)![1]))
    const reads = piers.map((lines) => Number(/^(\d+) topics? · reads (\d+)$/.exec(lines.at(-1)!)![2]))
    expect(topics.reduce((a, b) => a + b, 0)).toBe(hub.topics)
    expect(reads.reduce((a, b) => a + b, 0)).toBe(hub.subscriptions)
    // what each pier says the island sends and receives is the island's own flow
    const flows = await page.evaluate(() => (window as any).city.seen.last.groups.filter((g: any) => !g.isHub).map((g: any) => g.flow))
    piers.forEach((lines, i) => {
      expect(lines).toContain(`Sends outside ${Math.round(flows[i].sentPerSecond)} msg/s`)
      expect(lines).toContain(`Receives ${Math.round(flows[i].receivedPerSecond)} msg/s`)
    })
  })

  test('scales the traffic through the gateway by both gateways together', async ({ town, page }) => {
    await town.open()
    await town.step(1)
    const airport = await page.evaluate(() => (window as any).city.inspectAirport())
    const gateways = await page.evaluate(() => (window as any).city.seen.last.groups[0].nodes.filter((n: any) => n.kind === 'Gateway').map((n: any) => n.requestsPerSecond as number))

    expect(gateways).toHaveLength(2)
    expect(airport.gateways.count).toBe(2)
    expect(airport.gateways.requestsPerSecond).toBeCloseTo(gateways[0] + gateways[1], 6)
    expect(airport.gateways.state).toBe('Healthy')
    expect(airport.bridge).toBe(true)
  })

  test('names both brokers and adds both gateways in the wall\'s caption for the hub', async ({ town, page }) => {
    await town.open('&wall=1&hold=3&overview=0')
    await town.step(3.1)
    const stop = await page.evaluate(() => (window as any).city.wall().stop)
    expect(stop.key).toBe('hub')
    expect(stop.caption).toMatch(/^Platform hub: 7 shared systems, with Event broker and Task broker carrying the messages and \d+ req\/s through the gateways$/)
  })

  test('lists every hub system on the dashboard', async ({ town, page }) => {
    await town.reset()
    await page.goto('/?view=dashboard')
    await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)
    const hub = page.locator('details[data-section="hub"]')
    await hub.locator('summary').click()
    for (const name of ['Public gateway', 'Partner gateway', 'Event broker', 'Task broker', 'Shared customer DB', 'Shared reference DB']) await expect(hub).toContainText(name)
  })
})
