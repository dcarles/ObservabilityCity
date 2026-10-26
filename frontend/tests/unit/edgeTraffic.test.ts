import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { edgeKey, edgeLinks, edgeMode, isFiltered, SIGN_LINES, signBoard, signLines, signText } from '../../src/edgeTraffic'
import type { OffscreenLink, Snapshot } from '../../src/types'

// island-filter.json: the mini town through the filter aa and cc. cc.notify-api calls the hidden island bb through the gateway (32 req/s).
const golden = JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/island-filter.json'), 'utf8')) as Snapshot
const link = (nodeId: string, islandId: string, incoming: boolean, rps: number, name = islandId.toUpperCase()): OffscreenLink =>
  ({ nodeId, islandId, islandName: name, incoming, requestsPerSecond: rps })

describe('where traffic to a hidden island goes', () => {
  it('ends at the hub plaza in a hub-and-spoke town', () => {
    expect(golden.topology).toBe('hub-and-spoke')
    expect(edgeMode(golden)).toBe('plaza')
  })

  it('gets a signpost in a town whose islands call each other directly', () => {
    expect(edgeMode({ topology: 'direct' })).toBe('signpost')
    expect(edgeMode({ topology: 'something-new' })).toBe('signpost')
  })

  it('knows the traffic that crosses the edge from the golden snapshot', () => {
    expect(isFiltered(golden)).toBe(true)
    expect(edgeLinks(golden)).toEqual([{ nodeId: 'cc.notify-api', islandId: 'bb', islandName: 'Beta', incoming: false, requestsPerSecond: 32 }])
  })

  it('knows nothing is hidden in a whole town, and in an old snapshot', () => {
    expect(isFiltered({ view: { islands: [], unknown: [], hidden: [], links: [] } })).toBe(false)
    expect(edgeLinks({ view: undefined as never })).toEqual([])
  })

  it('counts a filter of nothing but typos as a filter', () => {
    expect(isFiltered({ view: { islands: [], unknown: ['zz'], hidden: [], links: [] } })).toBe(true)
  })
})

describe('the signpost on an island', () => {
  const links = [
    link('a.api', 'x', false, 12, 'Xray'),
    link('a.worker', 'x', false, 3, 'Xray'),
    link('a.api', 'x', true, 4, 'Xray'),
    link('a.api', 'y', true, 40, 'Yankee'),
    link('b.api', 'z', false, 99, 'Zulu'),
  ]

  it('has a line for each hidden island its systems talk to, busiest first', () => {
    const lines = signLines(links, new Set(['a.api', 'a.worker']))

    expect(lines).toEqual([
      { islandId: 'y', island: 'Yankee', out: 0, in: 40 },
      { islandId: 'x', island: 'Xray', out: 15, in: 4 },
    ])
  })

  it('leaves out the links of other islands', () => {
    expect(signLines(links, new Set(['b.api'])).map((l) => l.islandId)).toEqual(['z'])
    expect(signLines(links, new Set(['nobody']))).toEqual([])
  })

  it('writes an arrow for each way the traffic goes, and none for a way it does not', () => {
    expect(signText({ islandId: 'x', island: 'Xray', out: 15, in: 4 })).toBe('Xray  →15/s  ←4.0/s')
    expect(signText({ islandId: 'y', island: 'Yankee', out: 0, in: 40 })).toBe('Yankee  ←40/s')
    expect(signText({ islandId: 'z', island: 'Zulu', out: 99, in: 0 })).toBe('Zulu  →99/s')
  })

  it('fits a few lines and says how many islands did not make it', () => {
    const many = Array.from({ length: SIGN_LINES + 3 }, (_, i) => ({ islandId: `i${i}`, island: `I${i}`, out: 1, in: 0 }))
    const board = signBoard(many)

    expect(board.shown.length).toBe(SIGN_LINES)
    expect(board.more).toBe(3)
    expect(signBoard(many.slice(0, 2))).toEqual({ shown: many.slice(0, 2), more: 0 })
  })
})

describe('what the layout depends on', () => {
  it('is empty for a whole town', () => {
    expect(edgeKey({ topology: 'hub-and-spoke', view: { islands: [], unknown: [], hidden: [], links: [] } })).toBe('')
  })

  it('changes with the links and the hidden islands, and not with how busy they are', () => {
    const busier = structuredClone(golden)
    busier.view.links[0].requestsPerSecond = 500
    const other = structuredClone(golden)
    other.view.links[0].incoming = true

    expect(edgeKey(busier)).toBe(edgeKey(golden))
    expect(edgeKey(other)).not.toBe(edgeKey(golden))
    expect(edgeKey(golden)).not.toBe('')
  })
})
