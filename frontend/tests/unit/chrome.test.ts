import { describe, expect, it } from 'vitest'
import { browserStore, isLighting, LIGHTING, LIGHTING_KEY, otherLighting, saveLighting, startLighting, type Store } from '../../src/lighting'
import { DEFAULT_THEME, saveTheme, startTheme, themeById, THEME_KEY, THEMES } from '../../src/themes'
import { LEGEND, LEGEND_ENTRIES } from '../../src/legend'

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
  it('offers the harbour town, which is the default', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['harbour-town'])
    expect(DEFAULT_THEME).toBe('harbour-town')
    expect(themeById('harbour-town')?.name).toBe('Harbour town')
    expect(themeById('space')).toBeUndefined()
  })

  it('opens with the default, or the one the address names', () => {
    expect(startTheme('', memory())).toEqual({ theme: THEMES[0], unknown: null })
    expect(startTheme('?theme=harbour-town', memory()).unknown).toBeNull()
  })

  it('falls back to the default for a theme it does not have, and says which', () => {
    expect(startTheme('?theme=space', memory())).toEqual({ theme: THEMES[0], unknown: 'space' })
    expect(startTheme('', memory({ [THEME_KEY]: 'space' }))).toEqual({ theme: THEMES[0], unknown: null })
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

  it('keeps red for failures: errors, a failed request, dead letters', () => {
    const red = LEGEND_ENTRIES.filter((e) => e.tone === 'red').map((e) => e.id).sort()
    expect(red).toEqual(['beacon-red', 'flag', 'pen'])
  })

  it('keeps grey for no data', () => {
    expect(LEGEND_ENTRIES.filter((e) => e.tone === 'grey').map((e) => e.id)).toEqual(['grey'])
    expect(LEGEND_ENTRIES.find((e) => e.id === 'grey')!.means).toMatch(/never read as healthy/i)
  })

  it('explains the things the plan says every signal has: floors, lights, beacon, cars, boats, crates, dead letters, weather, airport', () => {
    const text = LEGEND_ENTRIES.map((e) => `${e.sees} ${e.means}`).join(' ').toLowerCase()
    for (const word of ['floors', 'lit windows', 'beacon', 'car', 'taxi', 'boats', 'crates', 'dead letters', 'weather', 'airport', 'bridge', 'third party', 'signpost']) expect(text).toContain(word)
  })
})
