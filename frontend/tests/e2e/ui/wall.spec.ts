import type { Page } from '@playwright/test'
import { test, expect } from '../support/test'

// Wall mode (?wall=1) on mini-town: the town on a big screen with a tour, a status strip and change cues. The tour holds 2 seconds at each stop here
// (&hold=2) and time moves only when the test steps it, so every stop is reached on purpose.
// mini-town: islands aa Alpha, bb Beta, cc Gamma; hub; vendors ext.bureau (called from aa) and ext.mailer.

const WALL = '&wall=1&hold=2'

interface WallStatus {
  mode: 'alert' | 'calm'
  stop: { key: string; kind: string; caption: string; cut: boolean } | null
  note: string | null
  cuts: number
  strip: { headline: string; caption: string; note: string | null; tone: string; connection: string; pulsing: boolean }
}

const wall = (page: Page) => page.evaluate(() => (window as any).city.wall() as WallStatus)

/** How far (in metres on the ground) the camera is looking from a building or island. */
const lookingAway = (page: Page, kind: 'building' | 'island', id: string) =>
  page.evaluate(([k, i]) => {
    const c = (window as any).city
    const f = k === 'building' ? c.town.focusOf(i) : c.town.islandFocusOf(i)
    const t = c.stage.controls.target
    return Math.hypot(t.x - f.target.x, t.z - f.target.z)
  }, [kind, id] as const)

/** The stops the tour makes as the clock runs, one hold at a time. */
async function tour(page: Page, stops: number, hold = 2): Promise<string[]> {
  const seen: string[] = []
  for (let i = 0; i < stops; i++) {
    await page.evaluate((s) => (window as any).city.step(s), hold + 0.05)
    seen.push((await wall(page)).stop!.key)
  }
  return seen
}

test.describe('wall mode is off unless asked for', () => {
  test('a normal page has no strip and no wall tour', async ({ town, page }) => {
    await town.open()
    await expect(page.locator('#wall-strip')).toHaveCount(0)
    await expect(page.locator('#topbar')).toBeVisible()
    expect(await page.evaluate(() => (window as any).city.wall())).toBeNull()
    expect(await page.evaluate(() => document.body.classList.contains('wall'))).toBe(false)
  })

  test('?wall=0 is off too', async ({ town, page }) => {
    await town.open('&wall=0')
    await expect(page.locator('#wall-strip')).toHaveCount(0)
  })
})

test.describe('the wall screen', () => {
  test('opens on Dusk, with the bar and panels gone and a green strip that says all is well', async ({ town, page }) => {
    await town.open(WALL)
    await expect(page.locator('#wall-strip')).toBeVisible()
    for (const hidden of ['#topbar', '#break-panel', '#story-bar']) await expect(page.locator(hidden)).toBeHidden()
    await expect(page.locator('#wall-headline')).toHaveText('ALL SYSTEMS HEALTHY')
    await expect(page.locator('#wall-strip')).toHaveAttribute('data-tone', 'ok')
    await expect(page.locator('#wall-town')).toHaveText('Mini Town')
    await expect(page.locator('#wall-caption')).toContainText('All systems healthy')
    expect(await page.evaluate(() => (window as any).city.lighting())).toBe('dusk')
    expect(await page.evaluate(() => document.documentElement.dataset.lighting)).toBe('dusk')
  })

  test('opens on Dusk whatever this browser last chose, and on Day when the address says so', async ({ town, page }) => {
    await page.addInitScript(() => localStorage.setItem('oc.lighting', 'day'))
    await town.open(WALL)
    expect(await page.evaluate(() => (window as any).city.lighting())).toBe('dusk')
    await page.goto(`/?test=1&quality=low${WALL}&light=day`)
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    expect(await page.evaluate(() => (window as any).city.lighting())).toBe('day')
  })

  test('shows the numbers of the town in the strip', async ({ town, page }) => {
    await town.open(WALL)
    const strip = page.locator('#wall-strip')
    for (const label of ['req/s', 'errors', 'p99', 'DLQ']) await expect(strip).toContainText(label)
    const total = await page.evaluate(() => (window as any).city.seen.last.totals.requestsPerSecond as number)
    expect(total).toBeGreaterThan(0)
  })

  test('is big: the headline is set in large type', async ({ town, page }) => {
    await town.open(WALL)
    const size = await page.locator('#wall-headline').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    expect(size).toBeGreaterThanOrEqual(28)
  })
})

test.describe('the showcase loop, while all is well', () => {
  test('starts on the whole town, then the hub, then each island in the order they stand, then the busiest and the hub again', async ({ town, page }) => {
    await town.open(WALL)
    expect((await wall(page)).mode).toBe('calm')
    expect((await wall(page)).stop?.key).toBe('town')

    const keys = await tour(page, 9)

    expect(keys.slice(0, 4)).toEqual(['hub', 'island:aa', 'island:bb', 'island:cc'])
    expect(keys.some((k) => k.startsWith('busy:'))).toBe(true)
    expect(keys).toContain('hub-end')
    expect(keys.at(-1)).toBe('town') // and round again
  })

  test('moves the camera to each stop', async ({ town, page }) => {
    await town.open(WALL)
    await tour(page, 2) // hub, then island aa
    await town.step(1.5) // the glide takes a second or so
    expect(await lookingAway(page, 'island', 'aa')).toBeLessThan(1)

    await tour(page, 1, 0.45)
    await town.step(1.5)
    expect(await lookingAway(page, 'island', 'bb')).toBeLessThan(1)
  })

  test('holds at a stop for the time asked for, and not a moment less', async ({ town, page }) => {
    await town.open('&wall=1&hold=3')
    await town.step(2.9)
    expect((await wall(page)).stop?.key).toBe('town')
    await town.step(0.2)
    expect((await wall(page)).stop?.key).toBe('hub')
  })

  test('holds 20 seconds at a stop when no hold is asked for', async ({ town, page }) => {
    await town.open('&wall=1')
    await town.step(19.5)
    expect((await wall(page)).stop?.key).toBe('town')
    await town.step(1)
    expect((await wall(page)).stop?.key).toBe('hub')
  })

  test('says what each stop is about in the strip', async ({ town, page }) => {
    await town.open(WALL)
    await tour(page, 2)
    await expect(page.locator('#wall-caption')).toContainText('Alpha')
    await expect(page.locator('#wall-caption')).toContainText('all healthy')
  })
})

test.describe('trouble', () => {
  test('cuts to a system that goes down at once, pulses the screen red and says so in big red words', async ({ town, page }) => {
    await town.open(WALL)
    await town.effect('aa.orders-api', 'Down')
    await town.until('aa.orders-api', (n) => n.state === 'Down')
    await page.waitForFunction(() => (window as any).city.wall().stop?.kind === 'down')

    const s = await wall(page)
    expect(s.mode).toBe('alert')
    expect(s.stop).toMatchObject({ key: 'down:aa.orders-api', cut: true, caption: 'Orders API (Alpha) is down' })
    expect(s.cuts).toBe(1)
    expect(s.strip).toMatchObject({ headline: '1 DOWN', tone: 'bad', pulsing: true })
    await expect(page.locator('#wall-headline')).toHaveText('1 DOWN')
    await expect(page.locator('#wall-strip')).toHaveAttribute('data-tone', 'bad')
    // a cut has no glide: the camera is there before any time has passed
    expect(await lookingAway(page, 'building', 'aa.orders-api')).toBeLessThan(0.5)
    await expect(page.locator('#wall-pulse')).toHaveClass(/on/)
  })

  test('stops pulsing after a few seconds, and holds on the trouble for a full stop', async ({ town, page }) => {
    await town.open(WALL)
    await town.effect('aa.orders-api', 'Down')
    await page.waitForFunction(() => (window as any).city.wall().stop?.kind === 'down')

    await town.step(1.5)
    expect((await wall(page)).strip.pulsing).toBe(true)
    expect((await wall(page)).stop?.key).toBe('down:aa.orders-api')
    await town.step(3)
    expect((await wall(page)).strip.pulsing).toBe(false)
    await expect(page.locator('#wall-pulse')).not.toHaveClass(/on/)
  })

  test('tells a degraded system by the amber headline, and does not cut as sharply as for one that is down', async ({ town, page }) => {
    await town.open(WALL)
    await town.effect('bb.ledger-worker', 'Backlog')
    await town.until('bb.ledger-worker', (n) => n.state === 'Degraded' || n.state === 'Down', 60_000)
    await page.waitForFunction(() => (window as any).city.wall().mode === 'alert')

    const s = await wall(page)
    expect(s.stop!.key).toMatch(/^(degraded|down):bb\.ledger-worker$/)
    expect(['warn', 'bad']).toContain(s.strip.tone)
  })

  test('tours the trouble: incidents first, then systems that are down, then degraded, holding at each', async ({ town, page }) => {
    await town.open(WALL)
    await town.effect('aa.orders-api', 'Down')
    await town.effect('bb.ledger-api', 'UnhealthyInstances', 0.5)
    await town.effect('cc', 'Incident', 0.9)
    await town.until('aa.orders-api', (n) => n.state === 'Down')
    await page.waitForFunction(() => {
      const c = (window as any).city
      return c.seen.last.totals.incidents === 1 && c.seen.last.totals.down === 1 && c.seen.last.totals.degraded >= 1
    }, null, { timeout: 40_000 })
    await page.waitForFunction(() => (window as any).city.wall().strip.headline.includes('INCIDENT'))

    const kinds: string[] = []
    for (let i = 0; i < 6; i++) {
      await town.step(2.05)
      kinds.push((await wall(page)).stop!.kind)
    }
    const order = ['incident', 'down', 'degraded']
    const rank = kinds.map((k) => order.indexOf(k))
    expect(rank.every((r) => r >= 0), kinds.join()).toBe(true)
    // each stop is the one after the last in the order, round and round
    for (let i = 1; i < rank.length; i++) expect(rank[i], kinds.join()).toBe((rank[i - 1] + 1) % order.length)
    await expect(page.locator('#wall-headline')).toContainText('INCIDENT')
    await expect(page.locator('#wall-headline')).toContainText('DOWN')
  })

  test('the incident makes the camera look at the whole island, with the severity and the title', async ({ town, page }) => {
    await town.open(WALL)
    await town.effect('cc', 'Incident', 0.9)
    await page.waitForFunction(() => (window as any).city.wall().stop?.kind === 'incident')

    const s = await wall(page)
    expect(s.stop!.caption).toMatch(/^Sev \d incident on Gamma: /)
    expect(await lookingAway(page, 'island', 'cc')).toBeLessThan(0.5)
  })

  test('does not leave the first sign of trouble: the strip stays red while it lasts', async ({ town, page }) => {
    await town.open(WALL)
    await town.effect('aa.orders-api', 'Down')
    await page.waitForFunction(() => (window as any).city.wall().stop?.kind === 'down')
    await tour(page, 3)
    await expect(page.locator('#wall-strip')).toHaveAttribute('data-tone', 'bad')
    await expect(page.locator('#wall-headline')).toHaveText('1 DOWN')
  })
})

test.describe('trouble that ends', () => {
  test('puts up a green resolved note, goes back to the showcase loop and says all is well again', async ({ town, page }) => {
    await town.open(WALL)
    await town.effect('aa.orders-api', 'Down')
    await page.waitForFunction(() => (window as any).city.wall().stop?.kind === 'down')

    await town.removeEffects()
    await page.waitForFunction(() => (window as any).city.wall().note !== null, null, { timeout: 40_000 })

    const s = await wall(page)
    expect(s.note).toBe('Resolved: Orders API is healthy again')
    expect(s.mode).toBe('calm')
    await expect(page.locator('#wall-note')).toHaveText('Resolved: Orders API is healthy again')
    await expect(page.locator('#wall-headline')).toHaveText('ALL SYSTEMS HEALTHY')
    await expect(page.locator('#wall-strip')).toHaveAttribute('data-tone', 'ok')
    // the camera moves on without a cut
    expect(s.stop!.cut).toBe(false)
    expect(s.stop!.kind).toBe('calm')
  })

  test('takes the note down by itself after a while', async ({ town, page }) => {
    await town.open(WALL)
    await town.effect('aa.orders-api', 'Down')
    await page.waitForFunction(() => (window as any).city.wall().stop?.kind === 'down')
    await town.removeEffects()
    await page.waitForFunction(() => (window as any).city.wall().note !== null, null, { timeout: 40_000 })

    await town.step(11)

    expect((await wall(page)).note).toBeNull()
    await expect(page.locator('#wall-note')).toHaveCount(0)
  })

  test('a note for an incident that is over names the island', async ({ town, page }) => {
    await town.open(WALL)
    await town.effect('cc', 'Incident', 0.9)
    await page.waitForFunction(() => (window as any).city.wall().stop?.kind === 'incident')
    await town.removeEffects()
    await page.waitForFunction(() => (window as any).city.wall().note !== null, null, { timeout: 40_000 })

    expect((await wall(page)).note).toMatch(/^Resolved: incident on Gamma: /)
  })
})

test.describe('a view for one team (?islands=)', () => {
  test('tours only the islands it shows', async ({ town, page }) => {
    await town.open(`${WALL}&islands=aa`)
    await page.waitForFunction(() => (window as any).city.seen.last.view.islands.join() === 'aa')

    const keys = await tour(page, 12)

    expect(keys).toContain('island:aa')
    expect(keys.filter((k) => k.startsWith('island:')).every((k) => k === 'island:aa')).toBe(true)
    expect(keys.some((k) => k === 'island:bb' || k === 'island:cc')).toBe(false)
    for (const k of keys.filter((k) => k.startsWith('busy:'))) expect(k.startsWith('busy:aa.')).toBe(true)
  })

  test('counts and cuts for its own islands only', async ({ town, page }) => {
    await town.open(`${WALL}&islands=aa`)
    await page.waitForFunction(() => (window as any).city.seen.last.view.islands.join() === 'aa')

    await town.effect('bb.ledger-api', 'Down') // an island this view does not show
    await town.nextSnapshot()
    await town.nextSnapshot()
    await expect(page.locator('#wall-headline')).toHaveText('ALL SYSTEMS HEALTHY')
    expect((await wall(page)).mode).toBe('calm')

    await town.effect('aa.orders-api', 'Down')
    await page.waitForFunction(() => (window as any).city.wall().stop?.kind === 'down')
    await expect(page.locator('#wall-headline')).toHaveText('1 DOWN')
  })

  test('is a plain address, so a team can bookmark it', async ({ town, page }) => {
    await town.open(`${WALL}&islands=aa,cc`)
    await page.waitForFunction(() => (window as any).city.seen.last.view.islands.join() === 'aa,cc')
    expect(page.url()).toContain('wall=1')
    expect(page.url()).toContain('islands=aa,cc')
    const keys = await tour(page, 6)
    expect(keys.filter((k) => k.startsWith('island:'))).toContain('island:cc')
    expect(keys).not.toContain('island:bb')
  })
})

test.describe('when the connection is lost', () => {
  test('shows a banner, keeps trying, and is live again by itself when the backend is back', async ({ town, page, errors }) => {
    await town.open(`${WALL}&retry=1`)
    expect(await page.evaluate(() => (window as any).city.connectionOpened())).toBe(1)
    await expect(page.locator('#wall-connection')).toBeHidden()

    // the backend goes away: the socket closes and nothing answers
    await page.route(/\/(hubs|api)\//, (r) => r.abort())
    await page.evaluate(() => (window as any).city.dropConnection())
    await expect(page.locator('#wall-connection')).toBeVisible()
    await expect(page.locator('#wall-connection')).toContainText('offline')
    // the last town stays on the screen, and the strip does not lie: it still shows what it last knew
    await expect(page.locator('#wall-strip')).toBeVisible()
    await page.waitForTimeout(2500) // a few tries fail
    expect(await page.evaluate(() => (window as any).city.connectionOpened())).toBe(1)

    // it is back
    const before = await page.evaluate(() => (window as any).city.seen.snapshots as number)
    await page.unroute(/\/(hubs|api)\//)
    await page.waitForFunction(() => (window as any).city.connectionOpened() >= 2, null, { timeout: 30_000 })
    await expect(page.locator('#wall-connection')).toBeHidden()
    await page.waitForFunction((n) => (window as any).city.seen.snapshots > n, before, { timeout: 15_000 })

    // the failed tries are logged by the SignalR client; nothing else may be
    expect(errors.every((e) => /negotiat|WebSocket|fetch|connection|stopped|Failed/i.test(e)), errors.join('\n')).toBe(true)
    errors.length = 0
  })

  test('a normal page does not keep trying: it falls back to polling', async ({ town, page, errors }) => {
    await town.open('&retry=1')
    await page.route(/\/hubs\//, (r) => r.abort())
    await page.evaluate(() => (window as any).city.dropConnection())
    await page.waitForTimeout(3500)
    expect(await page.evaluate(() => (window as any).city.connectionOpened())).toBe(1)
    // polling still brings the town in
    const before = await page.evaluate(() => (window as any).city.seen.snapshots as number)
    await page.waitForFunction((n) => (window as any).city.seen.snapshots > n, before, { timeout: 15_000 })
    errors.length = 0
  })
})
