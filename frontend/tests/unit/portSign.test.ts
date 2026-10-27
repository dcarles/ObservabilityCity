import { describe, expect, it } from 'vitest'
import { portCountsLine, portSignText } from '../../src/portSign'

describe('the words on the broker port', () => {
  it('are the broker name in capitals', () => {
    expect(portSignText('Kafka')).toBe('KAFKA')
    expect(portSignText('Service Bus')).toBe('SERVICE BUS')
    expect(portSignText('  rabbitmq ')).toBe('RABBITMQ')
  })

  it('fall back to the Service Bus for a broker with no name', () => {
    expect(portSignText(undefined)).toBe('SERVICE BUS')
    expect(portSignText(null)).toBe('SERVICE BUS')
    expect(portSignText('   ')).toBe('SERVICE BUS')
  })

  it('are cut short with an ellipsis when too long for the board', () => {
    const text = portSignText('The very long name of an enterprise message broker')
    expect(text.length).toBeLessThanOrEqual(16)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('the counts line on the broker sign', () => {
  it('reads topics, subscriptions and piers', () => {
    expect(portCountsLine({ topics: 3, subscriptions: 6, piers: 5, legacy: 0 })).toEqual({ text: '3 topics · 6 subscriptions · 5 piers', hot: false })
  })

  it('says pier in the singular for one', () => {
    expect(portCountsLine({ topics: 1, subscriptions: 1, piers: 1, legacy: 0 })?.text).toBe('1 topics · 1 subscriptions · 1 pier')
  })

  it('adds the old-route reads and turns amber when there are any', () => {
    expect(portCountsLine({ topics: 3, subscriptions: 3, piers: 3, legacy: 1 })).toEqual({ text: '3 topics · 3 subscriptions · 3 piers · 1 legacy', hot: true })
  })

  it('is absent when nothing is configured, so an unconfigured broker shows no counts', () => {
    expect(portCountsLine({ topics: 0, subscriptions: 0, piers: 0, legacy: 0 })).toBeNull()
  })
})
