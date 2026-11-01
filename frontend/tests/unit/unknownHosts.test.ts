import { describe, expect, it } from 'vitest'
import { addedRow, panelLabel, pathRule, unknownHostRow } from '../../src/unknownHosts'
import type { UnknownHostSnapshot } from '../../src/types'

const host = (over: Partial<UnknownHostSnapshot> = {}): UnknownHostSnapshot => ({ host: 'api.partner.example', calls: 12345.6, callers: ['aa.orders-api', 'bb.ledger-worker'], days: 3, gateway: false, vendorsOnly: false, ...over })

describe('a row of the Unknown hosts panel', () => {
  it('says how many calls, how many days and who called, and escapes the host', () => {
    const html = unknownHostRow(host({ host: '<b>x</b>.test', days: 1 }), 0)
    expect(html).toContain('about 12,346 calls')
    expect(html).toContain('1 day')
    expect(html).not.toContain('1 days')
    expect(html).toContain('aa.orders-api, bb.ledger-worker')
    expect(html).not.toContain('<b>x</b>')
  })

  it('has the three buttons Add vendor, Add internal and Ignore, and no copy buttons', () => {
    const html = unknownHostRow(host(), 2)
    expect(html).toContain('data-add="vendor" data-i="2">Add vendor<')
    expect(html).toContain('data-add="internal" data-i="2">Add internal<')
    expect(html).toContain('data-add="ignore" data-i="2">Ignore<')
    expect(html).not.toContain('data-copy')
  })

  it('offers only Ignore for a host nothing of the town called (only vendor buildings did)', () => {
    const html = unknownHostRow(host({ vendorsOnly: true }), 0)
    expect(html).toContain('>Ignore<')
    expect(html).not.toContain('Add vendor')
    expect(html).not.toContain('Add internal')
  })
})

describe('the button and the added list', () => {
  it('counts the unknown hosts and, when there are any, the hosts added from the panel', () => {
    expect(panelLabel(2, 0, false)).toBe('2 unknown hosts ▾')
    expect(panelLabel(1, 0, true)).toBe('1 unknown host ▴')
    expect(panelLabel(0, 3, false)).toBe('0 unknown hosts · 3 added ▾')
  })

  it('lists an added host with its kind and a Remove button, escaped', () => {
    const html = addedRow({ host: '<i>x</i>.test', kind: 'ignore', calledBy: [] }, 1)
    expect(html).toContain('ignored')
    expect(html).toContain('data-remove="1"')
    expect(html).not.toContain('<i>x</i>')
    expect(addedRow({ host: 'a.test', kind: 'internal', calledBy: ['x'] }, 0)).toContain('internal')
    expect(addedRow({ host: 'a.test', kind: 'vendor', calledBy: ['x'] }, 0)).toContain('vendor')
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
