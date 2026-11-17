import { describe, expect, it } from 'vitest'
import { BUILDING_DISTANCE, TALL_FROM, buildingFraming, islandFraming } from '../../src/scene/tallFraming'

describe('looking at a tall building', () => {
  it('frames a building no taller than before exactly as it always was', () => {
    for (const height of [3, 10, TALL_FROM]) {
      expect(buildingFraming(height)).toEqual({ aim: 2, distance: BUILDING_DISTANCE, tall: false })
    }
  })

  it('stands further back and looks higher the taller the building is', () => {
    let last = buildingFraming(TALL_FROM)
    for (const height of [22, 28, 34, 40]) {
      const now = buildingFraming(height)
      expect(now.tall).toBe(true)
      expect(now.distance).toBeGreaterThan(last.distance)
      expect(now.aim).toBeGreaterThan(last.aim)
      last = now
    }
  })

  it('aims at about the middle of a 20-floor tower, so the roof and the ground both stay on the screen', () => {
    // 20 floors of 1.6 units on a base of 1.84
    const height = 1.84 + 20 * 1.6
    const f = buildingFraming(height)
    expect(f.aim).toBeGreaterThan(height * 0.4)
    expect(f.aim).toBeLessThan(height * 0.6)
  })

  it('leaves an island of ordinary buildings where it was, and backs off from one with towers', () => {
    expect(islandFraming(12, 120)).toEqual({ aim: 0, distance: 120 })
    const tall = islandFraming(34, 120)
    expect(tall.distance).toBeGreaterThan(120)
    expect(tall.aim).toBeGreaterThan(0)
  })
})
