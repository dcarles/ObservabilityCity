import { test, expect } from '../support/test'
import { frameCost, note } from '../support/perf'

// Islands of 2, 10, 15 and 27 services (an API, a worker and a database each). A bigger island gets more pads along each row road
// (2, 4 or 6 a row) so that it does not turn into a long thin strip on a coast far wider than it. The pads, roads and coast are checked
// as the page built them. wide-town has no messaging, so no island has a pier.

const SERVICES: Record<string, number> = { sm: 2, md: 10, wd: 15, xl: 27 }

interface Built { id: string; buildings: number; pads: number; perRow: number; rows: number; rx: number; rz: number; offLand: string[]; x: number; z: number }

test('islands of 2, 10, 15 and 27 services put 2, 2, 4 and 6 pads on a row, and every building stands on land', async ({ town, page }, info) => {
  await town.open()
  const built: Built[] = await page.evaluate(async () => {
    const c = (window as any).city
    const { planIsland } = await import(/* @vite-ignore */ '/src/scene/' + 'plan.ts')
    return c.town.islands.map((isl: any) => {
      const g = c.seen.last.groups.find((x: any) => x.id === isl.group.id)
      const plan = planIsland(g)
      const rows = new Map<number, number>()
      for (const p of plan.pads) rows.set(p.row, (rows.get(p.row) ?? 0) + 1)
      const offLand = [...isl.buildings].filter(([, b]: any) => !isl.outline.contains(b.root.position.x, b.root.position.z, 2)).map(([id]: any) => id)
      return { id: isl.group.id, buildings: isl.buildings.size, pads: plan.pads.length, perRow: Math.max(...rows.values()), rows: plan.rows, rx: plan.rx, rz: plan.rz, offLand, x: isl.root.position.x, z: isl.root.position.z }
    })
  })
  const by = Object.fromEntries(built.map((b) => [b.id, b]))
  for (const [id, n] of Object.entries(SERVICES)) {
    expect(by[id].buildings, `${id} buildings`).toBe(n * 3)
    expect(by[id].pads, `${id} pads`).toBe(n)
    expect(by[id].offLand, `${id} buildings off the island`).toEqual([])
  }
  expect([by.sm.perRow, by.md.perRow, by.wd.perRow, by.xl.perRow]).toEqual([2, 2, 4, 6])
  expect([by.sm.rows, by.md.rows, by.wd.rows, by.xl.rows]).toEqual([1, 5, 4, 5])

  // the 15-service island is not a long thin strip: its coast is about as wide as it is deep, and well inside the old strip's size (about 145 by 121)
  expect(by.wd.rx / by.wd.rz).toBeLessThan(1.4)
  expect(by.wd.rx, '15 services take a coast no wider than').toBeLessThan(110)
  expect(by.xl.rx, '27 services take a coast no wider than').toBeLessThan(150)

  // no two islands overlap
  for (let i = 0; i < built.length; i++)
    for (let j = i + 1; j < built.length; j++) {
      const a = built[i], b = built[j]
      const gap = Math.hypot(a.x - b.x, a.z - b.z) - Math.max(a.rx, a.rz) - Math.max(b.rx, b.rz)
      expect(gap, `${a.id} and ${b.id}`).toBeGreaterThan(0)
    }
  for (const b of built) note(info, `${b.id} coast (x by z)`, `${b.rx.toFixed(0)} by ${b.rz.toFixed(0)}`)

  // everything is drawn and healthy, and cars drive on every island
  await town.step(20)
  expect((await town.allBuildings()).filter((b) => b.state !== 'Healthy').map((b) => b.id)).toEqual([])
  const cars = await page.evaluate(() => (window as any).city.drawnCars())
  expect(cars.drawn).toBeGreaterThan(0)
  const cost = await frameCost(page)
  note(info, 'draw calls', String(cost.calls))
  note(info, 'frame ms (software rendering)', cost.ms.toFixed(0))
})
