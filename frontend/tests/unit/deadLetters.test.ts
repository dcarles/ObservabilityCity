import { describe, expect, it } from 'vitest'
import { deadLetterItems } from '../../src/deadLetters'
import { beaconLevel } from '../../src/visuals'
import type { NodeSnapshot, Snapshot } from '../../src/types'
import { healthyTown, withState } from './wall.testutil'

// Which queue holds the dead letters, and who reads it: the list under the top bar's DLQ number, a pier's own list, and the roof beacon.

const nodeOf = (s: Snapshot, id: string): NodeSnapshot => s.groups.flatMap((g) => g.nodes).find((n) => n.id === id)!
const queue = (name: string, deadLetters: number | null) => ({ name, backlog: 0, deadLetters, perSecond: null })

/** A healthy town where two systems on different islands each read queues, some with dead letters. */
function townWithDead(): Snapshot {
  const s = healthyTown()
  const readers = s.groups.flatMap((g) => g.nodes).filter((n) => n.kind === 'Worker')
  const [a, b] = [readers[0], readers[1]]
  let t = withState(s, a.id, 'Healthy', { deadLetters: 5, queues: [queue('q-big', 3), queue('q-small', 2), queue('q-none', 0)] })
  t = withState(t, b.id, 'Healthy', { deadLetters: 9, queues: [queue('q-worst', 9)] })
  return t
}

describe('the queues with dead letters', () => {
  it('lists each queue that holds some, worst first, with the island and the service that reads it', () => {
    const s = townWithDead()
    const items = deadLetterItems(s.groups)

    expect(items.map((i) => [i.queue, i.count])).toEqual([['q-worst', 9], ['q-big', 3], ['q-small', 2]])
    for (const i of items) {
      const reader = nodeOf(s, i.nodeId)
      expect(i.nodeName).toBe(reader.name)
      expect(s.groups.find((g) => g.id === i.groupId)!.nodes.map((n) => n.id)).toContain(i.nodeId)
    }
  })

  it('never lists a queue with none, or a system with no fresh data', () => {
    const s = townWithDead()
    const reader = deadLetterItems(s.groups)[0].nodeId
    expect(deadLetterItems(s.groups).some((i) => i.queue === 'q-none')).toBe(false)
    const stale = withState(s, reader, 'Stale', {})
    expect(deadLetterItems(stale.groups).some((i) => i.nodeId === reader)).toBe(false)
  })

  it('lists only one island\'s when asked', () => {
    const s = townWithDead()
    const all = deadLetterItems(s.groups)
    const island = all[0].groupId
    const mine = deadLetterItems(s.groups, island)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((i) => i.groupId === island)).toBe(true)
    expect(deadLetterItems(s.groups, 'no-such-island')).toEqual([])
  })

  it('is empty when no queue holds any', () => {
    expect(deadLetterItems(healthyTown().groups)).toEqual([])
  })
})

describe('the roof beacon of a system with dead letters', () => {
  const base = (patch: Partial<NodeSnapshot>): NodeSnapshot => nodeOf(withState(healthyTown(), healthyTown().groups[0].nodes[0].id, 'Healthy', patch), healthyTown().groups[0].nodes[0].id)

  it('is amber while the queue it reads holds dead letters, and green when it does not', () => {
    expect(beaconLevel(base({ deadLetters: 0, errorRate: 0 }))).toBe('green')
    expect(beaconLevel(base({ deadLetters: 4, errorRate: 0 }))).toBe('amber')
  })

  it('stays red when requests fail, whatever the dead letters', () => {
    expect(beaconLevel(base({ deadLetters: 4, errorRate: 0.9 }))).toBe('red')
  })

  it('ignores a number nothing supplies', () => {
    expect(beaconLevel(base({ deadLetters: 4, errorRate: 0, absent: ['deadLetters'] }))).toBe('green')
  })
})
