import { describe, expect, it } from 'vitest'
import { queueRows } from '../../src/inspectorModel'
import { checkSnapshot } from '../../src/snapshotGuard'
import type { QueueSnapshot } from '../../src/types'
import { healthyTown } from './wall.testutil'

// Phase 3, slice 5: a consumer's drawer lists the queues it reads, each with a link to that queue's dead letters in the team's support tool, when the environment names one.

const q = (name: string, backlog: number | null, deadLetters: number | null, link: QueueSnapshot['link'] = undefined): QueueSnapshot => ({ name, backlog, deadLetters, link })
const tool = { name: 'Support tool', url: 'https://support.example.test/queues/x' }

describe('the queues of a consumer', () => {
  it('are rows with what waits, what is dead-lettered and the link', () => {
    expect(queueRows({ queues: [q('sbq-a-inbox', 25, 2, tool)] })).toEqual([{ name: 'sbq-a-inbox', text: '25 waiting · 2 dead', tone: 'bad', link: tool, types: null, regions: [] }])
  })

  it('put the queue with dead letters first, then the biggest backlog', () => {
    const rows = queueRows({ queues: [q('a', 1, 0), q('b', 150, 0), q('c', 0, 3), q('d', null, null)] })
    expect(rows.map((r) => r.name)).toEqual(['c', 'b', 'a', 'd'])
    expect(rows[3]!.text).toBe('no numbers') // a queue nothing measures is still listed
    expect(rows[0]!.tone).toBe('bad')
    expect(rows[1]!.tone).toBe('')
  })

  it('are nothing for a system that reads none', () => {
    expect(queueRows({})).toEqual([])
    expect(queueRows({ queues: null })).toEqual([])
  })

  it('drop a link that is not a web address, so a link can never run a script', () => {
    expect(queueRows({ queues: [q('a', 1, 1, { name: 'x', url: 'javascript:alert(1)' })] })[0]!.link).toBeNull()
    expect(queueRows({ queues: [q('a', 1, 1, { name: 'x', url: '//evil.example.test' })] })[0]!.link).toBeNull()
    expect(queueRows({ queues: [q('a', 1, 1, { name: '', url: 'https://ok.example.test' })] })[0]!.link).toBeNull()
  })
})

describe('dead letters in more than one region', () => {
  const north = { name: 'Support tool North', url: 'https://north.example.test/queues/a' }
  const west = { name: 'Support tool West', url: 'https://west.example.test/queues/a' }
  const split = (): QueueSnapshot => ({ name: 'a', backlog: 0, deadLetters: 11, link: tool, deadLetterRegions: [{ region: 'northeurope', count: 3, link: north }, { region: 'westeurope', count: 8, link: west }] })

  it('give the drawer row a tag, a count and its own link for each region, and not the one link for all', () => {
    const row = queueRows({ queues: [split()] })[0]!
    expect(row.link).toBeNull()
    expect(row.regions).toEqual([{ region: 'North', count: 3, link: north }, { region: 'West', count: 8, link: west }])
    expect(row.text).toBe('0 waiting · 11 dead')
  })

  it('drop a regional link that is not a web address, and a region with no dead letters', () => {
    const q2: QueueSnapshot = { ...split(), deadLetterRegions: [{ region: 'westeurope', count: 8, link: { name: 'x', url: 'javascript:1' } }, { region: 'northeurope', count: 0, link: north }] }
    expect(queueRows({ queues: [q2] })[0]!.regions).toEqual([{ region: 'West', count: 8, link: null }])
  })

  it('pass the snapshot guard, which repairs a bad region entry', () => {
    const t = healthyTown() as any
    t.groups[0].nodes[0].queues = [{ ...split(), deadLetterRegions: [{ region: 'westeurope', count: 8, link: west }, { region: '', count: 2 }, { region: 'x', count: 'many' }, { region: 'northeurope', count: 3, link: { name: 'T', url: 'javascript:1' } }, 'junk'] }]
    expect(checkSnapshot(t).snapshot!.groups[0].nodes[0].queues![0].deadLetterRegions).toEqual([{ region: 'westeurope', count: 8, link: west }, { region: 'northeurope', count: 3, link: null }])
  })
})

describe('messages a second in the queue rows', () => {
  it('are shown after what waits and what is dead', () => {
    const rows = queueRows({ queues: [{ name: 'a', backlog: 3, deadLetters: 1, perSecond: 2.5 }, { name: 'b', backlog: null, deadLetters: null, perSecond: 0.05 }, { name: 'c', backlog: 1, deadLetters: null, perSecond: 120.4 }] })
    const text = (n: string) => rows.find((r) => r.name === n)!.text

    expect(text('a')).toBe('3 waiting · 1 dead · 2.5 msg/s')
    expect(text('b')).toBe('0.05 msg/s')
    expect(text('c')).toBe('1 waiting · 120 msg/s')
  })

  it('are left out when nothing measures them', () => {
    expect(queueRows({ queues: [{ name: 'a', backlog: 3, deadLetters: null }] })[0]!.text).toBe('3 waiting')
  })
})

describe('the snapshot guard and the sources of a system', () => {
  const nodeOf = (t: any) => t.groups.flatMap((g: any) => g.nodes)[0]

  it('keeps the sources with a name, repairs a bad age, and treats a missing list as none', () => {
    const t = healthyTown() as any
    nodeOf(t).sources = [{ source: 'platform', ageSeconds: 240, fresh: false, signals: ['cpu', 5] }, { source: '', ageSeconds: 1, fresh: true, signals: [] }, { source: 'telemetry', ageSeconds: -3, fresh: 'yes', signals: [] }, 'junk']
    expect(nodeOf(checkSnapshot(t).snapshot!).sources).toEqual([
      { source: 'platform', ageSeconds: 240, fresh: false, signals: ['cpu'] },
      { source: 'telemetry', ageSeconds: 0, fresh: false, signals: [] },
    ])

    delete nodeOf(t).sources
    expect(nodeOf(checkSnapshot(t).snapshot!).sources).toBeNull()
  })
})

describe('the snapshot guard and queues', () => {
  const nodeOf = (t: any) => t.groups.flatMap((g: any) => g.nodes)[0]

  it('keeps well formed queues, drops one without a name and a link that is not a web address, and treats a missing list as none', () => {
    const t = healthyTown() as any
    nodeOf(t).queues = [{ name: 'a', backlog: 3, deadLetters: 1, perSecond: 2.5, link: { name: 'Tool', url: 'https://t.example.test/a' } }, { name: '', backlog: 1 }, { name: 'b', backlog: 'x', link: { name: 'Tool', url: 'javascript:1' } }, 'junk']
    expect(nodeOf(checkSnapshot(t).snapshot!).queues).toEqual([
      { name: 'a', backlog: 3, deadLetters: 1, link: { name: 'Tool', url: 'https://t.example.test/a' }, perSecond: 2.5, types: null, typesCut: 0, deadLetterRegions: null },
      { name: 'b', backlog: null, deadLetters: null, link: null, perSecond: null, types: null, typesCut: 0, deadLetterRegions: null },
    ])

    delete nodeOf(t).queues
    expect(nodeOf(checkSnapshot(t).snapshot!).queues).toBeNull()
  })
})
