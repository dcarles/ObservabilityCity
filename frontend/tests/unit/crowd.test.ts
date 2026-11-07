import { describe, expect, it } from 'vitest'
import { settle } from '../../src/events/crowd'
import { seq, V } from '../../src/events/rig'

const walker = (from: number, to: number, start: number) => (delay: number) =>
  seq(0, [{ d: start + delay, from: V(from, 0, 0), clip: 'Idle' }, { d: 10, from: V(from, 0, 0), to: V(to, 0, 0), clip: 'Walk' }, { d: 99, from: V(to, 0, 0), clip: 'Idle' }])

describe('keeping people apart', () => {
  it('leaves people who never meet alone', () => {
    const d = settle([{ id: 'a', r: 0.5, make: walker(0, 10, 0) }, { id: 'b', r: 0.5, make: walker(0, 10, 0) }].map((b, i) => ({ ...b, make: (x: number) => walker(i * 20, i * 20 + 5, 0)(x) })), 40)
    expect(d).toEqual([0, 0])
  })
  it('delays the one who would walk through another, and never moves a fixed one', () => {
    const d = settle([{ id: 'a', r: 0.5, fixed: true, make: walker(0, 10, 0) }, { id: 'b', r: 0.5, make: walker(10, 0, 0) }], 60)
    expect(d[0]).toBe(0)
    expect(d[1]).toBeGreaterThan(0)
  })
})
