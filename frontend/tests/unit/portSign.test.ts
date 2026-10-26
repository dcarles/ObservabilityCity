import { describe, expect, it } from 'vitest'
import { portSignText } from '../../src/portSign'

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
