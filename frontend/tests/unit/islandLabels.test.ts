import { describe, expect, it } from 'vitest'
import { labelOpacity, LABELS_FROM, LABELS_FULL } from '../../src/islandLabels'

describe('the island name signs seen from the air', () => {
  it('show nothing close up, everything from the air, and fade in between', () => {
    expect(labelOpacity(30)).toBe(0)
    expect(labelOpacity(LABELS_FROM)).toBe(0)
    expect(labelOpacity(LABELS_FULL)).toBe(1)
    expect(labelOpacity(900)).toBe(1)
    const mid = labelOpacity((LABELS_FROM + LABELS_FULL) / 2)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
  })
})
