import { describe, expect, it } from 'vitest'
import { KONAMI, KonamiWatcher, isTyping } from '../../src/events/konami'
import { EVENT_FOR_THEME, eventForTheme } from '../../src/events'
import { KITS } from '../../src/themes/kits'
import { MARGIN, placeBeside } from '../../src/events/placement'
import { Armoury } from '../../src/events/combat'
import { capsule, clamp, clearance, ease, ringPos, rng, seq, V } from '../../src/events/rig'
import { ZLOOP, zombieScript } from '../../src/events/zombieScript'

describe('the Konami code', () => {
  const type = (w: KonamiWatcher, keys: readonly string[]): boolean[] => keys.map((k) => w.push(k))

  it('fires on the last key of up up down down left right left right b a', () => {
    const w = new KonamiWatcher()
    const out = type(w, KONAMI)
    expect(out.slice(0, -1).some(Boolean)).toBe(false)
    expect(out[out.length - 1]).toBe(true)
  })
  it('takes capital letters, and can be typed again straight after', () => {
    const w = new KonamiWatcher()
    expect(type(w, ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'B', 'A']).pop()).toBe(true)
    expect(type(w, KONAMI).pop()).toBe(true)
  })
  it('starts over on a wrong key, and a stray extra Up before the code does not break it', () => {
    const w = new KonamiWatcher()
    type(w, ['ArrowUp', 'ArrowUp', 'ArrowDown', 'x'])
    expect(type(w, KONAMI).pop()).toBe(true)
    const v = new KonamiWatcher()
    expect(type(v, ['ArrowUp', ...KONAMI]).pop()).toBe(true)
  })
  it('does not fire for a partial code', () => {
    const w = new KonamiWatcher()
    expect(type(w, KONAMI.slice(0, 9)).some(Boolean)).toBe(false)
  })
  it('ignores keys typed into a box', () => {
    expect(isTyping({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
    expect(isTyping({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true)
    expect(isTyping({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true)
    expect(isTyping({ tagName: 'CANVAS' } as unknown as EventTarget)).toBe(false)
    expect(isTyping(null)).toBe(false)
  })
})

describe('which event belongs to which theme', () => {
  it('plays pirates in the harbour town, zombies in the factory and aliens in space', () => {
    expect(eventForTheme('harbour-town')).toBe('pirates')
    expect(eventForTheme('factory')).toBe('zombies')
    expect(eventForTheme('space')).toBe('aliens')
  })
  it('has an event for every theme that is drawn, and none for a theme that is not', () => {
    for (const id of Object.keys(KITS)) expect(EVENT_FOR_THEME[id], id).toBeTruthy()
    expect(eventForTheme('nope')).toBeNull()
  })
})

describe('where the event is placed', () => {
  const islands = [
    { x: 0, z: 0, r: 30 },
    { x: 80, z: 0, r: 25 },
    { x: -70, z: 20, r: 28 },
    { x: 10, z: -90, r: 26 },
    { x: 30, z: 80, r: 24 },
  ]
  const centre = { x: 0, z: 0 }

  it('stands in open sea, clear of every island, whichever island is picked', () => {
    for (let k = 0; k < 20; k++) {
      const spot = placeBeside(islands, centre, 38, k / 20)
      for (const o of islands) expect(Math.hypot(o.x - spot.x, o.z - spot.z), `pick ${k / 20}`).toBeGreaterThanOrEqual(o.r + 38 + MARGIN - 1e-6)
    }
  })
  it('puts it beside one of the outermost islands, on the side away from the town, facing out to sea', () => {
    const spot = placeBeside(islands, centre, 30, 0)
    const isl = islands[spot.beside]
    expect(Math.hypot(isl.x, isl.z)).toBeGreaterThan(60)
    expect(Math.hypot(spot.x, spot.z)).toBeGreaterThan(Math.hypot(isl.x, isl.z))
    // +z of the patch points away from the town
    expect(Math.sin(spot.yaw) * spot.x + Math.cos(spot.yaw) * spot.z).toBeGreaterThan(0)
  })
  it('picks different islands for different numbers, and the same one for the same number', () => {
    const seen = new Set<number>()
    for (let k = 0; k < 10; k++) seen.add(placeBeside(islands, centre, 30, k / 10).beside)
    expect(seen.size).toBeGreaterThan(1)
    expect(placeBeside(islands, centre, 30, 0.3)).toEqual(placeBeside(islands, centre, 30, 0.3))
  })
  it('copes with a town of one island, and with none', () => {
    const one = placeBeside([{ x: 0, z: 0, r: 30 }], centre, 30, 0.5)
    expect(Math.hypot(one.x, one.z)).toBeGreaterThanOrEqual(30 + 30 + MARGIN - 1e-6)
    expect(Number.isFinite(placeBeside([], centre, 30, 0.5).x)).toBe(true)
  })
})

describe('the timeline a character follows', () => {
  it('is not there before it starts, then walks from A to B and turns to face the way it goes', () => {
    const st = seq(2, [{ d: 4, from: V(0, 0, 0), to: V(0, 0, 8), clip: 'Walk' }, { d: 2, from: V(0, 0, 8), faceTo: V(8, 0, 8), clip: 'Idle' }])
    expect(st(1)).toBeNull()
    expect(st(4)!.pos.z).toBeCloseTo(4)
    expect(st(4)!.yaw).toBeCloseTo(0)
    expect(st(7)!.yaw).toBeCloseTo(Math.PI / 2)
    expect(st(7)!.clip).toBe('Idle')
  })
  it('gives the same answer for the same time, whatever was asked before', () => {
    const st = seq(0, [{ d: 3, from: V(0, 0, 0), to: V(3, 0, 0), clip: 'Run' }])
    const a = st(1.5)!.pos.clone()
    st(2.9)
    expect(st(1.5)!.pos.equals(a)).toBe(true)
  })
  it('has helpers that stay in range', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    const r = rng(3)
    const a = [r(), r(), r()]
    const r2 = rng(3)
    expect([r2(), r2(), r2()]).toEqual(a)
    expect(ringPos(0, 0, 5, 0.25).x).toBeCloseTo(5)
  })
  it('measures the gap between footprints', () => {
    expect(clearance([{ x: 0, z: 0, r: 1 }], [{ x: 5, z: 0, r: 1 }])).toBeCloseTo(3)
    expect(clearance(capsule(0, 0, 5, 2, Math.PI / 2), [{ x: 0, z: 3, r: 1 }])).toBeCloseTo(1, 1)
  })
})

describe('the shooting', () => {
  const where = () => V(0, 1, 20)
  const gun = (id: string, x: number, from = 0, until = 100) => ({ id, at: V(x, 1.4, 0), from, until, gap: 0.2, range: 40 })

  it('lands the last bullet of a fall at the moment of the fall, and the rest just before', () => {
    const a = new Armoury([gun('a', -3), gun('b', 3)])
    expect(a.kill({ target: 'z', at: 10, hits: 4, where })).toBe(4)
    const hits = a.shots.map((s) => s.hit).sort((x, y) => x - y)
    expect(hits[hits.length - 1]).toBeCloseTo(10)
    expect(hits[0]).toBeGreaterThan(9)
    for (const s of a.shots) expect(s.t).toBeLessThan(s.hit)
  })
  it('never fires a gun faster than it can, even when many fall together', () => {
    const a = new Armoury([gun('a', -3), gun('b', 3)])
    for (let k = 0; k < 6; k++) a.kill({ target: `z${k}`, at: 10 + k * 0.05, hits: 3, where })
    for (let i = 0; i < 2; i++) {
      const list = a.of(i)
      for (let k = 1; k < list.length; k++) expect(list[k].t - list[k - 1].t).toBeGreaterThanOrEqual(0.2 - 1e-9)
    }
  })
  it('does not fire a gun that is not in place, or out of range', () => {
    const a = new Armoury([gun('late', 0, 50), { ...gun('far', 0), range: 5 }])
    expect(a.kill({ target: 'z', at: 10, hits: 2, where })).toBe(0)
    expect(a.shots).toHaveLength(0)
  })
  it('has a volley fire at one target over a period, from every gun in place', () => {
    const a = new Armoury([gun('a', -3), gun('b', 3)])
    a.volley('boss', where, 5, 10, 0.3)
    expect(a.of(0).length).toBeGreaterThan(8)
    expect(a.of(1).length).toBeGreaterThan(8)
    for (const s of a.shots) expect(s.t).toBeGreaterThanOrEqual(5 - 1e-9)
  })
})

describe('the zombie defence, story', () => {
  const S = zombieScript()
  it('pays for every fall with at least three bullets that land by the time it falls', () => {
    for (const f of S.falls) {
      if (!/^zombie-\d+$|-turned$|^(sam|shaun)-opponent-1$|^boss$/.test(f.id)) continue
      const hits = S.armoury.shots.filter((s) => s.target === f.id)
      expect(hits.length, f.id).toBeGreaterThanOrEqual(3)
      expect(Math.max(...hits.map((h) => h.hit)), f.id).toBeLessThanOrEqual(f.at + 1e-6)
    }
  })
  it('has fighters fall and get up as zombies, and a giant come once it is quiet', () => {
    expect(S.people.filter((p) => p.role === 'turned').length).toBe(2)
    for (const p of S.people.filter((p) => p.role === 'turned')) {
      const owner = p.id.replace('-turned', '')
      const fell = S.falls.find((f) => f.id === owner)!
      expect(p.st(fell.at - 0.5)).toBeNull()
      expect(p.st(fell.at + 3.5)).not.toBeNull()
    }
    const lastZombie = Math.max(...S.falls.filter((f) => f.id !== 'boss' && f.id !== 'sam' && f.id !== 'shaun').map((f) => f.at))
    expect(S.bossStart).toBeGreaterThan(lastZombie)
    expect(S.bossFall).toBeLessThan(ZLOOP)
    const volley = S.armoury.shots.filter((s) => s.target === 'boss')
    expect(volley.length).toBeGreaterThan(100)
    expect(new Set(volley.map((s) => s.shooter)).size).toBeGreaterThanOrEqual(6)
  })
})
