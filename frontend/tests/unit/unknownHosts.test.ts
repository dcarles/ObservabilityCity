import { describe, expect, it } from 'vitest'
import { ignoreLine, unknownHostRow, vendorEntry } from '../../src/unknownHosts'
import type { UnknownHostSnapshot } from '../../src/types'

const host = (over: Partial<UnknownHostSnapshot> = {}): UnknownHostSnapshot => ({ host: 'api.partner.example', calls: 12345.6, callers: ['aa.orders-api', 'bb.ledger-worker'], days: 3, ...over })

describe('the lines the Unknown hosts panel copies', () => {
  it('a vendor entry names the host as its domain and the systems seen calling it', () => {
    expect(vendorEntry(host())).toBe('- { id: ext.api-partner-example, name: api.partner.example, domains: [api.partner.example], calledBy: [aa.orders-api, bb.ledger-worker] }')
  })

  it('an ignore line matches exactly that host, with its dots escaped', () => {
    expect(ignoreLine(host())).toBe("- '^api\\.partner\\.example$'")
    const re = new RegExp(ignoreLine(host()).slice(3, -1), 'i')
    expect(re.test('api.partner.example')).toBe(true)
    expect(re.test('apixpartner.example')).toBe(false)
    expect(re.test('api.partner.example.evil.test')).toBe(false)
  })

  it('a row says how many calls, how many days and who called, and escapes the host', () => {
    const html = unknownHostRow(host({ host: '<b>x</b>.test', days: 1 }), 0)
    expect(html).toContain('about 12,346 calls')
    expect(html).toContain('1 day')
    expect(html).not.toContain('1 days')
    expect(html).toContain('aa.orders-api, bb.ledger-worker')
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('Copy vendor entry')
    expect(html).toContain('Copy ignore line')
  })
})
