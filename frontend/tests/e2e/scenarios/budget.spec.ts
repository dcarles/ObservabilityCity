import { test, expect } from '../support/test'
import { frameCost, note } from '../support/perf'

// A budget for the small town every pull request already opens: the number of draw calls and triangles for one frame, which do not depend on the machine.
// It catches a change that makes every building or island heavier long before the slow set (stress, sample town) runs on merge. The frame time is only reported here,
// Measured now: 615 draw calls (771 before the buildings' fixed props were merged) and 265,000 triangles, so the budgets leave about 25% of headroom: raise them on purpose, in a pull request that says why. Frame time is only reported, since a check runs on shared hardware with software rendering.
const MAX_DRAW_CALLS = Number(process.env.E2E_BUDGET_DRAW_CALLS ?? 770)
const MAX_TRIANGLES = Number(process.env.E2E_BUDGET_TRIANGLES ?? 340_000)

test('the demo town is drawn within its draw-call and triangle budget', async ({ town, page }, info) => {
  await town.open()
  await town.step(10)
  const cost = await frameCost(page)
  note(info, 'draw calls', String(cost.calls))
  note(info, 'triangles', String(cost.triangles))
  note(info, 'frame ms (software rendering)', cost.ms.toFixed(0))
  expect(cost.calls, 'draw calls for one frame').toBeLessThan(MAX_DRAW_CALLS)
  expect(cost.triangles, 'triangles for one frame').toBeLessThan(MAX_TRIANGLES)
})
