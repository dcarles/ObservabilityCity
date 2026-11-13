import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { reasons } from '../../src/inspectorModel'
import type { NodeSnapshot } from '../../src/types'

// The server decides amber with a list of named rules (DegradedRules.cs). Each rule has a case in shared-test-data/degraded-rules/<rule>.json, a system the real snapshot
// builder made from numbers that trip only that rule (the backend tests keep the list of cases equal to the list of rules). The drawer and the wall explain a system with their
// own list, reasons(): these tests prove it can say why for every case on its own, without the server's line to lean on, so a rule added on the server and not here fails.

const folder = resolve(__dirname, '../../../shared-test-data/degraded-rules')
const cases = readdirSync(folder).filter((f) => f.endsWith('.json')).sort().map((f) => ({ rule: f.replace(/\.json$/, ''), node: JSON.parse(readFileSync(resolve(folder, f), 'utf8')) as NodeSnapshot }))

describe('the cases of the degraded rules', () => {
  it('are there, one for each rule the server has', () => {
    expect(cases.length).toBeGreaterThanOrEqual(11)
    expect(cases.map((c) => c.rule)).toContain('waiting-count')
  })

  it.each(cases.map((c) => [c.rule, c.node] as const))('%s: the drawer says why on its own, with no help from the server\'s line', (_rule, node) => {
    expect(node.state === 'Degraded' || node.state === 'Down').toBe(true)
    expect(node.reason).toBeTruthy() // the server always says why
    const own = reasons({ ...node, reason: null })

    expect(own.length).toBeGreaterThan(0)
    expect(own.join(' ')).not.toMatch(/nothing to flag/i)
  })
})

describe('an amber system the drawer\'s own list cannot explain', () => {
  const node = cases.find((c) => c.rule === 'cpu')!.node
  const quiet = { ...node, cpu: 0.1 } // every number inside its line, as if the server had a rule this list lacks

  it('shows the server\'s line instead of nothing', () => {
    expect(reasons({ ...quiet, state: 'Degraded', reason: 'a new rule is tripped' })).toEqual(['A new rule is tripped.'])
  })

  it('says nothing when the server has no line either, and for a healthy system', () => {
    expect(reasons({ ...quiet, state: 'Degraded', reason: null })).toEqual([])
    expect(reasons({ ...quiet, state: 'Healthy', reason: null })).toEqual([])
  })
})

describe('the waiting-count rule', () => {
  const node = cases.find((c) => c.rule === 'waiting-count')!.node

  it('is named in the drawer with the number and the line', () => {
    expect(reasons({ ...node, reason: null })).toEqual(['424 messages are waiting, past the line of 100.'])
  })

  it('does not apply to a system with no such line', () => {
    expect(reasons({ ...node, reason: null, backlogCountAmber: null, state: 'Healthy' })).toEqual([])
  })
})
