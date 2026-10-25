import { test, expect } from '../support/test'
import { frameCost, note } from '../support/perf'

// The full sample town (15 islands, about 110 systems), drawn for real: screenshots of the calm town and of a bad day are
// attached to the report, so a change in how the town looks can be seen in the CI run. Runs in the slow set.

test('the sample town renders, calm and on a bad day', async ({ town, page }, info) => {
  await town.open()
  await town.step(10)

  const islands = await page.evaluate(() => (window as any).city.town.islands.length)
  expect(islands).toBe(15)
  expect((await town.allBuildings()).filter((b) => b.state !== 'Healthy')).toEqual([])

  const cost = await frameCost(page)
  note(info, 'draw calls', String(cost.calls))
  note(info, 'frame ms (software rendering)', cost.ms.toFixed(0))
  await info.attach('calm-town', { body: await page.screenshot(), contentType: 'image/png' })

  await town.effect('pay.payments-api', 'Errors', 0.6)
  await town.effect('frd', 'Latency', 0.7)
  await town.effect('obk.data-db', 'Saturate')
  await town.effect('col.cases-worker', 'Poison')
  await town.effect('dsp', 'Down')
  await town.until('dsp.disputes-api', (n) => n.state === 'Down')
  await town.until('col.cases-worker', (n) => (n.deadLetters ?? 0) > 0)
  await town.step(30)
  await page.evaluate(() => (window as any).city.measureFrame())
  await info.attach('bad-day', { body: await page.screenshot(), contentType: 'image/png' })

  expect((await town.inspect('dsp.disputes-api')).closedSign).toBe(true)
  expect((await town.inspect('pay.payments-api')).beacon).toBe('red')
  expect((await town.island('col')).alarm).toBe(true)
})
