import { describe, expect, it } from 'vitest'
import { Arena, distToBlock } from '../../src/events/arena'
import { ALOOP, alienScript, standing } from '../../src/events/alienScript'
import { ISLANDS } from './events.testutil'

const times = Array.from({ length: Math.round(ALOOP / 0.1) + 1 }, (_, i) => i * 0.1)

for (const src of ISLANDS) {
  describe(`the alien invasion on the ${src.id} island (${src.blocks.length} buildings)`, () => {
    const arena = new Arena(src)
    const S = alienScript(arena)
    const radius = (role: string): number => (role === 'alien' ? 0.9 : 0.45)

    it('hovers the saucers over real buildings of the island', () => {
      for (const s of S.saucers) {
        expect(arena.onLand(s.hover.x, s.hover.z)).toBe(true)
        expect(Math.min(...src.blocks.map((b) => distToBlock(b, s.hover.x, s.hover.z)))).toBeLessThan(12)
      }
    })

    it('never walks an alien or a defender through a building, on the ground', () => {
      for (const t of times) for (const w of S.walkers) {
        const s = w.st(t)
        if (!s || !standing(w, t) || s.pos.y > 0.3) continue
        for (const b of src.blocks) expect(distToBlock(b, s.pos.x, s.pos.z), `${w.id} at ${t.toFixed(1)}s and ${b.id}`).toBeGreaterThan(radius(w.role) * 0.7)
      }
    })

    it('keeps aliens and defenders from standing inside each other, or inside the mech', () => {
      for (const t of times) {
        const up = S.walkers.filter((w) => standing(w, t) && (w.st(t)?.pos.y ?? 9) < 0.3)
        for (let i = 0; i < up.length; i++) {
          const a = up[i].st(t)!.pos
          expect(Math.hypot(a.x - S.mech.x, a.z - S.mech.z) - radius(up[i].role) - 1.5, `${up[i].id} and the mech at ${t.toFixed(1)}s`).toBeGreaterThan(-0.1)
          for (let j = i + 1; j < up.length; j++) {
            const b = up[j].st(t)!.pos
            expect(Math.hypot(a.x - b.x, a.z - b.z) - radius(up[i].role) - radius(up[j].role), `${up[i].id} and ${up[j].id} at ${t.toFixed(1)}s`).toBeGreaterThan(-0.05)
          }
        }
      }
    })

    it('has the aliens punch real buildings, which are hit when the first punch lands', () => {
      expect(S.targets.length).toBeGreaterThan(0)
      S.targets.forEach((b, i) => {
        expect(src.blocks).toContain(b)
        expect(S.hit[i]).toBeLessThan(ALOOP)
      })
    })

    it('has the saucers come in, drop their aliens and leave', () => {
      for (const s of S.saucers) {
        expect(s.pos(0).y).toBeGreaterThan(30)
        expect(s.pos(s.drop).distanceTo(s.hover)).toBeLessThan(2)
        expect(s.pos(ALOOP).distanceTo(s.hover)).toBeGreaterThan(40)
      }
    })

    it('brings every alien down with at least three bullets, no gun firing faster than it can', () => {
      for (const f of S.falls) {
        const hits = S.armoury.shots.filter((s) => s.target === f.id)
        expect(hits.length, f.id).toBeGreaterThanOrEqual(3)
        expect(Math.max(...hits.map((h) => h.hit))).toBeLessThanOrEqual(f.at)
      }
      S.armoury.shooters.forEach((sh, i) => {
        const list = S.armoury.of(i)
        for (let k = 1; k < list.length; k++) expect(list[k].t - list[k - 1].t, `${sh.id}`).toBeGreaterThanOrEqual(sh.gap - 1e-9)
      })
    })

    it('fires up at every saucer while it is over the island', () => {
      for (const s of S.saucers) expect(S.armoury.shots.filter((x) => x.target === s.id).length).toBeGreaterThan(20)
    })
  })
}
