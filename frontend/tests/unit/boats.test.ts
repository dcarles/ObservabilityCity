import { beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { BoatSystem, type BoatRoute } from '../../src/scene/boats'
import { activateTheme } from '../../src/themes/active'
import { KITS } from '../../src/themes/kits'

const lane = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 30)]
const route = (from: string | null, to: string): BoatRoute => ({ path: lane, from, to, rate: () => 5, speed: () => 1 })

/** The boats on the water, each with the colours of the parts that are not crates. */
function visible(boats: BoatSystem) {
  return boats.object.children.filter((o) => o.visible) as THREE.Group[]
}
function hullColours(boat: THREE.Group): string {
  const cargo = boat.children.find((c) => c.children.length >= 6)
  const colours: string[] = []
  boat.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined
    let inCargo = false
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === cargo) inCargo = true
    if (m?.color && !inCargo) colours.push(m.color.getHexString())
  })
  return colours.join(',')
}

describe.each(Object.keys(KITS))('boats in the %s theme', (id) => {
  beforeAll(() => activateTheme(KITS[id]))
  it('always carry the full load of crates, whatever the traffic', () => {
    const boats = new BoatSystem(4)
    boats.setRoutes([route('aa', 'bb')])
    boats.update(1)
    const out = visible(boats)
    expect(out.length).toBeGreaterThan(0)
    for (const boat of out) {
      const cargo = boat.children.find((c) => c.children.length >= 6)!
      expect(cargo.children.filter((c) => c.visible)).toHaveLength(cargo.children.length)
    }
  })

  it('are painted differently when they loop out of their own island and when they sail to another', () => {
    const between = new BoatSystem(4)
    between.setRoutes([route('aa', 'bb')])
    between.update(1)
    const inside = new BoatSystem(4)
    inside.setRoutes([route('aa', 'aa')])
    inside.update(1)
    expect(visible(between).length).toBeGreaterThan(0)
    expect(visible(inside).length).toBeGreaterThan(0)
    expect(hullColours(visible(inside)[0])).not.toBe(hullColours(visible(between)[0]))
  })

  it('send the boats of a scheduler’s jobs in the loop colour too', () => {
    const sched = new BoatSystem(4)
    sched.setRoutes([{ ...route('aa', 'aa'), scheduler: true }])
    sched.update(1)
    const loop = new BoatSystem(4)
    loop.setRoutes([route('aa', 'aa')])
    loop.update(1)
    expect(hullColours(visible(sched)[0])).toBe(hullColours(visible(loop)[0]))
  })

  it('sail a circuit once, one way, instead of there and back', () => {
    const ring = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 40), new THREE.Vector3(40, 0, 40), new THREE.Vector3(40, 0, 0), new THREE.Vector3(0, 0, 0)]
    const total = 160
    let rate = 100
    const run = (circuit: boolean) => {
      rate = 100
      const boats = new BoatSystem(1)
      boats.setRoutes([{ path: ring, from: 'aa', to: 'aa', circuit, rate: () => rate, speed: () => 1 }])
      boats.update(0.05) // one boat leaves
      rate = 0
      boats.update(((total * 1.15) / 4.4) - 0.05) // longer than one way round, shorter than there and back
      return visible(boats).length
    }
    expect(run(true)).toBe(0) // it has come home and gone
    expect(run(false)).toBe(1) // there and back is still on the water
  })
})
