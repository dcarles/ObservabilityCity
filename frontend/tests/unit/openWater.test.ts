import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { isOpenWater } from '../../src/scene/sea'

const square = [new THREE.Vector2(-20, -20), new THREE.Vector2(20, -20), new THREE.Vector2(20, 20), new THREE.Vector2(-20, 20)]

describe('open water for a docking spot', () => {
  it('is water well away from the land, and not on it or right at its coast', () => {
    const map = { land: [square] }

    expect(isOpenWater(map, 60, 0)).toBe(true)
    expect(isOpenWater(map, 0, 0)).toBe(false)
    expect(isOpenWater(map, 21, 0)).toBe(false) // inside the margin boats keep from a coast
  })

  it('is everywhere water when there is no land at all', () => {
    expect(isOpenWater({ land: [] }, 3, 4)).toBe(true)
  })
})
