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
    expect(queueRows({ queues: [q('sbq-a-inbox', 25, 2, tool)] })).toEqual([{ name: 'sbq-a-inbox', text: '25 waiting · 2 dead', tone: 'bad', link: tool }])
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
    nodeOf(t).queues = [{ name: 'a', backlog: 3, deadLetters: 1, link: { name: 'Tool', url: 'https://t.example.test/a' } }, { name: '', backlog: 1 }, { name: 'b', backlog: 'x', link: { name: 'Tool', url: 'javascript:1' } }, 'junk']
    expect(nodeOf(checkSnapshot(t).snapshot!).queues).toEqual([
      { name: 'a', backlog: 3, deadLetters: 1, link: { name: 'Tool', url: 'https://t.example.test/a' } },
      { name: 'b', backlog: null, deadLetters: null, link: null },
    ])

    delete nodeOf(t).queues
    expect(nodeOf(checkSnapshot(t).snapshot!).queues).toBeNull()
  })
})
