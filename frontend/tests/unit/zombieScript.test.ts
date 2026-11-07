import { describe, expect, it } from 'vitest'
import { Arena, distToBlock } from '../../src/events/arena'
import { upright, zombieScript, ZLOOP, type Person } from '../../src/events/zombieScript'
import { clearance, type Disc } from '../../src/events/rig'
import { ISLANDS } from './events.testutil'

const times = Array.from({ length: Math.round(ZLOOP / 0.1) + 1 }, (_, i) => i * 0.1)
const discOf = (p: Person, t: number): Disc | null => {
  const s = p.st(t)
  return s && upright(p, t) && s.pos.y > -0.3 ? { x: s.pos.x, z: s.pos.z, r: p.r } : null
}

for (const src of ISLANDS) {
  describe(`the zombie defence on the ${src.id} island (${src.blocks.length} buildings)`, () => {
    const arena = new Arena(src)
    const S = zombieScript(arena)

    it('stands the barricade and its props on the island, clear of every building and of each other', () => {
      expect(S.props.length).toBeGreaterThan(0)
      for (const p of S.props) {
        for (const b of src.blocks) expect(distToBlock(b, p.x, p.z), `${p.kind} and ${b.id}`).toBeGreaterThan(0.5)
        for (const q of S.props) if (p !== q && !(p.wall && q.wall)) expect(clearance(p.discs, q.discs), `${p.kind} and ${q.kind}`).toBeGreaterThan(0.1)
      }
    })

    it('drives both armoured cars clear of buildings, props and each other', () => {
      for (const t of times) {
        for (let c = 0; c < 2; c++) {
          if (t < S.cars[c].since) continue
          const discs = S.carDiscs(c, t)
          for (const d of discs) for (const b of src.blocks) expect(distToBlock(b, d.x, d.z), `car ${c} at ${t.toFixed(1)}s and ${b.id}`).toBeGreaterThan(0.3)
          for (const p of S.props) expect(clearance(discs, p.discs), `car ${c} at ${t.toFixed(1)}s and ${p.kind}`).toBeGreaterThan(0)
        }
        if (t >= S.cars[1].since) expect(clearance(S.carDiscs(0, t), S.carDiscs(1, t))).toBeGreaterThan(0.1)
      }
    })

    it('never walks anyone through a building, a prop or a car', () => {
      for (const t of times) for (const p of S.people) {
        const d = discOf(p, t)
        if (!d) continue
        for (const b of src.blocks) expect(distToBlock(b, d.x, d.z), `${p.id} at ${t.toFixed(1)}s and ${b.id}`).toBeGreaterThan(p.r * 0.7)
        for (const pr of S.props) expect(clearance([d], pr.discs), `${p.id} at ${t.toFixed(1)}s and ${pr.kind}`).toBeGreaterThan(-0.05)
        for (let c = 0; c < 2; c++) if (t >= S.cars[c].since) expect(clearance([d], S.carDiscs(c, t)), `${p.id} at ${t.toFixed(1)}s and car ${c}`).toBeGreaterThan(-0.05)
      }
    })

    it('never lets two people on their feet stand inside each other', () => {
      for (const t of times) {
        const up = S.people.map((p) => ({ p, d: discOf(p, t) })).filter((x) => x.d)
        for (let i = 0; i < up.length; i++) for (let j = i + 1; j < up.length; j++) {
          expect(clearance([up[i].d!], [up[j].d!]), `${up[i].p.id} and ${up[j].p.id} at ${t.toFixed(1)}s`).toBeGreaterThan(-0.05)
        }
      }
    })

    it('keeps everyone on the island once they are ashore', () => {
      for (const t of times) for (const p of S.people) {
        const s = p.st(t)
        if (s && upright(p, t) && s.pos.y >= -0.05) expect(arena.onLand(s.pos.x, s.pos.z) || arena.coastDistance(s.pos.x, s.pos.z) < 0.3, `${p.id} at ${t.toFixed(1)}s`).toBe(true)
      }
    })

    it('has the horde wade ashore from the sea, and the fighters outside turn into zombies', () => {
      const first = S.people.find((p) => p.id === 'zombie-0')!
      const at = times.find((t) => first.st(t))!
      expect(first.st(at + 0.1)!.pos.y).toBeLessThan(0)
      expect(arena.coastDistance(first.st(at + 0.1)!.pos.x, first.st(at + 0.1)!.pos.z)).toBeGreaterThan(0)
      const turned = S.people.filter((p) => p.role === 'turned')
      expect(turned.length).toBe(2)
      for (const p of turned) {
        const fell = S.falls.find((f) => f.id === p.id.replace('-turned', ''))!
        expect(p.st(fell.at - 0.5)).toBeNull()
        expect(p.st(fell.at + 3.5)).not.toBeNull()
      }
    })

    it('has the horde reach and claw at real buildings, which are hit when they get there', () => {
      expect(S.targets.length).toBeGreaterThan(0)
      for (const [i, b] of S.targets.entries()) {
        expect(src.blocks).toContain(b)
        expect(S.hit[i]).toBeLessThan(ZLOOP)
      }
    })

    it('pays for every fall with at least three bullets that land by the time it falls', () => {
      for (const f of S.falls) {
        if (!/^zombie-\d+$|-turned$|^(sam|shaun)-opponent-1$|^boss$/.test(f.id)) continue
        const hits = S.armoury.shots.filter((s) => s.target === f.id)
        expect(hits.length, f.id).toBeGreaterThanOrEqual(3)
        expect(Math.max(...hits.map((h) => h.hit)), f.id).toBeLessThanOrEqual(f.at + 1e-6)
      }
    })

    it('has the giant come once it is quiet, and the whole line open fire on it', () => {
      const lastZombie = Math.max(...S.falls.filter((f) => f.id !== 'boss' && f.id !== 'sam' && f.id !== 'shaun').map((f) => f.at))
      expect(S.bossStart).toBeGreaterThan(lastZombie)
      expect(S.bossFall).toBeLessThan(ZLOOP)
      const volley = S.armoury.shots.filter((s) => s.target === 'boss')
      expect(volley.length).toBeGreaterThan(100)
      expect(new Set(volley.map((s) => s.shooter)).size).toBeGreaterThanOrEqual(6)
    })
  })
}
