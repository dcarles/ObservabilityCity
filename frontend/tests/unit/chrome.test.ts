import { describe, expect, it } from 'vitest'
import { browserStore, isLighting, LIGHTING, LIGHTING_KEY, otherLighting, saveLighting, startLighting, type Store } from '../../src/lighting'
import { DEFAULT_THEME, saveTheme, startTheme, themeById, THEME_KEY, THEMES } from '../../src/themes'
import { LEGEND, LEGEND_ENTRIES, LEGEND_TABS } from '../../src/legend'
import { LEGEND_SVG, iconHtml } from '../../src/legendIcons'
import { DASH_LEGEND, dashLegendHtml } from '../../src/dashboard/legend'

const memory = (initial: Record<string, string> = {}): Store & { data: Record<string, string> } => {
  const data = { ...initial }
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v } }
}
const blocked: Store = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }

describe('day and dusk', () => {
  it('opens in the day', () => {
    expect(startLighting('', memory())).toBe('day')
    expect(startLighting('', null)).toBe('day')
  })

  it('opens the way this browser left it', () => {
    expect(startLighting('', memory({ [LIGHTING_KEY]: 'dusk' }))).toBe('dusk')
  })

  it('does what the address says before what the browser remembers', () => {
    expect(startLighting('?light=dusk', memory({ [LIGHTING_KEY]: 'day' }))).toBe('dusk')
    expect(startLighting('?light=day', memory({ [LIGHTING_KEY]: 'dusk' }))).toBe('day')
  })

  it('ignores a name it does not know', () => {
    expect(startLighting('?light=midnight', memory())).toBe('day')
    expect(startLighting('', memory({ [LIGHTING_KEY]: 'night' }))).toBe('day')
    expect(isLighting('night')).toBe(false)
  })

  it('remembers the choice, and carries on when the browser will not store it', () => {
    const store = memory()
    saveLighting(store, 'dusk')
    expect(store.data[LIGHTING_KEY]).toBe('dusk')
    expect(() => saveLighting(blocked, 'dusk')).not.toThrow()
    expect(startLighting('', blocked)).toBe('day')
    expect(() => saveLighting(null, 'dusk')).not.toThrow()
  })

  it('switches to the other one', () => {
    expect(otherLighting('day')).toBe('dusk')
    expect(otherLighting('dusk')).toBe('day')
  })

  it('has a darker sky and softer light at dusk, with the same parts as the day', () => {
    expect(Object.keys(LIGHTING.dusk)).toEqual(Object.keys(LIGHTING.day))
    expect(LIGHTING.dusk.sun.intensity).toBeLessThan(LIGHTING.day.sun.intensity)
    expect(LIGHTING.dusk.hemisphere.intensity).toBeLessThan(LIGHTING.day.hemisphere.intensity)
    for (const l of Object.values(LIGHTING)) {
      for (const c of [l.sky.top, l.sky.horizon, l.fog, l.sea.deep, l.sea.shallow, l.sun.color, l.hemisphere.sky, l.hemisphere.ground, l.page]) expect(c).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('does not fail where there is no window', () => {
    expect(browserStore()).toBeNull() // vitest runs in node
  })
})

describe('the theme picker', () => {
  it('offers the harbour town, which is the default, then space and the works', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['harbour-town', 'space', 'factory'])
    expect(DEFAULT_THEME).toBe('harbour-town')
    expect(themeById('harbour-town')?.name).toBe('Harbour town')
    expect(themeById('space')?.name).toBe('Space colony')
    expect(themeById('castle')).toBeUndefined()
  })

  it('opens with the default, or the one the address names', () => {
    expect(startTheme('', memory())).toEqual({ theme: THEMES[0], unknown: null })
    expect(startTheme('?theme=harbour-town', memory()).unknown).toBeNull()
  })

  it('falls back to the default for a theme it does not have, and says which', () => {
    expect(startTheme('?theme=castle', memory())).toEqual({ theme: THEMES[0], unknown: 'castle' })
    expect(startTheme('', memory({ [THEME_KEY]: 'castle' }))).toEqual({ theme: THEMES[0], unknown: null })
  })

  it('remembers the choice and carries on when the browser will not store it', () => {
    const store = memory()
    saveTheme('harbour-town', store)
    expect(store.data[THEME_KEY]).toBe('harbour-town')
    expect(() => saveTheme('harbour-town', blocked)).not.toThrow()
    expect(startTheme('', blocked).theme.id).toBe('harbour-town')
  })
})

describe('the legend', () => {
  it('has a few sections, each with something in it', () => {
    expect(LEGEND.length).toBeGreaterThanOrEqual(4)
    for (const s of LEGEND) { expect(s.title).not.toBe(''); expect(s.entries.length).toBeGreaterThan(0) }
  })

  it('has no entry twice and none without words', () => {
    const ids = LEGEND_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of LEGEND_ENTRIES) { expect(e.sees.trim()).not.toBe(''); expect(e.means.trim()).not.toBe('') }
  })

  it('keeps red for failures: errors, a failed request, dead letters, an Azure health report', () => {
    const red = LEGEND_ENTRIES.filter((e) => e.tone === 'red').map((e) => e.id).sort()
    expect(red).toEqual(['beacon-red', 'flag', 'health-sign', 'pen'])
  })

  it('keeps grey for no data', () => {
    expect(LEGEND_ENTRIES.filter((e) => e.tone === 'grey').map((e) => e.id).sort()).toEqual(['frozen', 'grey'])
    expect(LEGEND_ENTRIES.find((e) => e.id === 'grey')!.means).toMatch(/never read as healthy/i)
  })

  it('explains the things the plan says every signal has: floors, lights, beacon, cars, boats, crates, dead letters, weather, airport', () => {
    const text = LEGEND_ENTRIES.map((e) => `${e.sees} ${e.means}`).join(' ').toLowerCase()
    for (const word of ['floors', 'lit windows', 'beacon', 'car', 'taxi', 'boats', 'crates', 'dead letters', 'weather', 'airport', 'bridge', 'third party', 'signpost']) expect(text).toContain(word)
  })
})

describe('the legend tabs', () => {
  it('has the four tabs in order, and every section sits on one of them', () => {
    expect(LEGEND_TABS.map((t) => t.id)).toEqual(['problems', 'buildings', 'traffic', 'controls'])
    for (const s of LEGEND) expect(LEGEND_TABS.map((t) => t.id)).toContain(s.tab)
    for (const t of LEGEND_TABS) expect(LEGEND.filter((s) => s.tab === t.id).flatMap((s) => s.entries).length, t.id).toBeGreaterThan(0)
  })

  it('keeps each tab short enough to read on one screen', () => {
    for (const t of LEGEND_TABS) expect(LEGEND.filter((s) => s.tab === t.id).flatMap((s) => s.entries).length, t.id).toBeLessThanOrEqual(20)
  })

  it('puts the things that need you on the first tab', () => {
    const problems = LEGEND.filter((s) => s.tab === 'problems').flatMap((s) => s.entries).map((e) => e.id)
    for (const id of ['beacon-red', 'beacon-amber', 'health-sign', 'frozen', 'grey', 'dark', 'hazard', 'flag', 'crates', 'pen', 'weather']) expect(problems).toContain(id)
  })

  it('explains the top bar numbers, the buttons and wall mode', () => {
    const controls = LEGEND.filter((s) => s.tab === 'controls').flatMap((s) => s.entries).map((e) => e.id)
    for (const id of ['chip-requests', 'chip-messages', 'chip-errors', 'chip-p99', 'chip-dlq', 'chip-degraded', 'chip-incidents', 'chip-time', 'btn-layers', 'btn-theme', 'btn-quality', 'btn-search', 'btn-lighting', 'btn-dashboard', 'btn-home', 'wall', 'break']) expect(controls).toContain(id)
  })

  it('gives every entry a picture, and every drawn picture exists', () => {
    for (const e of LEGEND_ENTRIES) {
      expect(e.icon.trim(), e.id).not.toBe('')
      if (e.icon.startsWith('svg:')) expect(LEGEND_SVG[e.icon.slice(4)], e.id).toBeTruthy()
      expect(iconHtml(e.icon), e.id).not.toBe('')
    }
  })

  it('keeps the one-line meanings short, with the long part behind "more"', () => {
    for (const e of LEGEND_ENTRIES) expect(e.means.length, e.id).toBeLessThanOrEqual(90)
  })
})

describe('the dashboard legend', () => {
  it('is short and covers green, amber, red and grey', () => {
    expect(DASH_LEGEND.length).toBeLessThanOrEqual(10)
    expect(DASH_LEGEND.filter((l) => l.level).map((l) => l.level)).toEqual(['ok', 'warn', 'bad', 'none'])
  })

  it('says grey is never healthy, and draws every line', () => {
    expect(DASH_LEGEND.find((l) => l.level === 'none')!.text).toMatch(/never read as healthy/i)
    const html = dashLegendHtml()
    for (const l of DASH_LEGEND) expect(html).toContain(`data-id="${l.id}"`)
  })

  it('does not use town words', () => {
    const text = DASH_LEGEND.map((l) => `${l.title} ${l.text}`).join(' ').toLowerCase()
    for (const w of ['beacon', 'island', 'building', 'harbour', 'town']) expect(text).not.toContain(w)
  })
})
