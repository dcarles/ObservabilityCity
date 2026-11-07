import { describe, expect, it } from 'vitest'
import { BZ, upright, zombieScript, ZLOOP, type Person } from '../../src/events/zombieScript'
import { clearance, type Disc } from '../../src/events/rig'
import * as THREE from 'three'
import { miniTown } from '../../src/events/world'

const S = zombieScript()
const barricade = (k: string): boolean => k.startsWith('Container') || k.endsWith('Barrier')
const radius = (p: Person): number => (p.model === 'BigArm' ? 1.2 : 0.45)
const discOf = (p: Person, t: number): Disc | null => {
  const s = p.st(t)
  return s && upright(p, t) ? { x: s.pos.x, z: s.pos.z, r: radius(p) } : null
}
const times = Array.from({ length: Math.round(ZLOOP / 0.1) + 1 }, (_, i) => i * 0.1)

describe('the zombie defence: nothing stands on anything else', () => {
  it('keeps every prop clear of every other prop (the barricade itself is one wall)', () => {
    for (const a of S.props) for (const b of S.props) {
      if (a === b || (barricade(a.kind) && barricade(b.kind))) continue
      expect(clearance(a.discs, b.discs), `${a.kind} at ${a.x},${a.z} and ${b.kind} at ${b.x},${b.z}`).toBeGreaterThan(0.1)
    }
  })

  it('drives the armoured car in without touching a prop or the other car', () => {
    for (let t = 0; t <= ZLOOP; t += 0.1) {
      const b = S.carDiscs(1, t)
      for (const p of S.props) expect(clearance(b, p.discs), `car B at ${t.toFixed(1)}s and ${p.kind} ${p.x},${p.z}`).toBeGreaterThan(0.1)
      expect(clearance(b, S.carDiscs(0, t))).toBeGreaterThan(0.3)
    }
    for (const p of S.props) expect(clearance(S.carDiscs(0, 0), p.discs), `car A and ${p.kind} ${p.x},${p.z}`).toBeGreaterThan(0.1)
  })

  it('keeps people off the props and the cars, at every moment', () => {
    for (const t of times) for (const p of S.people) {
      const d = discOf(p, t)
      if (!d) continue
      for (const pr of S.props) expect(clearance([d], pr.discs), `${p.id} at ${t.toFixed(1)}s and ${pr.kind} ${pr.x},${pr.z}`).toBeGreaterThan(0)
      for (let c = 0; c < S.cars.length; c++) if (t >= S.cars[c].since) expect(clearance([d], S.carDiscs(c, t)), `${p.id} at ${t.toFixed(1)}s and ${S.cars[c].id}`).toBeGreaterThan(0)
    }
  })

  it('never lets two people on their feet stand inside each other', () => {
    for (const t of times) {
      const up = S.people.map((p) => ({ p, d: discOf(p, t) })).filter((x) => x.d)
      for (let i = 0; i < up.length; i++) for (let j = i + 1; j < up.length; j++) {
        const gap = clearance([up[i].d!], [up[j].d!])
        expect(gap, `${up[i].p.id} and ${up[j].p.id} at ${t.toFixed(1)}s`).toBeGreaterThan(-0.05)
      }
    }
  })

  it('keeps the horde on the barricade side of the line, outside it', () => {
    for (const t of times) for (const p of S.people) {
      if (p.role !== 'horde' && p.role !== 'turned' && p.role !== 'boss') continue
      const s = p.st(t)
      if (s && upright(p, t)) expect(s.pos.z).toBeLessThan(BZ - 1.2)
    }
  })

  it('runs the horde down the streets, never through a building', () => {
    const town = miniTown(new THREE.Group(), { cols: 3, rows: 2, seed: 11 })
    for (const t of times) for (const p of S.people) {
      if (p.role === 'defender' || p.role === 'fighter' || !upright(p, t)) continue
      const s = p.st(t)!
      for (const b of town.buildings) {
        const bz = b.z - 9
        const r = p.model === 'BigArm' ? 1 : 0.3
        const inside = Math.abs(s.pos.x - b.x) < b.w / 2 + r && Math.abs(s.pos.z - bz) < b.d / 2 + r
        expect(inside, `${p.id} at ${t.toFixed(1)}s is inside the building at ${b.x.toFixed(1)},${bz.toFixed(1)}`).toBe(false)
      }
    }
  })
})
