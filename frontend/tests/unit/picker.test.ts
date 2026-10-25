import { describe, expect, it } from 'vitest'
import { rankItems, type PickItem } from '../../src/picker'

const items: PickItem[] = [
  { kind: 'town', id: '*', name: 'Whole town', where: '' },
  { kind: 'island', id: 'cl', name: 'Core Ledger', where: 'Core Ledger' },
  { kind: 'building', id: 'cl.ledger-api', name: 'Ledger API', where: 'Core Ledger' },
  { kind: 'building', id: 'pay.payments-api', name: 'Payments API', where: 'Payments' },
  { kind: 'building', id: 'pay.refunds-api', name: 'Refunds API', where: 'Payments' },
]

describe('rankItems', () => {
  it('finds nothing for an empty search box, and everything for an empty dropdown', () => {
    expect(rankItems(items, '  ', 8)).toEqual([])
    expect(rankItems(items, '', 8, true)).toHaveLength(5)
    expect(rankItems(items, '', 2, true)).toHaveLength(2)
  })

  it('wants every word, in the name, the id or the island', () => {
    expect(rankItems(items, 'api payments', 8).map((i) => i.id)).toEqual(['pay.payments-api', 'pay.refunds-api'])
    expect(rankItems(items, 'refunds', 8).map((i) => i.id)).toEqual(['pay.refunds-api'])
    expect(rankItems(items, 'nope', 8)).toEqual([])
  })

  it('puts names that start with the text first, and islands before their buildings', () => {
    expect(rankItems(items, 'ledger', 8).map((i) => i.id)).toEqual(['cl.ledger-api', 'cl'])
    expect(rankItems(items, 'core', 8).map((i) => i.id)).toEqual(['cl', 'cl.ledger-api'])
    expect(rankItems(items, 'pay', 8)[0].id).toBe('pay.payments-api')
  })
})
