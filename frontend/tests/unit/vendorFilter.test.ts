import { describe, expect, it } from 'vitest'
import { hiddenVendorsParam, parseHiddenVendors, toggleVendor, vendorChoices, withoutHiddenVendors } from '../../src/vendorFilter'
import { pillarSelection, buildDashboard } from '../../src/dashboard/model'
import { pillarMenuHtml } from '../../src/dashboard/render'
import { groupWords } from '../../src/groupLabel'
import { ALL_TENANTS } from '../../src/tenants'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Snapshot } from '../../src/types'

const golden = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}.json`), 'utf8')) as Snapshot

describe('hidden third parties', () => {
  it('reads and writes the address value, each once and in a fixed order', () => {
    expect(parseHiddenVendors('?hidevendors=b,a&hidevendors=a, c ')).toEqual(['b', 'a', 'c'])
    expect(hiddenVendorsParam(['b', 'a'])).toBe('a,b')
    expect(hiddenVendorsParam([])).toBe('')
  })

  it('lists third parties before internal services, each by name', () => {
    const s = golden('bad-day')
    const choices = vendorChoices(s, [])
    expect(choices.length).toBeGreaterThan(0)
    expect(choices.every((c) => c.shown)).toBe(true)
    const firstInternal = choices.findIndex((c) => c.internal)
    if (firstInternal >= 0) expect(choices.slice(firstInternal).every((c) => c.internal)).toBe(true)
  })

  it('takes a hidden third party out of the snapshot and leaves the others, and is the same object when nothing is hidden', () => {
    const s = golden('bad-day')
    expect(withoutHiddenVendors(s, [])).toBe(s)
    const id = vendorChoices(s, [])[0].id
    const shown = withoutHiddenVendors(s, [id])
    expect(shown.vendors.length).toBeLessThan(s.vendors.length)
    expect(vendorChoices(shown, []).some((c) => c.id === id)).toBe(false)
    expect(vendorChoices(s, [id]).find((c) => c.id === id)!.shown).toBe(false)
  })

  it('toggles', () => {
    expect(toggleVendor([], 'x', false)).toEqual(['x'])
    expect(toggleVendor(['x', 'y'], 'x', true)).toEqual(['y'])
    expect(toggleVendor(['x'], 'x', false)).toEqual(['x'])
  })

  it('never puts a third party in the pillar choice sent to the server, so one whose callers are all hidden goes by itself', () => {
    const s = golden('bad-day')
    const first = s.groups.find((g) => !g.isHub)!.id
    const ids = pillarSelection(s, first, false)
    expect(ids).not.toContain(first)
    expect(ids.length).toBe(s.groups.filter((g) => !g.isHub).length - 1)
    expect(ids.every((id) => s.groups.some((g) => g.id === id))).toBe(true)
  })

  it('has an All pillars row and the third parties under their own headings in the Pillars list', () => {
    const s = golden('bad-day')
    const d = buildDashboard(s, ALL_TENANTS)
    const html = pillarMenuHtml(d, vendorChoices(s, []), s.internalVendorsLabel)
    expect(html.indexOf('data-pillar-all')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('data-pillar-all')).toBeLessThan(html.indexOf('data-pillar-box'))
    expect(html).toContain(`All ${groupWords(d.groupLabel).many.toLowerCase()}`) // the town's own word for a pillar
    expect(html).toContain('Third parties')
    expect(html).toContain('data-vendor-box')
  })
})
