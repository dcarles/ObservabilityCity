import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ALOOP, alienScript, standing } from '../../src/events/alienScript'
import { miniTown } from '../../src/events/world'

const town = miniTown(new THREE.Group(), { cols: 3, rows: 2, seed: 21 })
const blocks = town.buildings.map((b) => ({ x: b.x, z: b.z, w: b.w, d: b.d }))
const S = alienScript(blocks)
const times = Array.from({ length: Math.round(ALOOP / 0.1) + 1 }, (_, i) => i * 0.1)

describe('the alien invasion', () => {
  it('never walks an alien through a building', () => {
    for (const t of times) for (const w of S.walkers.filter((x) => x.role === 'alien')) {
      const s = w.st(t)
      if (!s || !standing(w, t) || s.pos.y > 0.3) continue
      for (const b of blocks) {
        const inside = Math.abs(s.pos.x - b.x) < b.w / 2 + 0.3 && Math.abs(s.pos.z - b.z) < b.d / 2 + 0.3
        expect(inside, `${w.id} at ${t.toFixed(1)}s is inside the building at ${b.x.toFixed(1)},${b.z.toFixed(1)}`).toBe(false)
      }
    }
  })

  it('keeps aliens and defenders from standing inside each other', () => {
    for (const t of times) {
      const up = S.walkers.filter((w) => standing(w, t) && (w.st(t)?.pos.y ?? 9) < 0.3)
      for (let i = 0; i < up.length; i++) for (let j = i + 1; j < up.length; j++) {
        const a = up[i].st(t)!.pos
        const b = up[j].st(t)!.pos
        const ra = up[i].role === 'alien' ? 1 : 0.45
        const rb = up[j].role === 'alien' ? 1 : 0.45
        expect(Math.hypot(a.x - b.x, a.z - b.z) - ra - rb, `${up[i].id} and ${up[j].id} at ${t.toFixed(1)}s`).toBeGreaterThan(-0.2)
      }
    }
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

  it('fires up at every saucer while it is over the town', () => {
    for (const s of S.saucers) expect(S.armoury.shots.filter((x) => x.target === s.id).length).toBeGreaterThan(20)
  })
})
