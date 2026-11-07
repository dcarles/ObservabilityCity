import { describe, expect, it } from 'vitest'
import { messagesPerSecond, overviewRows, queueRows, queueTypes, TYPES_SHOWN, typeRate } from '../../src/inspectorModel'
import { checkSnapshot } from '../../src/snapshotGuard'
import { healthyTown } from './wall.testutil'
import type { NodeSnapshot } from '../../src/types'

const kinds = (...rates: number[]) => rates.map((perSecond, i) => ({ type: `Kind${i + 1}`, perSecond }))

describe('the kinds of message of a queue', () => {
  it('list the busiest few, highest first, and put the rest behind one line with their rates added up', () => {
    const t = queueTypes({ types: kinds(1, 6, 2, 0.5, 4, 3, 0.25, 0.05) })!

    expect(t.top.map((x) => x.name)).toEqual(['Kind2', 'Kind5', 'Kind6', 'Kind3', 'Kind1'])
    expect(t.top[0]).toEqual({ name: 'Kind2', text: '6.0 msg/s' })
    expect(t.top).toHaveLength(TYPES_SHOWN)
    expect(t.more).toEqual({ count: 3, text: '0.80 msg/s', cut: 0 }) // 0.5 + 0.25 + 0.05
    expect(t.all).toHaveLength(8)
    expect(t.total).toBe('17 msg/s')
  })

  it('count the quietest kinds the server left out in the line for the rest, and say there are more', () => {
    const t = queueTypes({ types: kinds(9, 8, 7, 6, 5, 4), typesCut: 50 })!

    expect(t.more).toEqual({ count: 51, text: '4.0 msg/s and more', cut: 50 })
  })

  it('have no line for the rest when everything is listed', () => {
    expect(queueTypes({ types: kinds(3, 2) })!.more).toBeNull()
  })

  it('are nothing when the environment does not measure them or the queue handled none', () => {
    expect(queueTypes({ types: null })).toBeNull()
    expect(queueTypes({})).toBeNull()
    expect(queueTypes({ types: [] })).toBeNull()
  })

  it('write a very small rate as under a hundredth, not as zero', () => {
    expect(typeRate(0.003)).toBe('under 0.01 msg/s')
    expect(typeRate(0)).toBe('0.00 msg/s')
    expect(typeRate(12.4)).toBe('12 msg/s')
  })

  it('come with the queue row', () => {
    const rows = queueRows({ queues: [{ name: 'a', backlog: 1, deadLetters: 0, types: kinds(2) }, { name: 'b', backlog: 0, deadLetters: 0 }] })

    expect(rows.find((r) => r.name === 'a')!.types!.top).toHaveLength(1)
    expect(rows.find((r) => r.name === 'b')!.types).toBeNull()
  })
})

describe('the snapshot guard and the kinds of message', () => {
  const nodeOf = (t: any) => t.groups.flatMap((g: any) => g.nodes)[0]

  it('keeps well formed kinds and the cut count, and drops a kind without a name or a rate', () => {
    const t = healthyTown() as any
    nodeOf(t).queues = [{ name: 'a', types: [{ type: 'Placed', perSecond: 2 }, { type: '', perSecond: 1 }, { type: 'Odd', perSecond: -1 }, { type: 'Bad', perSecond: 'x' }, 'junk'], typesCut: 3 }]

    const q = nodeOf(checkSnapshot(t).snapshot!).queues[0]

    expect(q.types).toEqual([{ type: 'Placed', perSecond: 2 }])
    expect(q.typesCut).toBe(3)
  })
})

describe('messages a second in all', () => {
  const node = (state: string, ...rates: (number | null)[]) => ({ state, queues: rates.map((perSecond, i) => ({ name: `q${i}`, perSecond })) }) as unknown as NodeSnapshot

  it('add up every queue of every system, a message crossing two queues counting in both', () => {
    expect(messagesPerSecond([node('Healthy', 6, 4), node('Degraded', 2.5)])).toBeCloseTo(12.5, 5)
  })

  it('leave out a system with no fresh data and a queue nothing measures', () => {
    expect(messagesPerSecond([node('Healthy', 3, null), node('Stale', 100)])).toBe(3)
  })

  it('are nothing when no queue is measured', () => {
    expect(messagesPerSecond([node('Healthy', null)])).toBeNull()
    expect(messagesPerSecond([])).toBeNull()
  })

  it('show in the broker building as one row, and in no other building', () => {
    const real = (healthyTown() as any).groups.flatMap((g: any) => g.nodes)[0] as NodeSnapshot
    const broker = { ...real, kind: 'Broker' } as NodeSnapshot
    const worker = { ...real, kind: 'Worker' } as NodeSnapshot

    expect(overviewRows(broker, undefined, null, 12.5).find((r) => r.label === 'Messages')!.value).toBe('13 msg/s through the queues')
    expect(overviewRows(worker, undefined, null, 12.5).some((r) => r.label === 'Messages')).toBe(false)
    expect(overviewRows(broker, undefined, null, null).some((r) => r.label === 'Messages')).toBe(false)
  })
})
