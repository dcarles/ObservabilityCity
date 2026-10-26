import { describe, expect, it } from 'vitest'
import { isQuality, pixelRatioFor, QUALITIES, QUALITY_KEY, QUALITY_PRESETS, qualityName, saveQuality, startQuality, stepDown } from '../../src/quality'

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial }
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v } }
}
const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }

describe('the quality presets', () => {
  it('go from the most detail to the least: sharper, more shadows and more traffic at the top', () => {
    const [high, medium, low] = QUALITIES
    expect([high.id, medium.id, low.id]).toEqual(['high', 'medium', 'low'])
    expect(high.pixelRatioCap).toBeGreaterThan(medium.pixelRatioCap)
    expect(medium.pixelRatioCap).toBeGreaterThan(low.pixelRatioCap)
    expect(high.shadowMapSize).toBeGreaterThan(medium.shadowMapSize)
    expect(medium.shadowMapSize).toBeGreaterThan(low.shadowMapSize)
    expect(high.traffic).toBe(1)
    expect(medium.traffic).toBeLessThan(1)
    expect(low.traffic).toBeLessThan(medium.traffic)
    expect(low.traffic).toBeGreaterThan(0)
  })

  it('redraw shadows every frame at High, a few times a second at Medium, and not at all at Low', () => {
    expect(QUALITY_PRESETS.high.shadows).toBe('every-frame')
    expect(QUALITY_PRESETS.medium.shadows).toBe('few-per-second')
    expect(QUALITY_PRESETS.low.shadows).toBe('off')
  })

  it('every one has a name and a line of help for the list', () => {
    for (const q of QUALITIES) {
      expect(q.name.length).toBeGreaterThan(0)
      expect(q.hint.length).toBeGreaterThan(10)
    }
    expect(qualityName('low')).toBe('Quality: Low')
  })

  it('only know three names', () => {
    expect(isQuality('medium')).toBe(true)
    expect(isQuality('ultra')).toBe(false)
    expect(isQuality(null)).toBe(false)
  })
})

describe('stepping down', () => {
  it('goes one level at a time and stops at Low', () => {
    expect(stepDown('high')).toBe('medium')
    expect(stepDown('medium')).toBe('low')
    expect(stepDown('low')).toBeNull()
  })
})

describe('the resolution', () => {
  it('is capped by the preset and never below 1', () => {
    expect(pixelRatioFor('high', 3)).toBe(2)
    expect(pixelRatioFor('medium', 3)).toBe(1.5)
    expect(pixelRatioFor('low', 3)).toBe(1)
    expect(pixelRatioFor('high', 1)).toBe(1)
    expect(pixelRatioFor('high', 0.5)).toBe(1)
  })
})

describe('the quality the page opens with', () => {
  it('is High, unchosen, when nothing says otherwise', () => {
    expect(startQuality('', memory())).toEqual({ quality: 'high', chosen: false })
    expect(startQuality('', null)).toEqual({ quality: 'high', chosen: false })
  })

  it('is the page default when that is given (Medium on a wall), still unchosen', () => {
    expect(startQuality('?wall=1', memory(), 'medium')).toEqual({ quality: 'medium', chosen: false })
  })

  it('is what the address says, and chosen, so it never steps down by itself', () => {
    expect(startQuality('?quality=low', memory(), 'medium')).toEqual({ quality: 'low', chosen: true })
    expect(startQuality('?quality=high', memory({ [QUALITY_KEY]: 'low' }))).toEqual({ quality: 'high', chosen: true })
  })

  it('is what this browser last chose, after the address', () => {
    expect(startQuality('', memory({ [QUALITY_KEY]: 'low' }), 'medium')).toEqual({ quality: 'low', chosen: true })
  })

  it('ignores a name it does not know', () => {
    expect(startQuality('?quality=ultra', memory({ [QUALITY_KEY]: 'extreme' }))).toEqual({ quality: 'high', chosen: false })
  })

  it('remembers the choice, and carries on when the browser will not store it', () => {
    const store = memory()
    saveQuality(store, 'medium')
    expect(store.data[QUALITY_KEY]).toBe('medium')
    expect(() => saveQuality(blocked, 'low')).not.toThrow()
    expect(() => saveQuality(null, 'low')).not.toThrow()
    expect(startQuality('', blocked)).toEqual({ quality: 'high', chosen: false })
  })
})
