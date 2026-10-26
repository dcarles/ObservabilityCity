import { describe, expect, it } from 'vitest'
import { LIGHTING, startLighting } from '../../src/lighting'

const hex = /^#[0-9a-f]{6}$/i
const luma = (c: string) => { const n = parseInt(c.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) }

describe('the Dusk preset', () => {
  const { day, dusk } = LIGHTING

  it('is made only of real colours', () => {
    for (const c of [dusk.sky.top, dusk.sky.horizon, dusk.fog, dusk.sea.deep, dusk.sea.shallow, dusk.hemisphere.sky, dusk.hemisphere.ground, dusk.sun.color, dusk.page])
      expect(c).toMatch(hex)
  })

  it('is darker than Day but not so dark that the town cannot be read', () => {
    expect(luma(dusk.sky.top)).toBeLessThan(luma(day.sky.top))
    expect(dusk.hemisphere.intensity).toBeLessThan(day.hemisphere.intensity)
    expect(dusk.hemisphere.intensity).toBeGreaterThanOrEqual(0.8)
    expect(dusk.sun.intensity).toBeGreaterThanOrEqual(1.5)
    expect(dusk.exposure).toBeGreaterThanOrEqual(0.95)
  })

  it('makes lit windows glow more than Day does, and Day is the plain look', () => {
    expect(day.windowGlow).toBe(1)
    expect(dusk.windowGlow).toBeGreaterThan(2)
  })

  it('stands the sun lower for long shadows, and still above the horizon', () => {
    const elevation = (o: { x: number; y: number; z: number }) => Math.atan2(o.y, Math.hypot(o.x, o.z))
    expect(elevation(dusk.sunOffset)).toBeLessThan(elevation(day.sunOffset))
    expect(elevation(dusk.sunOffset)).toBeGreaterThan(0.15)
  })

  it('warms the sun toward orange', () => {
    const rgb = (c: string) => { const n = parseInt(c.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255] }
    const [r, , b] = rgb(dusk.sun.color)
    expect(r - b).toBeGreaterThan(100)
  })
})

describe('the lighting a page opens with', () => {
  it('can be given a default of its own: a wall opens on Dusk', () => {
    expect(startLighting('', null, 'dusk')).toBe('dusk')
    expect(startLighting('?light=day', null, 'dusk')).toBe('day')
    expect(startLighting('', null)).toBe('day')
  })
})
