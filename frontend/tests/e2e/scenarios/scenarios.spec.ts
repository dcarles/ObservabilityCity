import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../support/test'
import type { Town } from '../support/city'

// UI scenario tests on the small test town (3 islands, 9 systems and the hub). Each one breaks something through the fake
// source's API, waits for the page to receive it, lets the scene's clock run, checks what the town shows, and then lets the
// trouble go and checks that the town calms down again. They read the scene's state (window.city), not pixels, so they do
// not depend on the GPU or the camera.

/** Everything calm: green beacons, no dark floors, no signs, no queues, no alarms, no broken islands. */
async function expectCalm(town: Town): Promise<void> {
  await town.step(20)
  const buildings = await town.allBuildings()
  expect(buildings.length).toBe(13)
  for (const b of buildings) {
    expect.soft(b.state, `${b.id} state`).toBe('Healthy')
    expect.soft(b.beacon, `${b.id} beacon`).toBe('green')
    expect.soft(b.darkFloors, `${b.id} dark floors`).toBe(0)
    expect.soft(b.closedSign, `${b.id} closed sign`).toBe(false)
    expect.soft(b.barrierDown ?? false, `${b.id} barrier`).toBe(false)
    expect.soft(b.bubble?.honk ?? false, `${b.id} queue warning`).toBe(false)
  }
  for (const id of ['aa', 'bb', 'cc']) {
    const i = await town.island(id)
    expect.soft(i.alarm, `${id} dead-letter light`).toBe(false)
    expect.soft(i.brokenCrates, `${id} broken crates`).toBe(0)
    expect.soft(i.crates, `${id} crates on the quay`).toBe(0)
    expect.soft(i.configError, `${id} config error`).toBeNull()
  }
}

test.describe('a calm town', () => {
  test('shows 3 islands and the hub, all healthy', async ({ town }) => {
    await town.open()
    await expectCalm(town)
    expect(await town.page.evaluate(() => (window as any).city.town.islands.length)).toBe(3)
    expect(await town.page.evaluate(() => (window as any).city.seen.rejected)).toBe(0)
    await expect(town.page.locator('#notices')).toBeHidden()
  })
})

test.describe('trouble shows up, and goes away', () => {
  test('a system that is down gets a closed sign and goes dark, and reopens', async ({ town }) => {
    await town.open()
    await town.effect('bb.ledger-api', 'Down')
    await town.until('bb.ledger-api', (n) => n.state === 'Down')
    await town.step(20)

    const down = await town.inspect('bb.ledger-api')
    expect(down.closedSign).toBe(true)
    expect(down.beacon).toBe('red')
    expect(down.beaconSteady).toBe(true)
    expect(down.darkFloors).toBe(down.floors)
    // its neighbours are not dragged down with it
    for (const id of ['bb.ledger-db', 'aa.orders-api', 'cc.notify-api']) expect((await town.inspect(id)).closedSign, id).toBe(false)

    await town.removeEffects()
    await town.until('bb.ledger-api', (n) => n.state === 'Healthy')
    await expectCalm(town)
  })

  test('errors turn the beacon red on that system only, and it goes green again', async ({ town }) => {
    await town.open()
    await town.effect('aa.orders-api', 'Errors', 0.5)
    await town.until('aa.orders-api', (n) => n.errorRate > 0.1)
    await town.step(20)

    expect((await town.inspect('aa.orders-api')).beacon).toBe('red')
    expect((await town.inspect('aa.orders-db')).beacon).toBe('green')
    expect((await town.inspect('bb.ledger-api')).beacon).toBe('green')

    await town.removeEffects()
    await town.until('aa.orders-api', (n) => n.errorRate < 0.01)
    await expectCalm(town)
  })

  test('sick instances darken some floors but not all, and they light up again', async ({ town }) => {
    await town.open()
    await town.effect('aa.orders-worker', 'UnhealthyInstances', 0.5)
    await town.until('aa.orders-worker', (n) => n.state === 'Degraded')
    await town.step(20)

    const worker = await town.inspect('aa.orders-worker')
    expect(worker.darkFloors).toBeGreaterThan(0)
    expect(worker.darkFloors).toBeLessThan(worker.floors)
    expect(worker.plaque).toMatch(/^1\/3 healthy$/)
    expect(worker.closedSign).toBe(false)

    await town.removeEffects()
    await town.until('aa.orders-worker', (n) => n.state === 'Healthy')
    await expectCalm(town)
  })

  test('a saturated database drops its barrier and turns red, and lifts it when it recovers', async ({ town }) => {
    await town.open()
    await town.effect('bb.ledger-db', 'Saturate')
    await town.until('bb.ledger-db', (n) => (n.throttled ?? 0) > 0.05)
    await town.step(20)

    const db = await town.inspect('bb.ledger-db')
    expect(db.barrierDown).toBe(true)
    expect(db.beacon).toBe('red')
    expect(db.state).toBe('Degraded')
    expect((await town.inspect('aa.orders-db')).barrierDown).toBe(false)

    await town.removeEffects()
    await town.until('bb.ledger-db', (n) => (n.throttled ?? 0) === 0)
    await expectCalm(town)
  })

  test('slow responses put a warning over the service lane, which clears when they speed up', async ({ town }) => {
    await town.open()
    // a busy, slow API: cars arrive faster than they are served, so the service lane fills
    await town.effect('aa.orders-api', 'Traffic')
    await town.effect('aa.orders-api', 'Latency')
    await town.until('aa.orders-api', (n) => n.p99Ms > n.slaP99Ms * 1.5)

    // cars have to arrive and wait their turn before the warning goes up
    let honk = false
    for (let i = 0; i < 12 && !honk; i++) {
      await town.step(10)
      honk = (await town.inspect('aa.orders-api')).bubble?.honk ?? false
    }
    expect(honk, 'a queue warning over the slow API').toBe(true)
    for (const id of ['bb.ledger-api', 'cc.notify-api']) expect((await town.inspect(id)).bubble?.honk ?? false, id).toBe(false)

    await town.removeEffects()
    await town.until('aa.orders-api', (n) => n.p99Ms < n.slaP99Ms)
    await town.step(30) // the queue drives off
    await expectCalm(town)
  })

  test('a consumer that falls behind piles crates on the quay, and the pile goes when it catches up', async ({ town }) => {
    await town.open()
    await town.effect('cc.notify-worker', 'Backlog')
    await town.until('cc.notify-worker', (n) => (n.oldestMessageSeconds ?? 0) >= 60)
    await town.step(20)

    expect((await town.node('cc.notify-worker')).state).toBe('Degraded')
    const harbour = await town.island('cc')
    expect(harbour.crates).toBeGreaterThan(0)
    expect((await town.island('aa')).crates).toBe(0)

    await town.removeEffects()
    await town.until('cc.notify-worker', (n) => n.state === 'Healthy' && (n.queueDepth ?? 0) < 8, 90_000) // it drains by itself
    await expectCalm(town)
  })

  test('dead letters light the harbour beacon and stay until they are cleared', async ({ town }) => {
    await town.open()
    await town.effect('aa.orders-worker', 'Poison')
    await town.until('aa.orders-worker', (n) => (n.deadLetters ?? 0) >= 20)
    await town.step(5)

    let aa = await town.island('aa')
    expect(aa.alarm).toBe(true)
    expect(aa.brokenCrates).toBeGreaterThan(0)
    expect((await town.island('bb')).alarm).toBe(false)

    // the poison stops, but parked messages do not go away by themselves: the town keeps saying so
    await town.removeEffects()
    await town.nextSnapshot()
    await town.step(5)
    aa = await town.island('aa')
    expect(aa.alarm).toBe(true)

    // someone clears the queue
    await town.reset()
    await town.until('aa.orders-worker', (n) => (n.deadLetters ?? 0) === 0)
    await expectCalm(town)
  })

  test('a source that goes quiet turns grey, never green, and comes back', async ({ town }) => {
    await town.open()
    await town.effect('cc.notify-api', 'Stale')
    await town.until('cc.notify-api', (n) => n.state === 'Stale')
    await town.step(20)

    const quiet = await town.inspect('cc.notify-api')
    expect(quiet.beacon).toBe('grey')
    expect(quiet.plaque).toBe('no data')
    expect(quiet.closedSign).toBe(false) // unknown is not the same as down
    expect((await town.inspect('cc.notify-db')).beacon).toBe('green')

    await town.removeEffects()
    await town.until('cc.notify-api', (n) => n.state === 'Healthy')
    await expectCalm(town)
  })

  test('a bad day everywhere at once, and then reset', async ({ town }) => {
    await town.open()
    await town.effect('aa', 'Errors', 1)
    await town.effect('aa', 'Latency')
    await town.effect('bb', 'Down')
    await town.effect('cc.notify-db', 'Saturate')
    await town.effect('cc.notify-worker', 'Poison')
    await town.effect('cc.notify-worker', 'Backlog')
    await town.effect('hub.apim', 'Stale')
    await town.until('cc.notify-worker', (n) => (n.deadLetters ?? 0) >= 10 && n.state === 'Degraded')
    await town.until('hub.apim', (n) => n.state === 'Stale')
    await town.step(30)

    const all = Object.fromEntries((await town.allBuildings()).map((b) => [b.id, b]))
    expect(all['aa.orders-api'].beacon).toBe('red')
    expect(all['bb.ledger-db'].closedSign).toBe(true)
    expect(all['cc.notify-db'].barrierDown).toBe(true)
    expect(all['hub.apim'].beacon).toBe('grey')
    expect((await town.island('cc')).alarm).toBe(true)
    expect((await town.island('bb')).alarm).toBe(false)

    await town.reset()
    await town.until('hub.apim', (n) => n.state === 'Healthy')
    await town.until('cc.notify-worker', (n) => n.state === 'Healthy' && (n.deadLetters ?? 0) === 0)
    await town.until('bb.ledger-api', (n) => n.state === 'Healthy')
    await expectCalm(town)
  })
})

test.describe('bad configuration and bad data', () => {
  test('bad snapshots are refused and the town carries on showing the last good one', async ({ town, page }) => {
    await town.open()
    const before = await town.page.evaluate(() => (window as any).city.town.buildings.size)
    const result = await page.evaluate(() => {
      const c = (window as any).city
      const garbage: unknown[] = [null, 'oops', [], {}, { groups: 'many' }, { groups: [{ id: 'x', nodes: 'none' }] }]
      for (const g of garbage) c.feed(g)
      return { rejected: c.seen.rejected, buildings: c.town.buildings.size, status: document.querySelector('#topbar .status')?.textContent }
    })
    expect(result.rejected).toBe(6) // six kinds of garbage, none of them drawn
    expect(result.buildings).toBe(before)
    expect(result.status).toContain('Bad data')

    // the next real snapshot puts the status right again
    await town.nextSnapshot()
    await expect(page.locator('#topbar .status')).toContainText('Live')
    await town.step(5)
    await expectCalm(town)
  })

  test('a snapshot with some bad systems in it still draws the good ones', async ({ town, page }) => {
    await town.open()
    const out = await page.evaluate(() => {
      const c = (window as any).city
      const s = structuredClone(c.seen.last)
      const aa = s.groups.find((g: any) => g.id === 'aa')
      aa.nodes[0].errorRate = 'lots'
      aa.nodes[1].kind = 'Castle'
      aa.nodes.push(null)
      c.feed(s)
      return { snapshots: c.seen.snapshots, hasBroken: !!c.inspect('aa.orders-worker'), hasGood: !!c.inspect('aa.orders-db') }
    })
    expect(out.hasBroken).toBe(false) // the worker with kind Castle was dropped
    expect(out.hasGood).toBe(true) // the rest of its island is still there
  })

  test('an island whose config is broken is drawn as a config error island, and the rest keep working', async ({ town, page }) => {
    await town.open()
    const during = await page.evaluate(() => {
      const c = (window as any).city
      const s = structuredClone(c.seen.last)
      const bb = s.groups.find((g: any) => g.id === 'bb')
      bb.nodes = []
      bb.configError = 'bb.yaml was skipped: bb.ledger-worker has unknown role castle'
      s.notices = [bb.configError]
      c.feed(s)
      // read the page in the same breath: the next snapshot from the server puts the real town back
      const toggle = document.querySelector('#notices-toggle')?.textContent ?? ''
      return { island: c.inspectIsland('bb'), aa: c.inspect('aa.orders-api')?.state, islands: c.town.islands.length, panelHidden: (document.querySelector('#notices') as HTMLElement).hidden, toggle }
    })
    expect(during.island).toMatchObject({ id: 'bb', buildings: 0, configError: expect.stringContaining('unknown role castle') })
    expect(during.aa).toBe('Healthy')
    expect(during.islands).toBe(3) // still on the map
    expect(during.panelHidden).toBe(false)
    expect(during.toggle).toContain('1 config problem')
    // and the real town comes back with the next snapshot
    await town.nextSnapshot()
    expect((await town.island('bb')).buildings).toBe(3)
  })

  test('a broken pillar file is skipped while the rest renders, and comes back when it is fixed', async ({ town, page }) => {
    const file = join(registryCopy(), 'pillars', 'bb.yaml')
    const original = readFileSync(join(fixtureDir(), 'pillars', 'bb.yaml'), 'utf8')
    await town.open()
    try {
      writeFileSync(file, original.replace('role: worker', 'role: castle'))
      await page.waitForFunction(() => (window as any).city.town.islands.find((i: any) => i.group.id === 'bb')?.group.configError, null, { timeout: 30_000 })

      const bb = await town.island('bb')
      expect(bb.buildings).toBe(0)
      expect(bb.configError).toContain('castle')
      await town.until('aa.orders-api', (n) => n.state === 'Healthy')
      await town.until('cc.notify-api', (n) => n.state === 'Healthy')
      await town.step(10)
      expect((await town.inspect('aa.orders-api')).beacon).toBe('green')
      expect((await town.inspect('cc.notify-api')).beacon).toBe('green')
      await expect(page.locator('#notices-toggle')).toContainText('config problem')
      await page.click('#notices-toggle')
      await expect(page.locator('#notices li').first()).toContainText('bb.yaml was skipped')
    } finally {
      writeFileSync(file, original)
    }

    await page.waitForFunction(() => (window as any).city.town.islands.find((i: any) => i.group.id === 'bb')?.buildings.size === 3, null, { timeout: 30_000 })
    await town.until('bb.ledger-api', (n) => n.state === 'Healthy')
    await expect(page.locator('#notices')).toBeHidden()
    await expectCalm(town)
  })

  test('a registry reload that fails keeps the last good town and says so', async ({ town, page }) => {
    const file = join(registryCopy(), 'hub.yaml')
    const original = readFileSync(join(fixtureDir(), 'hub.yaml'), 'utf8')
    await town.open()
    try {
      writeFileSync(file, 'resources: [this is not valid')
      await expect(page.locator('#notices-toggle')).toContainText('1 config problem', { timeout: 30_000 })
      await page.click('#notices-toggle')
      await expect(page.locator('#notices li').first()).toContainText('still showing the last good registry')

      // nothing about the town changed
      await town.step(10)
      expect(await page.evaluate(() => (window as any).city.town.islands.length)).toBe(3)
      expect((await town.allBuildings()).length).toBe(13)
      await town.until('aa.orders-api', (n) => n.state === 'Healthy')
    } finally {
      writeFileSync(file, original)
    }

    await expect(page.locator('#notices')).toBeHidden({ timeout: 30_000 })
    await expectCalm(town)
  })
})

function registryCopy(): string {
  const dir = process.env.E2E_REGISTRY_COPY
  if (!dir) throw new Error('E2E_REGISTRY_COPY is not set: run the scenario suite through playwright.config.ts')
  return dir
}

function fixtureDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'shared-test-data', 'registries', 'mini-town')
}


test.describe('cars', () => {
  /** Every car appears at the front of a building, or comes over a bridge from one: never out of thin air. */
  test('every road starts at the front of a building, and every car appears there', async ({ town }) => {
    await town.open()
    await town.effect('*', 'Traffic')
    await town.step(5)
    const result = await town.page.evaluate(() => {
      const city = (window as any).city
      const cars = city.town.cars
      const doorOf = (b: any) => b.doorWorld()
      const far = (x: number, z: number, b: any) => Math.hypot(x - doorOf(b).x, z - doorOf(b).z)
      const bad: string[] = []
      for (const r of cars.routeList) if (far(r.path[0].x, r.path[0].z, r.source) > 8) bad.push(`route ${r.source.id} > ${r.dest.id}`)
      // and the cars themselves, the moment they first show
      const seen = new Set<number>(cars.cars.map((c: any) => c.id))
      let spawned = 0
      for (let i = 0; i < 300; i++) {
        city.step(0.1)
        for (const c of cars.cars) {
          if (seen.has(c.id)) continue
          seen.add(c.id)
          spawned++
          if (far(c.x, c.z, c.plan.route.source) > 8) bad.push(`car ${c.id} from ${c.plan.route.source.id} appeared ${far(c.x, c.z, c.plan.route.source).toFixed(1)} m away`)
        }
      }
      // cross-island roads go over both bridges: they start on another island than they end on
      const crossing = cars.routeList.filter((r: any) => r.source.id.split('.')[0] !== r.dest.id.split('.')[0]).length
      return { bad, spawned, routes: cars.routeList.length, crossing }
    })
    expect(result.bad).toEqual([])
    expect(result.spawned).toBeGreaterThan(20)
    expect(result.crossing).toBeGreaterThan(0)
  })

  test('failed requests carry a red flag, stop at the door and drive back the way they came', async ({ town }) => {
    await town.open()
    await town.effect('aa.orders-api', 'Traffic')
    await town.effect('aa.orders-api', 'Errors', 0.8)
    await town.until('aa.orders-api', (n) => n.errorRate > 0.1)
    const result = await town.page.evaluate(() => {
      const city = (window as any).city
      const cars = city.town.cars
      let flagged = 0, back = 0, lost = 0
      let before = new Map<number, string>()
      for (let i = 0; i < 900; i++) {
        city.step(0.1)
        flagged = Math.max(flagged, cars.flagged)
        const now = new Map<number, string>()
        for (const c of cars.cars) {
          if (c.failed && c.stage === 'back') back++
          now.set(c.id, c.failed ? c.stage : '')
        }
        // a failed car that was being served and is gone the next moment vanished at the door
        for (const [id, stage] of before) if (stage === 'serving' && !now.has(id)) lost++
        before = now
      }
      return { flagged, back, lost, turned: cars.turnedAway }
    })
    expect(result.flagged).toBeGreaterThan(0)
    expect(result.turned).toBeGreaterThan(0)
    expect(result.back).toBeGreaterThan(0)
    expect(result.lost).toBe(0)
  })
})

test.describe('finding things', () => {
  test('the Try it target is a dropdown you can type into, and what you pick is what the buttons hit', async ({ town, page }) => {
    await town.open()
    const target = page.locator('#target')
    await expect(target).toHaveValue('Whole town')

    // opening it lists the whole town, and typing narrows it down
    await target.click()
    await expect(page.locator('#target-results .hit').first()).toContainText('Whole town')
    expect(await page.locator('#target-results .hit').count()).toBeGreaterThan(10)
    await target.fill('ledger')
    await expect(page.locator('#target-results .hit').first()).toContainText('Ledger')
    expect(await page.locator('#target-results .hit').count()).toBeLessThan(8)
    await page.locator('#target-results .hit', { hasText: 'Ledger API' }).first().click()
    await expect(target).toHaveValue('Ledger API')

    await page.locator('[data-fx="Traffic"]').click()
    await expect(page.locator('.fxchip')).toHaveText(/Traffic · bb\.ledger-api/)
    await town.removeEffects()

    // an island is a target too, and Escape puts the picked name back
    await target.click()
    await target.fill('island: beta')
    await page.keyboard.press('Enter')
    await expect(target).toHaveValue('Island: Beta')
    await target.click()
    await target.fill('zzz')
    await page.keyboard.press('Escape')
    await expect(target).toHaveValue('Island: Beta')
  })

  test('the degraded and down counters list those systems, and a click glides to one', async ({ town, page }) => {
    await town.open()
    await town.effect('bb.ledger-api', 'Down')
    await town.effect('aa.orders-api', 'UnhealthyInstances', 0.5)
    await town.until('bb.ledger-api', (n) => n.state === 'Down')
    await expect(page.locator('[data-list="Down"] b')).toHaveText('1')

    await page.locator('[data-list="Down"]').click()
    const list = page.locator('#state-list')
    await expect(list).toBeVisible()
    await expect(list.locator('.hit')).toHaveCount(1)
    await expect(list.locator('.hit').first()).toContainText('Ledger API')
    await expect(list.locator('.hit').first()).toContainText('Beta')

    // the same counter closes it; the other one lists the degraded systems
    await page.locator('[data-list="Down"]').click()
    await expect(list).toBeHidden()
    await page.locator('[data-list="Degraded"]').click()
    await expect(list.locator('.hit')).toContainText(['Orders API'])

    await page.locator('[data-list="Down"]').click()
    await list.locator('.hit').first().click()
    await expect(list).toBeHidden()
    await town.step(8) // the glide runs on the scene's clock
    const near = await page.evaluate(() => {
      const city = (window as any).city
      const focus = city.town.focusOf('bb.ledger-api')
      return city.stage.controls.target.distanceTo(focus.target)
    })
    expect(near, 'camera target to the building (m)').toBeLessThan(3)
  })
})
