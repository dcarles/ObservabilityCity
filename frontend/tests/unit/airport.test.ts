import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

// The kit's models are glTF files that only a browser loads; the roads and lamps of the airport use a few of them, so stand in a box.
vi.mock('../../src/assets/kit', () => ({
  loadKit: async () => {},
  kit: () => new (THREE.Group)(),
  kitParts: () => ({ geometry: new THREE.BoxGeometry(1, 1, 2).translate(0, 0.5, 0), material: new THREE.MeshStandardMaterial() }),
}))

import { Airport } from '../../src/scene/airport'
import { kitById } from '../../src/themes/kits'
import { activateTheme } from '../../src/themes/active'
import { harbourAirport } from '../../src/themes/harbour-town/airport'
import { factoryAirport } from '../../src/themes/factory/airport'
import { spaceAirport } from '../../src/themes/space/airport'
import type { AirportKit } from '../../src/themes/types'

// a canvas that takes drawing calls and shows nothing, so the arrivals board can be built where there is no browser
beforeAll(() => {
  const ctx = new Proxy({}, { get: (_t, key) => (key === 'canvas' ? undefined : () => ({ addColorStop() {} })), set: () => true })
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) })
})

const SITE = { runwayZ: -9, runwayHalf: 31, terminalZ: 0.5, apronZ: 8, gateZ: 17 }
const themes: [string, AirportKit][] = [['harbour-town', harbourAirport], ['factory', factoryAirport], ['space', spaceAirport]]
const box = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o)
const callers = [{ name: 'Partner', requestsPerSecond: 40 }] as any

describe('each theme has its own airport', () => {
  it('is wired into the theme kits', () => {
    for (const [id, airport] of themes) expect(kitById(id).airport).toBe(airport)
  })

  it('shows a plane in the harbour town, a cargo plane in the works and a flying saucer in the colony', () => {
    expect(themes.map(([, a]) => a.look)).toEqual(['airliner', 'cargo plane', 'saucer'])
  })

  it('lands planes on a runway and drops saucers on pads that are clear of each other', () => {
    expect(harbourAirport.landing).toEqual({ kind: 'runway' })
    expect(factoryAirport.landing).toEqual({ kind: 'runway' })
    const landing = spaceAirport.landing
    expect(landing.kind).toBe('pads')
    if (landing.kind !== 'pads') return
    expect(landing.x.length).toBeGreaterThanOrEqual(4) // as many pads as ships that can be in the sky at once
    const sorted = [...landing.x].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThan(8)
    for (const x of landing.x) expect(Math.abs(x)).toBeLessThan(SITE.runwayHalf)
  })

  it.each(themes)('%s: dresses the island and says what to keep clear', (_id, airport) => {
    const decor = new THREE.Group()
    const look = airport.dress(decor, SITE)
    expect(decor.children.length).toBeGreaterThan(10)
    expect(look.avoid.length).toBeGreaterThanOrEqual(3)
    // the gate road and the terminal front stay free of trees in every theme
    expect(look.avoid.some((r) => r.z === SITE.terminalZ)).toBe(true)
    expect(() => look.tick?.(1.5)).not.toThrow()
  })

  it.each(themes)('%s: builds a craft that is an aircraft-sized, with an airline colour and fresh materials each time', (_id, airport) => {
    const a = airport.craft(), b = airport.craft()
    const size = box(a).getSize(new THREE.Vector3())
    expect(Math.max(size.x, size.z)).toBeGreaterThan(6)
    expect(Math.max(size.x, size.z)).toBeLessThan(22)
    const tail = (o: THREE.Object3D) => { const out: THREE.Mesh[] = []; o.traverse((c) => { if (c.userData.tail) out.push(c as THREE.Mesh) }); return out }
    expect(tail(a).length).toBeGreaterThan(0)
    // painting one craft's tail must not repaint another's
    ;(tail(a)[0].material as THREE.MeshLambertMaterial).color.set('#123456')
    expect((tail(b)[0].material as THREE.MeshLambertMaterial).color.getHexString()).not.toBe('123456')
  })

  it('gives only the saucer a beam, shown while it hovers', () => {
    const beams = (o: THREE.Object3D) => { const out: THREE.Object3D[] = []; o.traverse((c) => { if (c.userData.beam) out.push(c) }); return out }
    expect(beams(harbourAirport.craft())).toHaveLength(0)
    expect(beams(factoryAirport.craft())).toHaveLength(0)
    const [beam] = beams(spaceAirport.craft())
    expect(beam.visible).toBe(false)
  })
})

describe('arrivals', () => {
  const fly = (id: string, seconds: number) => {
    activateTheme(kitById(id))
    const airport = new Airport()
    airport.setCallers(callers)
    const camera = new THREE.PerspectiveCamera()
    for (let t = 0; t < seconds; t += 0.1) airport.update(0.1, t, camera)
    return { airport }
  }

  it.each(themes)('%s: planes or ships arrive, land and leave, at the same rate in every theme', (id, airport) => {
    const { airport: a } = fly(id, 120)
    const s = a.status()
    expect(s.look).toBe(airport.look)
    expect(s.landed).toBeGreaterThan(0)
    expect(s.planes).toBeLessThanOrEqual(4)
    expect(s.board[0]).toContain('ARRIVALS')
  })

  it('arrives at the measured outside traffic when the server gives one, and the board shows the total alone', () => {
    activateTheme(kitById('harbour-town'))
    const airport = new Airport()

    airport.setCallers(callers, 7.5)

    expect(airport.status().requestsPerSecond).toBe(7.5)
    expect(airport.status().board).toHaveLength(1)
    airport.setCallers(callers, null)
    expect(airport.status().requestsPerSecond).toBe(40)
    expect(airport.status().board.length).toBeGreaterThan(1)
  })

  it('arrives at the same rate whatever the theme', () => {
    const landed = themes.map(([id]) => fly(id, 120).airport.status().landed)
    expect(new Set(landed).size).toBe(1)
  })

  it('drops saucers onto the pads and keeps them off the runway line between pads', () => {
    activateTheme(kitById('space'))
    const airport = new Airport()
    airport.setCallers(callers)
    const camera = new THREE.PerspectiveCamera()
    const pads = (spaceAirport.landing as { x: number[] }).x
    let parked = 0
    for (let t = 0; t < 60; t += 0.1) {
      airport.update(0.1, t, camera)
      for (const m of airport.root.children) {
        if (!(m instanceof THREE.Group) || !m.visible || m.children.length < 5) continue
        const hovering = m.position.y < 4 && m.position.y > 0 && m.scale.x === 1 && Math.abs(m.position.z + 9) < 0.01
        if (!hovering) continue
        // a ship that is down sits over a pad
        if (pads.some((x) => Math.abs(m.position.x - x) < 0.01)) parked++
      }
    }
    expect(parked).toBeGreaterThan(0)
  })
})

describe('the airport\'s back gate', () => {
  it('is there only when asked for, and the side road from it stays on the island and ends on the front road', () => {
    activateTheme(kitById('harbour-town'))
    expect(new Airport().backGate()).toBeNull()
    expect(new Airport().backPath()).toEqual([])

    const a = new Airport(true)
    const path = a.backPath()
    expect(a.backGateZ).toBeLessThan(0) // on the side away from the hub
    expect(path.length).toBeGreaterThanOrEqual(4)
    expect(path[0].z).toBeCloseTo(a.backGateZ!, 6)
    expect(path[path.length - 1].x).toBeCloseTo(0, 6) // it joins the front road, which leads on to the hub bridge
    // every corner of the road lies inside the island's coast
    for (const p of path) expect([p.x, p.z, a.outline.contains(p.x, p.z, 0.5)]).toEqual([p.x, p.z, true])
  })
})
