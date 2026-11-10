import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { groupWords, withGroupWords } from '../../src/groupLabel'
import { forTown, LEGEND } from '../../src/legend'
import { layerWord } from '../../src/inspectorModel'
import { buildDashboard } from '../../src/dashboard/model'
import { flowTileHtml, summaryHtml } from '../../src/dashboard/render'
import { ALL_TENANTS } from '../../src/tenants'
import type { Snapshot } from '../../src/types'

const golden = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}.json`), 'utf8')) as Snapshot
const legendText = (groupLabel?: string) => forTown(LEGEND, { topology: 'hub-and-spoke', demo: true, groupLabel })
  .flatMap((s) => [s.title, ...s.entries.flatMap((e) => [e.sees, e.means, e.more ?? ''])]).join(' ')

describe('what a town calls an island (groupLabel)', () => {
  it('gives the forms the words need, and Pillar when the town sets none', () => {
    expect(groupWords('Team')).toEqual({ one: 'Team', many: 'Teams', lower: 'team', lowerMany: 'teams' })
    expect(groupWords('domain')).toEqual({ one: 'Domain', many: 'Domains', lower: 'domain', lowerMany: 'domains' })
    expect(groupWords('BU').lower).toBe('BU') // an acronym keeps its capitals
    expect(groupWords('').one).toBe('Pillar')
    expect(groupWords(null).many).toBe('Pillars')
    expect(groupWords(undefined).lower).toBe('pillar')
  })

  it('fills every hole of a text', () => {
    expect(withGroupWords('{Group}: one {group}; {Groups} and {groups}', groupWords('Team'))).toBe('Team: one team; Teams and teams')
  })

  it('names the island in the legend in the town\'s word, and Pillar by default', () => {
    const team = legendText('Team')
    expect(team).toContain('A team: one team\'s own services')
    expect(team).toContain('On a team island')
    expect(team).not.toMatch(/pillar|\{group\}/i)
    expect(legendText()).toContain('On a pillar island')
    expect(legendText()).not.toContain('{group}')
  })

  it('calls an island\'s own defaults after the label in the Config tab', () => {
    expect(layerWord('Pillar', 'Team')).toBe('team defaults')
    expect(layerWord('Pillar')).toBe('pillar defaults')
    expect(layerWord('System', 'Team')).toBe('this system')
  })

  it('says no team moves messages on the dashboard of a town of teams', () => {
    const tile = { top: [], all: [], max: 0, windowSeconds: 300, total: null }
    expect(flowTileHtml(tile, false, 'Team')).toContain('No team sends or receives')
    expect(flowTileHtml(tile, false)).toContain('No pillar sends or receives')
  })

  it('carries the town\'s label into the dashboard model and its summary', () => {
    const s = { ...golden('calm'), groupLabel: 'Team' }
    const d = buildDashboard(s, ALL_TENANTS)
    expect(d.groupLabel).toBe('Team')
    expect(summaryHtml(d).replace(/<[^>]*>/g, ' ')).not.toMatch(/\bpillar\b/i) // the words, not the attributes
  })
})
