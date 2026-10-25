import { describe, expect, it } from 'vitest'
import { DEFAULT_RING_CAPACITY, layoutTown, maxPillars, wrapAngle, type IslandSize, type TownLayout } from '../../src/scene/layout'

/** The airport's size, as the scene draws it. */
export const AIRPORT: IslandSize = { rx: 40, rz: 22 }

/** Points on an island's coast, treating it as an ellipse turned to face the hub. */
function coast(l: TownLayout, s: IslandSize[], i: number, grow = 0): { x: number; z: number }[] {
  const p = l.islands[i]
  const cx = Math.sin(p.angle) * p.radius, cz = -Math.cos(p.angle) * p.radius
  const yaw = Math.atan2(-cx, -cz)
  return Array.from({ length: 48 }, (_, k) => {
    const t = (k / 48) * Math.PI * 2
    const lx = (s[i].rx + grow) * Math.cos(t), lz = (s[i].rz + grow) * Math.sin(t)
    return { x: cx + lx * Math.cos(yaw) + lz * Math.sin(yaw), z: cz - lx * Math.sin(yaw) + lz * Math.cos(yaw) }
  })
}

function inside(l: TownLayout, s: IslandSize[], i: number, pt: { x: number; z: number }, grow = 0): boolean {
  const p = l.islands[i]
  const cx = Math.sin(p.angle) * p.radius, cz = -Math.cos(p.angle) * p.radius
  const yaw = Math.atan2(-cx, -cz)
  const dx = pt.x - cx, dz = pt.z - cz
  const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw)
  const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw)
  return (lx / (s[i].rx + grow)) ** 2 + (lz / (s[i].rz + grow)) ** 2 < 1
}

/** The rules every layout must keep, whatever the island sizes: no island touches another or the hub, bridges stay clear, spokes have room. */
export function layoutInvariants(name: string, pillars: IslandSize[], capacity = DEFAULT_RING_CAPACITY): void {
  const tl = layoutTown(pillars, capacity, AIRPORT)
  // the airport is an island like the others as far as room and bridges go
  const l: TownLayout = { ...tl, islands: [...tl.islands, tl.airport!] }
  const s = [...pillars, AIRPORT]
  const n = s.length
  describe(name, () => {

    it('puts at most `capacity` islands in the first ring and the rest in a second ring further out', () => {
      expect(l.islands.filter((i) => i.ring === 1)).toHaveLength(Math.min(pillars.length, capacity))
      const r1 = Math.max(...l.islands.filter((i) => i.ring === 1).map((i) => i.radius))
      for (const i of l.islands.filter((x) => x.ring === 2)) expect(i.radius).toBeGreaterThan(r1)
    })

    it('puts the airport due north in the second ring, in a place no island takes', () => {
      expect(tl.airport!.angle).toBe(0)
      expect(tl.airport!.ring).toBe(2)
      for (const i of tl.islands) expect(Math.abs(wrapAngle(i.angle))).toBeGreaterThan(1e-6)
      expect(pillars.length).toBeLessThanOrEqual(maxPillars(capacity))
    })

    it('keeps every island clear of every other, with open sea between', () => {
      for (let a = 0; a < n; a++)
        for (let b = a + 1; b < n; b++)
          expect(coast(l, s, a).some((pt) => inside(l, s, b, pt, 6)), `islands ${a} and ${b} touch`).toBe(false)
    })

    it('keeps every island off the hub', () => {
      for (let a = 0; a < n; a++)
        for (const pt of coast(l, s, a)) expect(Math.hypot(pt.x, pt.z)).toBeGreaterThan(l.hub.rx + 12)
    })

    it('lets every bridge reach its island without crossing another island', () => {
      for (let a = 0; a < n; a++) {
        const p = l.islands[a]
        for (let b = 0; b < n; b++) {
          if (a === b) continue
          // walk the straight road from the hub's coast to the island's gate
          for (let t = 0; t <= 1; t += 0.01) {
            const r = l.hub.rx + (p.radius - s[a].rz - l.hub.rx) * t
            const pt = { x: Math.sin(p.angle) * r, z: -Math.cos(p.angle) * r }
            expect(inside(l, s, b, pt, 5), `bridge to island ${a} crosses island ${b}`).toBe(false)
          }
        }
      }
    })

    it('leaves room between the spoke roads where they meet the hub', () => {
      const ports = l.islands.map((i) => i.portAngle).sort((x, y) => x - y)
      for (let k = 0; k < ports.length && ports.length > 1; k++) {
        const gap = Math.abs(wrapAngle(ports[(k + 1) % ports.length] - ports[k]))
        expect(gap * l.hub.rx * 0.9).toBeGreaterThan(8)
      }
    })

    it('keeps spokes away from the hub buildings on the four axes', () => {
      for (const i of l.islands)
        for (const axis of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
          const lateral = Math.abs(Math.sin(wrapAngle(i.portAngle - axis))) * l.hub.buildingR
          expect(Math.abs(wrapAngle(i.portAngle - axis)) > 1.2 || lateral >= 8.5).toBe(true)
        }
    })

  })
}
