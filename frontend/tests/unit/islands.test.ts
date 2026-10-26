import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { islandChoices, islandsLabel, islandsParam, parseIslands, pruneIslands, searchIslands, toggleIsland } from '../../src/islands'
import { checkSnapshot } from '../../src/snapshotGuard'
import type { Snapshot } from '../../src/types'

// island-filter.json is written by the backend's tests: the mini town seen through the filter aa and cc, with bb left out.
const golden = JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/island-filter.json'), 'utf8')) as Snapshot
const calm = JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/calm.json'), 'utf8')) as Snapshot

describe('islands from the address', () => {
  it('reads a comma list, repeats and blanks', () => {
    expect(parseIslands('?islands=cl,pay')).toEqual(['cl', 'pay'])
    expect(parseIslands('?islands=cl&islands=pay,cl')).toEqual(['cl', 'pay'])
    expect(parseIslands('?islands=%20cl%20,,pay')).toEqual(['cl', 'pay'])
  })

  it('shows every island when the address names none', () => {
    expect(parseIslands('')).toEqual([])
    expect(parseIslands('?islands=')).toEqual([])
    expect(parseIslands('?env=prod')).toEqual([])
  })

  it('writes the choice back in a fixed order', () => {
    expect(islandsParam(['pay', 'cl'])).toBe('cl,pay')
    expect(islandsParam([])).toBe('')
    expect(parseIslands(`?islands=${islandsParam(['pay', 'cl'])}`)).toEqual(['cl', 'pay'])
  })
})

describe('the list of islands to choose from', () => {
  it('lists the islands on screen and the ones the filter left out, by name, and never the hub', () => {
    const choices = islandChoices(golden)

    expect(choices).toEqual([
      { id: 'aa', name: 'Alpha', shown: true },
      { id: 'bb', name: 'Beta', shown: false },
      { id: 'cc', name: 'Gamma', shown: true },
    ])
  })

  it('lists every island of an unfiltered town as shown', () => {
    const choices = islandChoices(calm)

    expect(choices.length).toBe(calm.groups.filter((g) => !g.isHub).length)
    expect(choices.every((c) => c.shown)).toBe(true)
    expect(choices.map((c) => c.name)).toEqual([...choices.map((c) => c.name)].sort((a, b) => a.localeCompare(b)))
  })

  it('still works for a snapshot from before the view existed', () => {
    const old = checkSnapshot({ ...calm, view: undefined, topology: undefined }).snapshot!
    expect(old.view).toEqual({ islands: [], unknown: [], hidden: [], links: [] })
    expect(islandChoices(old).every((c) => c.shown)).toBe(true)
  })
})

describe('choosing islands', () => {
  it('adds an island, takes it out again, and shows everything once the last one is gone', () => {
    expect(toggleIsland([], 'aa')).toEqual(['aa'])
    expect(toggleIsland(['aa'], 'cc')).toEqual(['aa', 'cc'])
    expect(toggleIsland(['aa', 'cc'], 'aa')).toEqual(['cc'])
    expect(toggleIsland(['cc'], 'cc')).toEqual([])
  })

  it('drops islands the town does not have, keeping the same array when none is dropped', () => {
    const choices = islandChoices(golden)
    const same = ['aa']
    expect(pruneIslands(same, choices)).toBe(same)
    expect(pruneIslands(['aa', 'zz'], choices)).toEqual(['aa'])
  })

  it('labels the button', () => {
    const choices = islandChoices(golden)
    expect(islandsLabel([], choices)).toBe('All islands')
    expect(islandsLabel(['bb'], choices)).toBe('Beta')
    expect(islandsLabel(['aa', 'cc'], choices)).toBe('2 of 3 islands')
    expect(islandsLabel(['zz'], choices)).toBe('zz')
  })

  it('finds islands by name or id', () => {
    const choices = islandChoices(golden)
    expect(searchIslands(choices, 'gam').map((c) => c.id)).toEqual(['cc'])
    expect(searchIslands(choices, 'BB').map((c) => c.id)).toEqual(['bb'])
    expect(searchIslands(choices, '').length).toBe(3)
    expect(searchIslands(choices, 'nothing')).toEqual([])
  })
})
