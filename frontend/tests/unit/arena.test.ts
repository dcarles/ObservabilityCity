import { describe, expect, it } from 'vitest'
import { Arena, distToBlock, lengthOf } from '../../src/events/arena'
import { ISLANDS } from './events.testutil'

for (const src of ISLANDS) {
  describe(`the arena of the ${src.id} island`, () => {
    const arena = new Arena(src)
    it('finds clear ground, on the island and away from every building', () => {
      const p = arena.nearestClear(arena.centre.x, arena.centre.z)!
      expect(p).not.toBeNull()
      expect(arena.onLand(p.x, p.z)).toBe(true)
      for (const b of src.blocks) expect(distToBlock(b, p.x, p.z)).toBeGreaterThan(0.5)
    })
    it('walks round buildings: a path never goes through one', () => {
      const a = arena.shore
      const b = arena.inland(8, 0, src.seaward + Math.PI)!!
      const way = arena.path(a, b)!
      expect(way.length).toBeGreaterThan(1)
      for (let i = 0; i < way.length - 1; i++)
        for (let k = 0; k <= 20; k++) {
          const x = way[i].x + ((way[i + 1].x - way[i].x) * k) / 20
          const z = way[i].z + ((way[i + 1].z - way[i].z) * k) / 20
          for (const bl of src.blocks) expect(distToBlock(bl, x, z)).toBeGreaterThan(0.3)
        }
      expect(lengthOf(way)).toBeGreaterThan(0)
    })
    it('goes round an obstacle added later', () => {
      const a = new Arena(src)
      const from = a.shore
      const to = a.inland(8, 0, src.seaward + Math.PI)!
      const mid = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 }
      a.addObstacle({ x: mid.x, z: mid.z, r: 1 })
      for (const p of a.path(from, to)!) expect(Math.hypot(p.x - mid.x, p.z - mid.z)).toBeGreaterThan(0.9)
    })
    it('picks spread-out buildings, all different', () => {
      const s = arena.spread(4, arena.centre.x, arena.centre.z, 3)
      expect(new Set(s).size).toBe(s.length)
    })
  })
}
