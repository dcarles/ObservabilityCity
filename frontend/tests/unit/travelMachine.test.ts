import { describe, expect, it } from 'vitest'
import { cabinYaw, carRun, drawMachine, MACHINE_MS, pickMachine, progress, requestedMachine, type Machine } from '../../src/history/travelMachine'

const SCREEN = { x0: 0, x1: 960 }

describe('picking a machine', () => {
  it('is the car for the lower half of the dice and the cabin for the upper half', () => {
    expect(pickMachine(() => 0)).toBe('car')
    expect(pickMachine(() => 0.49)).toBe('car')
    expect(pickMachine(() => 0.5)).toBe('cabin')
    expect(pickMachine(() => 0.99)).toBe('cabin')
  })
  it('gives both over many jumps', () => {
    let seed = 7
    const random = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    const picks = new Set(Array.from({ length: 40 }, () => pickMachine(random)))
    expect([...picks].sort()).toEqual(['cabin', 'car'])
  })
  it('can be asked for in the address, for trying one', () => {
    expect(requestedMachine('?machine=car')).toBe('car')
    expect(requestedMachine('?test=1&machine=cabin')).toBe('cabin')
    expect(requestedMachine('?machine=boat')).toBeNull()
    expect(requestedMachine('')).toBeNull()
  })
})

describe('how far the journey has got', () => {
  it('runs from 0 to 1 over the length of the animation and stays at 1 while the page waits', () => {
    expect(progress(0)).toBe(0)
    expect(progress(MACHINE_MS / 2000)).toBeCloseTo(0.5, 5)
    expect(progress(MACHINE_MS / 1000)).toBe(1)
    expect(progress(60)).toBe(1)
  })
})

describe('the car', () => {
  it('drives left when going back in time and right when going forward, entering from off screen', () => {
    expect(carRun(0, true, SCREEN).x).toBeGreaterThan(SCREEN.x1)
    expect(carRun(0, false, SCREEN).x).toBeLessThan(SCREEN.x0)
    let last = Infinity
    for (let p = 0; p <= 0.8; p += 0.05) { const x = carRun(p, true, SCREEN).x; expect(x).toBeLessThanOrEqual(last); last = x }
    last = -Infinity
    for (let p = 0; p <= 0.8; p += 0.05) { const x = carRun(p, false, SCREEN).x; expect(x).toBeGreaterThanOrEqual(last); last = x }
  })
  it('blows up on screen, before it can leave it, in both directions', () => {
    const back = carRun(0.8, true, SCREEN), forward = carRun(0.8, false, SCREEN)
    expect(back.x).toBeGreaterThan(SCREEN.x0)
    expect(back.x).toBeLessThan(SCREEN.x1)
    expect(forward.x).toBeGreaterThan(SCREEN.x0)
    expect(forward.x).toBeLessThan(SCREEN.x1)
    expect(carRun(0.5, true, SCREEN).alive).toBe(true)
    expect(carRun(0.9, true, SCREEN).alive).toBe(false)
    expect(carRun(0.8, true, SCREEN).blast).toBe(0)
    expect(carRun(1, true, SCREEN).blast).toBe(1)
  })
  it('stops on the screen whatever its shape, because the run follows the visible width', () => {
    const narrow = { x0: 300, x1: 660 }
    const end = carRun(0.8, true, narrow).x
    expect(end).toBeGreaterThan(narrow.x0)
    expect(end).toBeLessThan(narrow.x1)
  })
})

describe('the cabin', () => {
  it('turns one way going back and the other going forward, faster in the middle than at the start', () => {
    expect(cabinYaw(0.5, 1, true)).toBeLessThan(0)
    expect(cabinYaw(0.5, 1, false)).toBeGreaterThan(0)
    expect(Math.abs(cabinYaw(0.5, 1, false))).toBe(Math.abs(cabinYaw(0.5, 1, true)))
    const start = Math.abs(cabinYaw(0.1, 0.25, false) - cabinYaw(0, 0, false))
    const middle = Math.abs(cabinYaw(0.5, 1.25, false) - cabinYaw(0.4, 1, false))
    expect(middle).toBeGreaterThan(start)
  })
})

// a drawing surface that accepts every call, so every frame of both machines can be drawn without a browser
function stubContext(): CanvasRenderingContext2D {
  return new Proxy({}, {
    get: (_t, k: string) => {
      if (k === 'measureText') return () => ({ width: 10 })
      if (k.startsWith('create')) return () => ({ addColorStop: () => undefined })
      return () => undefined
    },
    set: () => true
  }) as unknown as CanvasRenderingContext2D
}

describe('drawing', () => {
  const kinds: Machine[] = ['car', 'cabin']
  for (const kind of kinds) {
    it(`draws every moment of the ${kind}, in both directions and on very different screens, without a mistake`, () => {
      const g = stubContext()
      const views = [{ w: 1280, h: 720, dpr: 1 }, { w: 390, h: 844, dpr: 2 }, { w: 3440, h: 1440, dpr: 1 }]
      for (const view of views) for (const back of [true, false]) for (let t = 0; t <= 4; t += 0.1) drawMachine(g, kind, view, t, back)
    })
  }
})
