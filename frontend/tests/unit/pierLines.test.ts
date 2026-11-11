import { describe, expect, it } from 'vitest'
import { pierLines, type Messaging } from '../../src/scene/harbour'

const base: Messaging = { perSecond: 126.4, waiting: null, oldestSeconds: null, deadLetters: null, amber: 60, red: 300, topics: 3, subscriptions: 5 }

describe('what the pier says in words', () => {
  it('gives the rate its queues take in and its topics, and nothing about a side nothing measures', () => {
    expect(pierLines(base)).toEqual(['126 msg/s taken in by its queues', '3 topics · reads 5'])
  })

  it('adds what the pillar sends and receives, "none" for a side with no messages, and the backlog', () => {
    const lines = pierLines({ ...base, waiting: 12, oldestSeconds: 30, pillar: { sent: 750, internal: 0, received: null, windowSeconds: 300 } })
    expect(lines).toContain('Sends outside 750 msg/s')
    expect(lines).toContain('Sends inside: none')
    expect(lines.some((l) => l.startsWith('Receives'))).toBe(false)
    expect(lines.some((l) => l.startsWith('Waiting 12'))).toBe(true)
  })
})
