import { describe, expect, it } from 'vitest'
import { wallFraming } from '../../src/wall/framing'

describe('where an island sits above the wall strip', () => {
  it('stands further back by what the strip covers, and lifts the island half of that', () => {
    const f = wallFraming(300, 1000) // the strip covers 30% of the screen

    expect(f.lift).toBeCloseTo(0.15)
    expect(f.zoom).toBeCloseTo(1 / 0.7, 5)
  })

  it('leaves the view alone when there is no strip or no screen to measure', () => {
    expect(wallFraming(0, 1000)).toEqual({ zoom: 1, lift: 0 })
    expect(wallFraming(300, 0)).toEqual({ zoom: 1, lift: 0 })
  })

  it('never pulls back far for a tall strip on a small screen, nor less than a little', () => {
    expect(wallFraming(900, 1000).zoom).toBe(1.8)
    expect(wallFraming(900, 1000).lift).toBeCloseTo(0.3)
    expect(wallFraming(20, 1000).zoom).toBe(1.1)
  })
})
