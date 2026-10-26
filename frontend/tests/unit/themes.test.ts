import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

// The kit's models are glTF files that only a browser loads; the buildings and the traffic of the harbour town use a few of them, so stand in a box.
vi.mock('../../src/assets/kit', () => ({
  loadKit: async () => {},
  kit: () => new (THREE.Group)(),
  kitParts: () => ({ geometry: new THREE.BoxGeometry(1, 1, 2).translate(0, 0.5, 0), material: new THREE.MeshStandardMaterial() }),
}))

import { KITS, kitById } from '../../src/themes/kits'
import { activateTheme, palette } from '../../src/themes/active'
import { harbourPalette } from '../../src/themes/harbour-town/palette'
import { LIGHTING } from '../../src/lighting'
import { DEFAULT_THEME, THEMES, startTheme, themeById } from '../../src/themes'
import { LEGEND } from '../../src/legend'
import { THEME_WORDS, legendFor } from '../../src/legendWords'
import { portSignText } from '../../src/portSign'
import type { NodeKind } from '../../src/types'
import type { ThemeKit } from '../../src/themes/types'

// the same file the backend tests hold to the snapshot contract: what every theme has to draw
const contract = JSON.parse(readFileSync(new URL('../../../shared-test-data/themes/theme-contract.json', import.meta.url), 'utf8')) as {
  themes: string[]
  buildingKinds: NodeKind[]
  healthStates: string[]
  beacons: Record<string, string>
}

// a canvas that takes drawing calls and shows nothing, so signs and clock faces can be built where there is no browser
beforeAll(() => {
  const ctx = new Proxy({}, { get: (_t, key) => (key === 'canvas' ? undefined : () => ({ addColorStop() {} })), set: () => true })
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) })
})

const ids = contract.themes
const harbour = () => kitById('harbour-town')
const build = (kit: ThemeKit, kind: NodeKind) => kit.buildModel(kind, '#3366cc', { name: kind === 'Broker' ? 'Kafka' : undefined })

function meshes(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  o.traverse((c) => { if (c instanceof THREE.Mesh) out.push(c) })
  return out
}

describe('the theme list', () => {
  it('offers exactly the themes the contract names, the harbour town first and by default', () => {
    expect(THEMES.map((t) => t.id)).toEqual(ids)
    expect(DEFAULT_THEME).toBe('harbour-town')
    expect(Object.keys(KITS)).toEqual(ids)
  })

  it('gives each theme a name and a line for the picker', () => {
    for (const t of THEMES) { expect(t.name.trim()).not.toBe(''); expect(t.blurb.trim()).not.toBe('') }
    expect(THEMES.map((t) => t.name)).toEqual(['Harbour town', 'Space colony', 'Works'])
  })

  it('opens with the theme the address names, else the one this browser last chose, else the default', () => {
    const store = (v?: string) => ({ getItem: () => v ?? null, setItem: () => {} })
    expect(startTheme('?theme=space', store()).theme.id).toBe('space')
    expect(startTheme('?theme=factory', store('space')).theme.id).toBe('factory')
    expect(startTheme('', store('space')).theme.id).toBe('space')
    expect(startTheme('', store()).theme.id).toBe('harbour-town')
    expect(startTheme('?theme=castle', store('space'))).toEqual({ theme: themeById('space'), unknown: 'castle' })
  })

  it('falls back to the harbour town for a kit it does not have', () => {
    expect(kitById('nope').id).toBe('harbour-town')
  })
})

describe.each(ids)('the %s theme', (id) => {
  const kit = kitById(id)

  it('has a kit of its own id', () => {
    expect(kit.id).toBe(id)
  })

  it('sets every colour the harbour town sets, and no others', () => {
    const shape = (o: unknown): unknown => (Array.isArray(o) ? 'list' : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)])) : typeof o)
    expect(shape(kit.palette)).toEqual(shape(harbourPalette))
    const colours = JSON.stringify(kit.palette).match(/"#[0-9a-fA-F]{6}"/g) ?? []
    expect(colours.length).toBeGreaterThan(50)
  })

  it('keeps the four beacon colours of the contract, so a light means the same in every theme', () => {
    expect(kit.palette.beacon).toMatchObject(contract.beacons)
  })

  it('keeps every beacon, and the red of a failure, clear of the ground it stands on', () => {
    const dist = (a: string, b: string) => {
      const x = new THREE.Color(a), y = new THREE.Color(b)
      return Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b)
    }
    for (const ground of [kit.palette.island.grass, kit.palette.island.lawn, kit.palette.island.pavement, kit.palette.island.plot, kit.palette.island.road])
      for (const beacon of [kit.palette.beacon.green, kit.palette.beacon.amber, kit.palette.beacon.red]) expect(dist(ground, beacon)).toBeGreaterThan(0.2)
  })

  it('has a Day and a Dusk, Dusk with the brighter windows, and the first sky of the stage matching Day', () => {
    expect(Object.keys(kit.lighting).sort()).toEqual(['day', 'dusk'])
    expect(kit.lighting.dusk.windowGlow).toBeGreaterThan(kit.lighting.day.windowGlow - 0.001)
    expect(kit.lighting.day.sky).toEqual(kit.palette.sky)
    expect(kit.lighting.day.fog).toBe(kit.palette.fog)
    for (const l of Object.values(kit.lighting)) {
      expect(l.sun.intensity).toBeGreaterThan(1)
      expect(l.hemisphere.intensity).toBeGreaterThan(0.8)
      expect(l.exposure).toBeGreaterThan(0.9)
    }
  })

  it.each(contract.buildingKinds)('draws a %s that the town can place, light, and read', (kind) => {
    const m = build(kit, kind)
    const h = build(harbour(), kind)
    // the layout was made for the harbour town's footprints, the doors face the same way and the cars and walkers meet them at the same places
    expect(m.radius).toBeGreaterThan(h.radius * 0.85)
    expect(m.radius).toBeLessThan(h.radius * 1.15)
    expect(m.doorDir.toArray()).toEqual(h.doorDir.toArray())
    expect(m.door.distanceTo(h.door)).toBeLessThan(0.5)
    expect(Math.abs(m.plaque.position.x - h.plaque.position.x)).toBeLessThan(0.5)
    expect(m.plaque.width).toBeGreaterThan(0)
    // floors stack the way instances do, and each has its own windows to light and darken
    expect(m.floorHeight).toBeGreaterThan(0.5)
    expect(m.baseHeight).toBeGreaterThan(0.3)
    expect(m.fixedFloors).toBe(h.fixedFloors)
    const f = m.makeFloor(0)
    expect(Object.keys(f.uniforms).sort()).toEqual(['uDark', 'uLit', 'uSeed', 'uStale'])
    expect(meshes(f.object).length).toBeGreaterThan(0)
    // a roof to stand on and a beacon above the floors: not under the roof, not off in space
    expect(meshes(m.base).length).toBeGreaterThan(2)
    expect(meshes(m.roof).length).toBeGreaterThan(0)
    expect(m.beaconAt.y).toBeGreaterThan(0)
    expect(Math.abs(m.beaconAt.x)).toBeLessThan(m.radius * 2)
    expect(Math.abs(m.beaconAt.z)).toBeLessThan(m.radius * 2)
    // nothing is invented in the numbers
    for (const mesh of [...meshes(m.base), ...meshes(m.roof)]) {
      mesh.geometry.computeBoundingBox()
      expect(Number.isFinite(mesh.geometry.boundingBox!.max.y)).toBe(true)
    }
  })

  it('writes the broker\'s own name on the port, so a town on Kafka does not read Service Bus', () => {
    expect(build(kit, 'Broker').signText).toBe(portSignText('Kafka'))
    expect(kit.buildModel('Broker', '#fff', {}).signText).toBe('SERVICE BUS')
  })

  it('stands a data store with a database for each tenant as a yard, and shows its tenants', () => {
    const yard = kit.buildModel('Database', '#fff', { tenanted: true })
    expect(typeof yard.setTenants).toBe('function')
    expect(typeof yard.tenantStatus).toBe('function')
  })

  it('smokes, spins or swings: the animated buildings keep moving', () => {
    for (const kind of ['Worker', 'Cron', 'Broker', 'Egress'] as const) expect(typeof build(kit, kind).animate).toBe('function')
    expect(typeof build(kit, 'Worker').setActivity).toBe('function')
  })

  it('has two cars with their front along +z, standing on the road and about as long as they are wide', () => {
    const [own, outside] = kit.vehicles.cars()
    for (const car of [own, outside]) {
      car.geometry.computeBoundingBox()
      const size = car.geometry.boundingBox!.getSize(new THREE.Vector3())
      expect(size.z).toBeGreaterThanOrEqual(size.x * 0.9)
      expect(car.geometry.boundingBox!.min.y).toBeGreaterThan(-0.05)
      expect(size.y).toBeLessThan(size.z)
    }
  })

  it('has boats that carry up to six crates, bow along +z, riding above the water by what it says', () => {
    const boat = kit.vehicles.boat(0)
    expect(boat.cargo.children.length).toBeGreaterThanOrEqual(6)
    expect(boat.object.children).toContain(boat.cargo)
    const box = new THREE.Box3().setFromObject(boat.object)
    const size = box.getSize(new THREE.Vector3())
    expect(size.z).toBeGreaterThan(size.x)
    expect(kit.vehicles.boatLift).toBeGreaterThanOrEqual(0)
    expect(kit.vehicles.boatBob).toBeGreaterThan(0)
    // the boats are drawn at 0.7 scale and the lane is about this wide: a boat must not be bigger than the lane
    expect(size.x * 0.7).toBeLessThan(3.2)
  })

  it('has a pier that runs out along +z for as long as it is asked', () => {
    const pier = kit.pier(10)
    const size = new THREE.Box3().setFromObject(pier).getSize(new THREE.Vector3())
    expect(size.z).toBeGreaterThan(9)
    expect(size.x).toBeGreaterThan(2.5)
    expect(size.x).toBeLessThan(5)
  })
})

describe.each(ids.filter((i) => i !== 'harbour-town'))('the bridge of the %s theme', (id) => {
  const kit = kitById(id)

  it('dresses a deck as wide as the road and as long as it is asked, with gates at both ends unless it is a causeway piece', () => {
    for (const len of [12, 40]) {
      const deck = new THREE.Group()
      kit.bridge.dress(deck, len, 6.2, true)
      const size = new THREE.Box3().setFromObject(deck).getSize(new THREE.Vector3())
      expect(size.z).toBeGreaterThanOrEqual(len - 0.01)
      expect(size.z).toBeLessThan(len + 3)
      expect(size.x).toBeGreaterThanOrEqual(6.2 - 0.01)
      expect(size.x).toBeLessThan(8)
    }
    const withEnds = new THREE.Group(), without = new THREE.Group()
    kit.bridge.dress(withEnds, 30, 6.2, true)
    kit.bridge.dress(without, 30, 6.2, false)
    expect(meshes(withEnds).length).toBeGreaterThan(meshes(without).length)
  })

  it('does not put anything where the cars drive: the road is clear of rails', () => {
    const deck = new THREE.Group()
    kit.bridge.dress(deck, 30, 6.2, true)
    // nothing taller than a kerb stands in the middle of the road, 2.1 metres either side of the centre line
    for (const m of meshes(deck)) {
      const b = new THREE.Box3().setFromObject(m)
      if (b.max.x < 2.1 && b.min.x > -2.1) expect(b.max.y).toBeLessThan(1.4)
    }
  })
})

describe('switching theme', () => {
  it('changes the colours in place, so what was imported before still sees them, and changes back', () => {
    const building = palette.building
    const lighting = LIGHTING.day
    activateTheme(kitById('space'))
    expect(palette.island.grass).toBe(KITS.space.palette.island.grass)
    expect(palette.building).toBe(building)
    expect(palette.building.workerBody).toBe(KITS.space.palette.building.workerBody)
    expect(LIGHTING.day).toBe(lighting)
    expect(LIGHTING.dusk.sky.top).toBe(KITS.space.lighting.dusk.sky.top)
    activateTheme(kitById('factory'))
    expect(palette.sea.deep).toBe(KITS.factory.palette.sea.deep)
    activateTheme(kitById('harbour-town'))
    expect(palette).toEqual(harbourPalette)
    expect(LIGHTING.day.sky.top).toBe('#5eb8f2')
  })

  it('does not let a theme change another theme\'s colours', () => {
    const before = JSON.stringify(KITS.space.palette)
    activateTheme(kitById('space'))
    palette.island.grass = '#000000'
    palette.tree.leaves.push('#123456')
    expect(JSON.stringify(KITS.space.palette)).toBe(before)
    activateTheme(kitById('harbour-town'))
  })
})

describe('the legend in each theme', () => {
  it('is the legend itself for the harbour town', () => {
    expect(legendFor('harbour-town')).toBe(LEGEND)
    expect(legendFor('no-such-theme')).toBe(LEGEND)
  })

  it.each(ids.filter((i) => i !== 'harbour-town'))('keeps every section, entry, tone and meaning of the legend in the %s theme but says what that theme draws', (id) => {
    const words = legendFor(id)
    expect(words.map((s) => s.id)).toEqual(LEGEND.map((s) => s.id))
    words.forEach((s, i) => {
      expect(s.entries.map((e) => e.id)).toEqual(LEGEND[i].entries.map((e) => e.id))
      expect(s.entries.map((e) => e.tone)).toEqual(LEGEND[i].entries.map((e) => e.tone))
      for (const e of s.entries) { expect(e.sees.trim()).not.toBe(''); expect(e.means.trim()).not.toBe('') }
    })
    // the words name things this theme draws: no boats or piers left over where it has shuttles or barges
    const ownWords = Object.values(THEME_WORDS[id]).map((w) => `${w.sees ?? ''} ${w.means ?? ''}`).join(' ').toLowerCase()
    expect(ownWords).not.toMatch(/\b(pier|harbour|water tower|clock tower)\b/)
  })

  it('only renames entries that exist, and renames the things the theme draws differently', () => {
    const entryIds = LEGEND.flatMap((s) => s.entries.map((e) => e.id))
    for (const id of ids.filter((i) => i !== 'harbour-town')) {
      expect(Object.keys(THEME_WORDS[id]).filter((k) => !entryIds.includes(k))).toEqual([])
      for (const k of ['api', 'worker', 'database', 'cache', 'cron', 'car', 'taxi', 'bridge', 'boat', 'crates']) expect(THEME_WORDS[id][k]?.sees, `${id} ${k}`).toBeTruthy()
    }
  })

  it('never changes what a colour means: red words stay the failure entries', () => {
    for (const id of ids) {
      const red = legendFor(id).flatMap((s) => s.entries).filter((e) => e.tone === 'red').map((e) => e.id).sort()
      expect(red).toEqual(['beacon-red', 'flag', 'pen'])
    }
  })
})
