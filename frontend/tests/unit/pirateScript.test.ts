import { describe, expect, it } from 'vitest'
import { Arena, distToBlock } from '../../src/events/arena'
import { DECK, pirateScript, SHOTS } from '../../src/events/pirateScript'
import { ISLANDS } from './events.testutil'

for (const src of ISLANDS) {
  describe(`the pirate raid on the ${src.id} island (${src.blocks.length} buildings)`, () => {
    const arena = new Arena(src)
    const S = pirateScript(arena)
    const times = Array.from({ length: Math.round(S.loop / 0.1) + 1 }, (_, i) => i * 0.1)

    it('raids real buildings of the island, up to four of them', () => {
      expect(S.targets.length).toBeGreaterThan(0)
      expect(S.targets.length).toBeLessThanOrEqual(4)
      for (const b of S.targets) expect(src.blocks).toContain(b)
    })

    it('moors the ship beyond the coast, out to sea, and brings it in and away', () => {
      const away = (p: { x: number; z: number }): number => Math.sin(S.seaward) * (p.x - S.shore.x) + Math.cos(S.seaward) * (p.z - S.shore.z)
      expect(away(S.ship(0).pos)).toBeGreaterThan(40)
      expect(away(S.ship(30).pos)).toBeGreaterThan(5)
      expect(arena.onLand(S.ship(30).pos.x, S.ship(30).pos.z)).toBe(false)
      expect(S.ship(S.loop).pos.distanceTo(S.ship(30).pos)).toBeGreaterThan(40)
    })

    it('never walks a pirate through a building or into another pirate while ashore', () => {
      for (const t of times) {
        const on = S.pirates.map((p) => ({ p, s: p.st(t) })).filter((x) => x.s && x.s.pos.y < 1.2 && x.s.pos.y >= 0)
        for (const { p, s } of on) for (const b of src.blocks) expect(distToBlock(b, s!.pos.x, s!.pos.z), `${p.id} at ${t.toFixed(1)}s and ${b.id}`).toBeGreaterThan(0.3)
        for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
          const a = on[i].s!.pos
          const b = on[j].s!.pos
          expect(Math.hypot(a.x - b.x, a.z - b.z), `${on[i].p.id} and ${on[j].p.id} at ${t.toFixed(1)}s`).toBeGreaterThan(0.45)
        }
      }
    })

    it('has every pirate reach a door of a raided building, then carry loot back aboard before the ship turns', () => {
      for (const p of S.pirates) {
        const door = p.st(p.lootFrom - 0.2)!.pos
        const b = S.targets[p.target]
        expect(distToBlock(b, door.x, door.z), p.id).toBeLessThan(2.5)
        expect(p.lootTo, p.id).toBeLessThan(S.departs)
        expect(p.st(S.departs)!.pos.y, p.id).toBeGreaterThan(DECK - 0.5)
      }
    })

    it('hits every raided building with the cannon, in turn, and burns it from then on', () => {
      expect(S.hit.every((h) => h < S.loop)).toBe(true)
      S.targets.forEach((_, i) => expect(SHOTS.some((_, k) => S.shotTarget[k] === i)).toBe(true))
    })
  })
}
