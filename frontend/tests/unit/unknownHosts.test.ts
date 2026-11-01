import { describe, expect, it } from 'vitest'
import { ignoreLine, pathRule, unknownHostRow, vendorEntry } from '../../src/unknownHosts'
import type { UnknownHostSnapshot } from '../../src/types'

const host = (over: Partial<UnknownHostSnapshot> = {}): UnknownHostSnapshot => ({ host: 'api.partner.example', calls: 12345.6, callers: ['aa.orders-api', 'bb.ledger-worker'], days: 3, gateway: false, vendorsOnly: false, ...over })

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

describe('a gateway host in the Unknown hosts panel', () => {
  const gw = host({
    host: 'gw.example.test', gateway: true,
    paths: [{ path: '/internal/x', calls: 400, vendorsOnly: false }, { path: '/odd/y', calls: 40, vendorsOnly: true }],
  })

  it('is listed by its unexplained paths, each with a path rule button, and has no vendor or ignore button', () => {
    const html = unknownHostRow(gw, 0)
    expect(html).toContain('/internal/x')
    expect(html).toContain('/odd/y')
    expect(html).toContain('Copy path rule')
    expect(html).not.toContain('Copy vendor entry')
    expect(html).not.toContain('Copy ignore line')
  })

  it('leaves out the paths only vendor buildings called unless they are asked for', () => {
    const html = unknownHostRow(gw, 0, false)
    expect(html).toContain('/internal/x')
    expect(html).not.toContain('/odd/y')
  })

  it('copies a rule line with the host and path filled in and the target left to complete', () => {
    const line = pathRule(gw, gw.paths![0])
    expect(line).toBe("- { host: '^gw\\.example\\.test$', path: '^/internal/x', target: <system id>, gateway: true }")
  })
})
