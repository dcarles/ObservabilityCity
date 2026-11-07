import { beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { AVOID_GAP, AVOID_STEP, BoatSystem, LANE_SIDE, UNLOAD_STEP, sidestep, type BoatRoute } from '../../src/scene/boats'
import { BOAT_PAINT } from '../../src/themes/boatColours'
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

  it('keep their crates all the way round a circuit, and on a there-and-back lane only on the way out', () => {
    const ring = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 40), new THREE.Vector3(40, 0, 40), new THREE.Vector3(40, 0, 0), new THREE.Vector3(0, 0, 0)]
    const loaded = (circuit: boolean) => {
      let rate = 100
      const boats = new BoatSystem(1)
      boats.setRoutes([{ path: circuit ? ring : lane, from: 'aa', to: 'aa', circuit, rate: () => rate, speed: () => 1 }])
      boats.update(0.05)
      rate = 0
      boats.update(((circuit ? 160 : 60) * 0.75) / 4.4) // three quarters of the way
      const boat = visible(boats)[0]
      return boat.children.find((c) => c.children.length >= 6)!.visible
    }
    expect(loaded(true)).toBe(true)
    expect(loaded(false)).toBe(false)
  })
})

describe('the two boat colours', () => {
  it('are yellow for boats between islands and blue for loops round an island, like the cars', () => {
    expect(BOAT_PAINT.between.body).toBe('#f2c230')
    expect(BOAT_PAINT.internal.body).toBe('#2f6fd0')
  })
})

describe('the sides of a there-and-back lane', () => {
  it('keeps each way to its own side, so a boat going out and one coming back are apart the whole way', () => {
    const path = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 20), new THREE.Vector3(15, 0, 40)]
    const out = sidestep(path, LANE_SIDE)
    const back = sidestep([...path].reverse(), LANE_SIDE).reverse()
    expect(out).toHaveLength(path.length)
    for (let i = 0; i < path.length; i++) {
      expect(out[i].distanceTo(path[i])).toBeCloseTo(LANE_SIDE, 5)
      expect(out[i].distanceTo(back[i])).toBeCloseTo(2 * LANE_SIDE, 5)
    }
  })

  it('puts the boats of a there-and-back lane on different lines out and back', () => {
    let rate = 100
    const boats = new BoatSystem(1)
    boats.setRoutes([{ path: lane, from: 'aa', to: 'bb', rate: () => rate, speed: () => 1 }])
    boats.update(0.05)
    rate = 0
    const side = (secs: number) => { boats.update(secs); return visible(boats)[0].position.x }
    const going = side(30 / 4.4 / 2) // a quarter of the trip
    const coming = side(30 / 4.4) // three quarters of the trip
    expect(Math.abs(going - coming)).toBeGreaterThan(LANE_SIDE)
  })
})

describe('boats that sail between islands meeting each other', () => {
  beforeAll(() => activateTheme(KITS[Object.keys(KITS)[0]]))
  /** A straight lane with a point every few units, as real lanes have, so the way back keeps its own side all along. */
  const at = (...p: [number, number][]) => {
    const [a, b] = p
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4)
    return Array.from({ length: n + 1 }, (_, i) => new THREE.Vector3(a[0] + ((b[0] - a[0]) * i) / n, 0, a[1] + ((b[1] - a[1]) * i) / n))
  }
  const route = (path: THREE.Vector3[], from: string, to: string, speed = 1): BoatRoute => ({ path, from, to, rate: () => on, speed: () => speed })
  let on = 0

  /** Sails one boat on each route from the same moment and reports the closest the first two boats on the water came, and how many seconds it took until none was left. */
  function sail(routes: BoatRoute[], seconds = 40) {
    const boats = new BoatSystem(routes.length)
    boats.setRoutes(routes)
    on = 20 // one boat for each route in the first step
    boats.update(0.05)
    on = 0
    let closest = Infinity
    for (let t = 0; t < seconds; t += 0.05) {
      boats.update(0.05)
      const out = visible(boats)
      if (out.length >= 2) closest = Math.min(closest, out[0].position.distanceTo(out[1].position))
    }
    return { closest, boats }
  }

  it('give way where their lanes cross: the one with the other on its right slows, and they never come within the gap', () => {
    const { closest } = sail([route(at([-30, 0], [30, 0]), 'aa', 'bb'), route(at([0, -30], [0, 30]), 'cc', 'dd')])

    expect(closest).toBeGreaterThan(AVOID_GAP - 0.2)
  })

  it('keep apart when one catches up with the one in front: the one behind slows', () => {
    const { closest } = sail([route(at([10, 0], [90, 0]), 'aa', 'bb', 1), route(at([-30, 0], [90, 0]), 'cc', 'dd', 2)], 15) // before the one in front reaches the end of the lane and turns

    expect(closest).toBeGreaterThan(AVOID_GAP - 0.2)
  })

  it('pass head on with a step to the right each, so they are further apart than their lanes alone', () => {
    const { closest } = sail([route(at([-30, 0], [30, 0]), 'aa', 'bb'), route(at([30, 0], [-30, 0]), 'cc', 'dd')])

    expect(closest).toBeGreaterThan(2 * LANE_SIDE + 0.2)
    expect(AVOID_STEP).toBeGreaterThan(0)
  })

  it('leave the boats of an island\'s own loop alone, whatever sails across them', () => {
    const loop = (): BoatRoute => ({ path: at([-30, 0], [30, 0]), from: 'aa', to: 'aa', rate: () => on, speed: () => 1 })
    const progress = (withOther: boolean) => {
      const boats = new BoatSystem(2)
      boats.setRoutes(withOther ? [loop(), route(at([0, -30], [0, 30]), 'cc', 'dd')] : [loop()])
      on = 20
      boats.update(0.05)
      on = 0
      for (let t = 0; t < 7; t += 0.05) boats.update(0.05)
      return visible(boats).map((b) => b.position.x).filter((x) => Math.abs(x) <= 31)
    }

    expect(progress(true)).toContain(progress(false)[0]) // the same place at the same time as when nothing crossed it
  })

  it('go back to the middle of their lane once clear, and never leave it by more than the step', () => {
    const boats = new BoatSystem(2)
    boats.setRoutes([route(at([-30, 0], [30, 0]), 'aa', 'bb'), route(at([30, 0], [-30, 0]), 'cc', 'dd')])
    on = 20
    boats.update(0.05)
    on = 0
    let widest = 0
    for (let t = 0; t < 30; t += 0.05) {
      boats.update(0.05)
      for (const b of visible(boats)) widest = Math.max(widest, Math.abs(b.position.z))
    }
    expect(widest).toBeLessThanOrEqual(LANE_SIDE + AVOID_STEP + 0.01)
  })
})


describe('a boat at the end of its circuit', () => {
  beforeAll(() => activateTheme(KITS[Object.keys(KITS)[0]]))
  const circuit = (): BoatRoute => ({ path: [0, 5, 10, 15, 20].map((x) => new THREE.Vector3(x, 0, 0)), from: 'aa', to: 'aa', circuit: true, scheduler: true, rate: () => on, speed: () => 1 })
  let on = 0

  it('lies at the quay and hands its crates over one by one before it leaves', () => {
    const boats = new BoatSystem(2)
    boats.setRoutes([circuit()])
    on = 20
    boats.update(0.05)
    on = 0
    const loaded: number[] = []
    let sawBoatAtEnd = false
    for (let t = 0; t < 20; t += 0.05) {
      boats.update(0.05)
      for (const b of visible(boats)) {
        const crates = b.children.find((c) => c.children.length >= 6)!
        const left = crates.children.filter((c) => c.visible).length
        if (b.position.x > 19.9) { sawBoatAtEnd = true; loaded.push(left) }
      }
    }

    expect(sawBoatAtEnd).toBe(true)
    expect(loaded[0]).toBeGreaterThan(0) // arrives loaded
    expect(Math.min(...loaded)).toBe(0) // and every crate is off before it goes
    expect(loaded.every((n, i) => i === 0 || n <= loaded[i - 1])).toBe(true) // they only ever come off
    expect(loaded.length * 0.05).toBeGreaterThan(UNLOAD_STEP * 3) // it stays while they do
    expect(visible(boats)).toHaveLength(0) // then it is gone
  })

  it('makes the boat behind it slow down instead of running into it at the quay', () => {
    const boats = new BoatSystem(4)
    boats.setRoutes([circuit()])
    on = 20
    boats.update(0.05)
    on = 0
    for (let t = 0; t < 3.1; t += 0.05) boats.update(0.05)
    on = 20 // a second boat starts a little behind
    boats.update(0.05)
    on = 0
    let closest = Infinity
    for (let t = 0; t < 12; t += 0.05) {
      boats.update(0.05)
      const v = visible(boats)
      if (v.length >= 2) closest = Math.min(closest, v[0].position.distanceTo(v[1].position))
    }

    expect(closest).toBeGreaterThan(AVOID_GAP - 0.3)
  })
})
