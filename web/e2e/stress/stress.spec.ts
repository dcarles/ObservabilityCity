import { test, expect } from '../support/test'
import { frameCost, note } from '../support/perf'

// The biggest town the design allows: 24 islands, from 2 systems to 25 on one island (tests/fixtures/registries/stress-24).
// Runs in the slow set, on merge to main and nightly. No GPU in CI, so the frame budget is for software rendering (SwiftShader):
// it catches a change that makes the town many times heavier, not a few percent. Measured at the time of writing: about 10,300 draw calls,
// 1.5 s a frame and 2 s to build, so the budgets leave 20% to 4x of headroom. Set E2E_MAX_FRAME_MS lower on a machine with a GPU.

const SIZES = [2, 25, 3, 18, 5, 12, 4, 22, 6, 9, 2, 15, 7, 20, 3, 11, 8, 25, 4, 14, 6, 10, 2, 16]
const MAX_DRAW_CALLS = Number(process.env.E2E_MAX_DRAW_CALLS ?? 12500)
const MAX_FRAME_MS = Number(process.env.E2E_MAX_FRAME_MS ?? 6000)
const MAX_BUILD_MS = Number(process.env.E2E_MAX_BUILD_MS ?? 10_000)

test('all 24 islands render, within the frame-rate and draw-call budgets', async ({ town, page }, info) => {
  await town.open()

  const built = await page.evaluate(() => {
    const c = (window as any).city
    return {
      islands: c.town.islands.map((i: any) => ({ id: i.group.id, buildings: i.buildings.size, configError: i.group.configError })),
      hub: [...c.town.buildings.keys()].filter((id: string) => id.startsWith('hub.')).length,
      buildMs: c.seen.buildMs as number,
      rejected: c.seen.rejected as number,
      buildErrors: c.seen.buildErrors as number,
    }
  })
  expect(built.islands).toHaveLength(24)
  expect(built.islands.map((i: { buildings: number }) => i.buildings)).toEqual(SIZES)
  expect(built.islands.every((i: { configError: string | null }) => i.configError === null)).toBe(true)
  expect(built.hub).toBe(4)
  expect(built.rejected + built.buildErrors).toBe(0)
  note(info, 'build ms', built.buildMs.toFixed(0))
  expect(built.buildMs, 'building the whole town').toBeLessThan(MAX_BUILD_MS)

  // every one of the 249 + 4 buildings takes its numbers and is healthy
  await town.step(10)
  const all = await town.allBuildings()
  expect(all).toHaveLength(SIZES.reduce((a, b) => a + b, 0) + 4)
  expect(all.filter((b) => b.state !== 'Healthy').map((b) => b.id)).toEqual([])

  const cost = await frameCost(page)
  note(info, 'draw calls', String(cost.calls))
  note(info, 'triangles', String(cost.triangles))
  note(info, 'frame ms (software rendering)', cost.ms.toFixed(0))
  note(info, 'frames per second (software rendering)', (1000 / cost.ms).toFixed(2))
  expect(cost.calls, 'draw calls for one frame').toBeLessThan(MAX_DRAW_CALLS)
  expect(cost.ms, 'time to draw one frame').toBeLessThan(MAX_FRAME_MS)
})

test('trouble on the biggest and the smallest island stays on those islands', async ({ town }) => {
  await town.open()
  await town.effect('p02', 'Errors', 1) // 25 systems
  await town.effect('p01', 'Down') // 2 systems
  await town.until('p01.s1-api', (n) => n.state === 'Down')
  await town.until('p02.s1-api', (n) => n.errorRate > 0.1)
  await town.step(20)

  expect((await town.inspect('p01.s1-api')).closedSign).toBe(true)
  expect((await town.inspect('p02.s8-api')).beacon).toBe('red')
  for (const id of ['p03.s1-api', 'p12.s5-api', 'p24.s5-api']) expect((await town.inspect(id)).beacon, id).toBe('green')

  await town.reset()
  await town.until('p01.s1-api', (n) => n.state === 'Healthy')
  await town.until('p02.s1-api', (n) => n.errorRate < 0.01)
  await town.step(20)
  const trouble = (await town.allBuildings()).filter((b) => b.beacon !== 'green' || b.closedSign)
  expect(trouble.map((b) => b.id)).toEqual([])
})
