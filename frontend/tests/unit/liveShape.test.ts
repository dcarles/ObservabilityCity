import { describe, expect, it } from 'vitest'
import { liveShapeOf, withLiveShape } from '../../src/history/liveShape'

const node = (id: string, calls: string[], gatewayCalls: string[] = []) => ({ id, name: id, calls, gatewayCalls })
const snap = (nodes: ReturnType<typeof node>[], vendors: unknown[] = []) => ({ groups: [{ id: 'g', nodes }], vendors })

describe('live shape', () => {
  it('is nothing for something that is not a snapshot', () => {
    expect(liveShapeOf(null)).toBeNull()
    expect(liveShapeOf({})).toBeNull()
    expect(liveShapeOf('x')).toBeNull()
  })

  it('puts the links of the live town on a frame, keeping everything else of it', () => {
    const live = liveShapeOf(snap([node('a', ['b']), node('b', [])]))
    const frame = snap([{ ...node('a', []), name: 'old' }, node('b', [])])
    const out = withLiveShape(frame, live) as ReturnType<typeof snap>
    expect(out.groups[0].nodes[0].calls).toEqual(['b'])
    expect(out.groups[0].nodes[0].name).toBe('old')
    expect(frame.groups[0].nodes[0].calls).toEqual([])
  })

  it('leaves a system the live town does not have as it is', () => {
    const live = liveShapeOf(snap([node('a', ['b'])]))
    const out = withLiveShape(snap([node('z', ['q'])]), live) as ReturnType<typeof snap>
    expect(out.groups[0].nodes[0].calls).toEqual(['q'])
  })

  it('takes the links of third parties too', () => {
    const live = liveShapeOf(snap([], [{ node: { id: 'v' }, calledBy: ['a'], calls: [] }]))
    const out = withLiveShape(snap([], [{ node: { id: 'v' }, calledBy: [], calls: [] }]), live) as { vendors: { calledBy: string[] }[] }
    expect(out.vendors[0].calledBy).toEqual(['a'])
  })

  it('returns the frame as it is with no live town yet or when it is not a snapshot', () => {
    const frame = snap([node('a', [])])
    expect(withLiveShape(frame, null)).toBe(frame)
    expect(withLiveShape(42, liveShapeOf(frame))).toBe(42)
  })
})
