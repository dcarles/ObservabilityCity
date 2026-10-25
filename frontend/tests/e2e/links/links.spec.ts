import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../support/test'

// The link rules on the links-town registry (6 islands, one for each case). Connectors follow real links only: a pier and boats only for an
// island with messaging, a bridge only for an island with an API or a call link over its coast, a building only for a role the island has.
// Everything is read from the scene's state (window.city), not pixels.
//
//   ful  API + consumer + topic      bridge, pier
//   wrk  worker only                 pier, no bridge
//   nom  API + cache, no messaging   bridge, no pier, no worker, no database
//   hbk  cron calling the hub DB     bridge, no pier
//   leg  API + legacy egress reader  bridge, pier, amber pennant
//   sta  nothing                     no bridge, no pier, a registry warning

test.describe('connectors follow real links', () => {
  test('each island gets exactly the bridge and the pier its links call for', async ({ town }) => {
    await town.open()
    await town.step(20)

    const expected: Record<string, { bridge: boolean; pier: boolean }> = {
      ful: { bridge: true, pier: true },
      wrk: { bridge: false, pier: true },
      nom: { bridge: true, pier: false },
      hbk: { bridge: true, pier: false },
      leg: { bridge: true, pier: true },
      sta: { bridge: false, pier: false },
    }
    for (const [id, want] of Object.entries(expected)) {
      const i = await town.island(id)
      expect.soft({ bridge: i.bridge, pier: i.pier, lane: i.lane }, id).toEqual({ ...want, lane: want.pier }) // boats sail to a pier and nowhere else
    }
  })

  test('no car crosses a bridge that is not there, and cars do cross the ones that are', async ({ town }) => {
    await town.open()

    expect((await town.island('wrk')).crossings).toBe(0)
    expect((await town.island('sta')).crossings).toBe(0)
    for (const id of ['ful', 'nom', 'leg']) expect((await town.island(id)).crossings, id).toBeGreaterThan(0)
  })

  test('buildings exist only for roles the island has', async ({ town }) => {
    await town.open()

    expect((await town.island('nom')).kinds.sort()).toEqual(['Api', 'Cache']) // no factory, no storage
    expect((await town.island('hbk')).kinds).toEqual(['Cron'])
    expect((await town.island('wrk')).kinds.sort()).toEqual(['Database', 'Worker']) // no office tower
    expect((await town.island('ful')).kinds.sort()).toEqual(['Api', 'Database', 'Worker'])
    expect((await town.island('sta')).kinds).toEqual(['Cron'])
  })

  test('the registry says which island stands alone, in the notices panel', async ({ town, page }) => {
    await town.open()

    await expect(page.locator('#notices-toggle')).toContainText('1 config problem')
    await page.click('#notices-toggle')
    await expect(page.locator('#notices li')).toHaveCount(1)
    await expect(page.locator('#notices li').first()).toContainText("Island 'sta' stands alone")
  })

  test('the Service Bus port counts the topics, subscriptions and piers, and boats sail only to piers', async ({ town }) => {
    await town.open()

    const hub = await town.hub()
    expect(hub).toMatchObject({ topics: 3, subscriptions: 3, piers: 3, legacy: 1, boats: 3 })
    expect(await town.mostBoats(120)).toBeGreaterThan(0)
  })

  test('the old egress route is flagged with a pennant on the pier that still uses it', async ({ town }) => {
    await town.open()
    await town.step(5)

    expect((await town.island('leg')).pennant).toBe(true)
    for (const id of ['ful', 'wrk']) expect((await town.island(id)).pennant, id).toBe(false)
  })
})

test.describe('backlog and dead letters on a pier', () => {
  test('a backlog piles crates on that pier only, and the pile goes when the consumer catches up', async ({ town }) => {
    await town.open()
    await town.effect('wrk.batch-worker', 'Backlog')
    await town.until('wrk.batch-worker', (n) => (n.oldestMessageSeconds ?? 0) >= 60)
    await town.step(20)

    expect((await town.node('wrk.batch-worker')).state).toBe('Degraded')
    expect((await town.island('wrk')).crates).toBeGreaterThan(0)
    for (const id of ['ful', 'leg']) expect((await town.island(id)).crates, id).toBe(0)
    expect((await town.island('wrk')).alarm).toBe(false) // late is not dead

    await town.removeEffects()
    await town.until('wrk.batch-worker', (n) => n.state === 'Healthy' && (n.queueDepth ?? 0) < 8, 90_000)
    await town.step(20)
    expect((await town.island('wrk')).crates).toBe(0)
  })

  test('dead letters fill the pen of the right pier, light the hub lighthouse with the town total, and stay until cleared', async ({ town, page }) => {
    await town.open()
    expect((await town.hub()).lighthouse).toEqual({ total: 0, alarm: false })

    await town.effect('wrk.batch-worker', 'Poison')
    await town.effect('leg.feed-worker', 'Poison')
    await town.until('wrk.batch-worker', (n) => (n.deadLetters ?? 0) >= 20)
    await town.until('leg.feed-worker', (n) => (n.deadLetters ?? 0) >= 20)
    await town.step(5)

    for (const id of ['wrk', 'leg']) {
      const i = await town.island(id)
      expect.soft(i.alarm, `${id} light`).toBe(true)
      expect.soft(i.brokenCrates, `${id} pen`).toBeGreaterThan(0)
    }
    expect((await town.island('ful')).alarm).toBe(false)
    // the lighthouse and the top bar show the same town-wide total the snapshot carries
    const total = await page.evaluate(() => (window as any).city.seen.last.totals.deadLetters as number)
    expect(total).toBeGreaterThanOrEqual(40)
    expect((await town.hub()).lighthouse).toEqual({ total: Math.round(total), alarm: true })
    await expect(page.locator('#topbar .chip.dlq')).toContainText('DLQ')
    await expect(page.locator('#topbar .chip.dlq')).toHaveClass(/bad/)

    // the poison stops, but parked messages do not go away by themselves
    await town.removeEffects()
    await town.nextSnapshot()
    await town.step(5)
    expect((await town.hub()).lighthouse?.alarm).toBe(true)

    await town.reset()
    await town.until('wrk.batch-worker', (n) => (n.deadLetters ?? 0) === 0)
    await town.until('leg.feed-worker', (n) => (n.deadLetters ?? 0) === 0)
    await page.waitForFunction(() => (window as any).city.seen.last.totals.deadLetters === 0)
    await town.step(5)
    expect((await town.hub()).lighthouse).toEqual({ total: 0, alarm: false })
    await expect(page.locator('#topbar .chip.dlq')).not.toHaveClass(/bad/)
  })
})

test.describe('changing the links changes the connectors', () => {
  test('taking a pillar off messaging removes its pier and its boats, and putting it back restores them', async ({ town, page }) => {
    const file = join(registryCopy(), 'pillars', 'wrk.yaml')
    const original = readFileSync(join(fixtureDir(), 'pillars', 'wrk.yaml'), 'utf8')
    await town.open()
    expect((await town.island('wrk')).pier).toBe(true)
    try {
      // no topics and no subscriptions: with no API either, the island now stands alone
      writeFileSync(file, original.slice(0, original.indexOf('messaging:')))
      await page.waitForFunction(() => (window as any).city.town.inspectIsland('wrk')?.pier === false, null, { timeout: 30_000 })

      const wrk = await town.island('wrk')
      expect([wrk.pier, wrk.lane, wrk.bridge]).toEqual([false, false, false])
      expect((await town.hub())).toMatchObject({ piers: 2, boats: 2 })
      // three notices: sta, wrk, and ful's subscription to the topic wrk no longer publishes
      await expect(page.locator('#notices-toggle')).toContainText('3 config problems')
      await page.click('#notices-toggle')
      await expect(page.locator('#notices')).toContainText("Island 'wrk' stands alone")
      await expect(page.locator('#notices')).toContainText("'wrk-batch-outbox', which no pillar publishes")
    } finally {
      writeFileSync(file, original)
    }

    await page.waitForFunction(() => (window as any).city.town.inspectIsland('wrk')?.pier === true, null, { timeout: 30_000 })
    expect((await town.island('wrk')).lane).toBe(true)
    expect(await town.hub()).toMatchObject({ piers: 3, boats: 3 })
  })

  test('a call that leaves an island gives it a bridge, and removing the call takes it away', async ({ town, page }) => {
    const file = join(registryCopy(), 'pillars', 'wrk.yaml')
    const original = readFileSync(join(fixtureDir(), 'pillars', 'wrk.yaml'), 'utf8')
    await town.open()
    expect((await town.island('wrk')).bridge).toBe(false)
    try {
      // the worker reaches another island through the gateway: a link over its coast
      writeFileSync(file, original.replace('calls: [wrk.batch-db] }', 'calls: [wrk.batch-db], gatewayCalls: [ful.orders-api] }'))
      await page.waitForFunction(() => (window as any).city.town.inspectIsland('wrk')?.bridge === true, null, { timeout: 30_000 })
      expect((await town.island('wrk')).pier).toBe(true) // still has its pier
    } finally {
      writeFileSync(file, original)
    }
    await page.waitForFunction(() => (window as any).city.town.inspectIsland('wrk')?.bridge === false, null, { timeout: 30_000 })
  })
})

function registryCopy(): string {
  const dir = process.env.E2E_REGISTRY_COPY
  if (!dir) throw new Error('E2E_REGISTRY_COPY is not set: run the links suite through playwright.config.ts')
  return dir
}

function fixtureDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'shared-test-data', 'registries', 'links-town')
}
