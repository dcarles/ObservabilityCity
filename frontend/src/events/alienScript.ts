// The alien invasion on a real island, worked out as plain data: where the saucers hover, where the aliens land and walk (round the island's own
// buildings, never through one), which buildings they punch and when, where the defenders stand and who shoots at what, and when.

import * as THREE from 'three'
import { Arena, along, middleOf, type Block } from './arena'
import { Armoury, chest, type Shooter } from './combat'
import { settle } from './crowd'
import { clamp, ease, seq, V, type Seg } from './rig'

export const ALOOP = 64
const DEATH = 1.5

export type AlienModel = 'EnemyLarge' | 'EnemyFlying' | 'EnemySmall'
export type DefenderModel = 'AstroA' | 'AstroC' | 'Matt' | 'Sam'

export interface Walker {
  id: string
  model: AlienModel | DefenderModel
  h: number
  role: 'alien' | 'defender'
  weapon?: 'Rifle' | 'Smg'
  st: ReturnType<typeof seq>
  shooters: number[]
}

/** True while the walker is on their feet and in the scene. */
export const standing = (w: Walker, t: number): boolean => {
  const s = w.st(t)
  return !!s && !s.hide && s.clip !== 'Death'
}

export interface Saucer {
  id: string
  hover: THREE.Vector3
  /** When it leaves, and which way (away from the town). */
  leaves: number
  pos: (t: number) => THREE.Vector3
  /** How it is tilted at a time (a hit saucer lists). */
  roll: (t: number) => number
  drop: number
  /** The ground spot its tractor beam lands on. */
  spot: THREE.Vector3
  hit: boolean
}

export interface AlienScript {
  saucers: Saucer[]
  walkers: Walker[]
  armoury: Armoury
  fliers: { id: string; saucer: number; model: AlienModel; phase: number }[]
  falls: { id: string; at: number }[]
  /** The ground spots the saucers drop aliens at. */
  streets: { x: number; z: number }[]
  /** The buildings the aliens punch, and when each is first hit. */
  targets: Block[]
  hit: number[]
  /** Where the mech stands. */
  mech: THREE.Vector3
}


/** The part of a routine that has happened by `tk`: whole segments, and the last one cut short where it has got to. */
function cut(segs: Seg[], start: number, tk: number): { segs: Seg[]; pos: THREE.Vector3 } {
  const out: Seg[] = []
  let t = start
  let pos = segs[0].from ?? V()
  for (const s of segs) {
    if (t + s.d <= tk) {
      out.push(s)
      t += s.d
      pos = (s.to ?? s.from ?? pos).clone()
      continue
    }
    const k = clamp((tk - t) / s.d)
    const part: Seg = { ...s, d: Math.max(0.01, tk - t) }
    if (s.from && s.to) {
      part.to = s.from.clone().lerp(s.to, k)
      pos = part.to.clone()
    }
    out.push(part)
    break
  }
  return { segs: out, pos }
}


export function alienScript(arena: Arena): AlienScript {
  const shooters: Shooter[] = []
  const walkers: Walker[] = []
  const falls: AlienScript['falls'] = []
  const armoury = new Armoury(shooters)
  const C0 = arena.centre
  // the aliens are big: they keep further from the buildings than a person does
  const big = new Arena(arena.src, 1.6)

  // three saucers hover over three of the island's buildings, spread out; each drops its aliens on the clear ground beside its building
  const chosen = arena.spread(3, C0.x, C0.z, 3)
  while (chosen.length < 3) chosen.push(chosen[chosen.length - 1] ?? arena.blocks[0])
  const SPOTS = chosen.map((b, i) => arena.doorOf(b, { x: C0.x, z: C0.z }) ?? arena.nearestClear(C0.x + i * 4, C0.z) ?? V())
  const DROP = [6, 10, 16]
  const LEAVE = [50, 38, 54]
  const away = SPOTS.map((s, i) => {
    const v = V(s.x - C0.x, 0, s.z - C0.z)
    return v.lengthSq() < 1 ? V(Math.sin(i * 2.1), 0, Math.cos(i * 2.1)) : v.normalize()
  })
  const saucers: Saucer[] = SPOTS.map((s, i) => {
    const hover = V(s.x, 13 + i * 1.4, s.z)
    const orbit = (t: number): THREE.Vector3 => V(Math.cos(t * 0.7 + i * 2) * 0.8, Math.sin(t * 0.9 + i) * 0.35, Math.sin(t * 0.7 + i * 2) * 0.8)
    const start = hover.clone().add(away[i].clone().multiplyScalar(-60)).setY(42)
    const pos = (t: number): THREE.Vector3 => {
      if (t < 5) return start.clone().lerp(hover, ease(clamp(t / 5)))
      if (t < LEAVE[i]) return hover.clone().add(orbit(t))
      const k = clamp((t - LEAVE[i]) / 10)
      return hover.clone().add(orbit(LEAVE[i])).add(away[i].clone().multiplyScalar(k * k * 90)).add(V(0, k * k * 30, 0))
    }
    return { id: `saucer-${i}`, hover, leaves: LEAVE[i], pos, roll: (t) => (i === 1 && t > 30 ? Math.min(0.5, (t - 30) * 0.06) * Math.sin(t * 1.5) + (t > 38 ? (t - 38) * 0.4 : 0) : Math.sin(t * 0.7 + i) * 0.08), drop: DROP[i], spot: s, hit: i === 1 }
  })

  // the defenders: astronauts and survivors spread round the island on clear ground, all firing up at the saucers and down at the aliens
  const DEF: { model: DefenderModel; weapon: 'Rifle' | 'Smg' }[] = [
    { model: 'AstroA', weapon: 'Rifle' },
    { model: 'Matt', weapon: 'Smg' },
    { model: 'AstroC', weapon: 'Rifle' },
    { model: 'Sam', weapon: 'Rifle' },
    { model: 'AstroA', weapon: 'Smg' },
    { model: 'Matt', weapon: 'Rifle' },
    { model: 'AstroC', weapon: 'Rifle' },
  ]
  // the mech stands on clear ground on the town side and fires at the saucers
  const mechAt = arena.inland(6, 0, arena.src.seaward + Math.PI) ?? arena.nearestClear(C0.x, C0.z, 1.5) ?? V(C0.x, 0, C0.z)
  const reach = arena.reach
  const taken: THREE.Vector3[] = [...SPOTS, mechAt]
  const defSpots: THREE.Vector3[] = []
  for (let i = 0; i < DEF.length; i++) {
    const ang = arena.src.seaward + Math.PI + (i / DEF.length) * Math.PI * 2
    let p: THREE.Vector3 | null = null
    for (let f = 0.62; f > 0.2 && !p; f -= 0.08) {
      const c = arena.nearestClear(C0.x + Math.sin(ang) * reach * f, C0.z + Math.cos(ang) * reach * f, 0.3)
      if (c && taken.every((o) => o.distanceTo(c) > 4.5)) p = c
    }
    p ??= arena.nearestClear(C0.x + (i - 3) * 3, C0.z + 2, 0.3) ?? V()
    taken.push(p)
    defSpots.push(p)
  }
  const defenderStart = 1
  const defenders: Walker[] = DEF.map((d, i) => {
    const pos = defSpots[i]
    const segs: Seg[] = [
      { d: ALOOP - 8, from: pos, faceTo: V(C0.x, 0, C0.z), clip: 'Idle_Gun' },
      { d: 4, from: pos, clip: 'Wave' },
      { d: 99, from: pos, clip: 'Yes' },
    ]
    const w: Walker = { id: `defender-${i}`, model: d.model, h: d.model === 'Matt' || d.model === 'Sam' ? 2.1 : 2.0, role: 'defender', weapon: d.weapon, st: seq(0, segs), shooters: [] }
    shooters.push({ id: w.id, at: pos.clone().add(V(0, 1.45, 0)), from: defenderStart, until: ALOOP - 8, gap: d.weapon === 'Smg' ? 0.12 : 0.24, range: 160 })
    w.shooters.push(shooters.length - 1)
    return w
  })

  // the aliens: one comes down at the first two spots, two at the third; each walks to the buildings nearest it and punches them
  const ground: { id: string; ship: number; late: number }[] = [
    { id: 'alien-0', ship: 0, late: 0 },
    { id: 'alien-1', ship: 1, late: 0 },
    { id: 'alien-2', ship: 2, late: 0 },
    { id: 'alien-3', ship: 2, late: 0.6 },
  ]
  const KILLS = [27, 33, 41, 46]
  const targets: Block[] = []
  const hit: number[] = []
  const mark = (b: Block, at: number): void => {
    let i = targets.indexOf(b)
    if (i < 0) {
      i = targets.push(b) - 1
      hit[i] = 1e9
    }
    hit[i] = Math.min(hit[i], at)
  }
  interface Plan {
    g: (typeof ground)[number]
    td: number
    top: THREE.Vector3
    land: THREE.Vector3
    stands: { p: THREE.Vector3; block: Block; path: THREE.Vector3[] }[]
  }
  // every alien comes down on a spot of its own, a good way from the others, and the others walk round it
  const lands: THREE.Vector3[] = []
  ground.forEach((g) => {
    const sh = saucers[g.ship]
    lands.push(big.nearestClear(sh.spot.x, sh.spot.z, 0, (x, z) => lands.every((o) => Math.hypot(o.x - x, o.z - z) > 3.2)) ?? sh.spot.clone())
  })
  big.addObstacle(...lands.map((l) => ({ x: l.x, z: l.z, r: 0.9 })))
  const plans: Plan[] = ground.map((g, k) => {
    const sh = saucers[g.ship]
    const land = lands[k]
    const top = V(land.x, sh.hover.y - 1.5, land.z)
    // the buildings nearest the landing, not the one it came down beside twice
    const stands: Plan['stands'] = []
    let cur = land
    const used = new Set<Block>()
    for (let n = 0; n < 3; n++) {
      const b = big.blocksByDistance(cur.x, cur.z).find((x) => !used.has(x))
      if (!b) break
      used.add(b)
      const p = big.doorOf(b, cur, k)
      if (!p) continue
      const path = big.path(cur, p) ?? [cur, p]
      stands.push({ p, block: b, path })
      cur = p
    }
    return { g, td: sh.drop + g.late, top, land, stands }
  })

  const buildAlien = (pl: Plan, delay: number): { st: Walker['st']; punches: { block: Block; at: number }[]; pos: (t: number) => THREE.Vector3 } => {
    const td = pl.td
    const segs: Seg[] = [{ d: 2.4, from: pl.top, to: pl.land, clip: 'Jump_Idle' }]
    if (delay > 0) segs.push({ d: delay, from: pl.land, faceTo: V(C0.x, 0, C0.z), clip: 'Idle' })
    const punches: { block: Block; at: number }[] = []
    let clock = td + 2.4 + delay
    let cur = pl.land
    pl.stands.forEach(({ p, block, path }, n) => {
      const walkSegs = along(path, 1.5, 'Walk', { rate: 1.4 })
      for (const w of walkSegs) {
        segs.push(w)
        clock += w.d
      }
      const dur = 3.5 + n * 0.7
      punches.push({ block, at: clock })
      segs.push({ d: dur, from: p, faceTo: middleOf(block), clip: 'Punch' })
      clock += dur
      cur = p
    })
    segs.push({ d: 30, from: cur, clip: 'Idle' })
    const k = pl.g.id.endsWith('0') ? 0 : Number(pl.g.id.slice(-1))
    const done = cut(segs, td, KILLS[k])
    done.segs.push({ d: DEATH + 1.4, from: done.pos, clip: 'Death', hold: true }, { d: 0.9, from: done.pos, to: done.pos.clone().add(V(0, -1, 0)), clip: 'Death', hold: true }, { d: 999, from: done.pos, clip: 'Death', hide: true })
    const st = seq(td, done.segs)
    return { st, punches: punches.filter((p) => p.at - 0 < KILLS[k]), pos: (t) => st(Math.min(t, KILLS[k] - 0.02))?.pos ?? pl.land }
  }

  // the aliens keep clear of the defenders and of each other: one that would walk into somebody waits a little longer where it landed
  const bodies = [
    ...defenders.map((w) => ({ id: w.id, r: 0.5, fixed: true, make: () => w.st })),
    { id: 'mech', r: 1.5, fixed: true, make: () => seq(0, [{ d: 999, from: mechAt, clip: 'Shoot_Big' }]) },
    ...plans.map((pl) => ({ id: pl.g.id, r: 1.1, make: (d: number) => buildAlien(pl, d).st })),
  ]
  const delays = settle(bodies, ALOOP, { step: 0.5, tries: 40, dt: 0.1 })
  plans.forEach((pl, k) => {
    const delay = delays[defenders.length + 1 + k]
    const a = buildAlien(pl, delay)
    walkers.push({ id: pl.g.id, model: 'EnemyLarge', h: 4.6, role: 'alien', st: a.st, shooters: [] })
    falls.push({ id: pl.g.id, at: KILLS[k] })
    for (const p of a.punches) mark(p.block, p.at)
  })
  walkers.push(...defenders)

  // each fall is paid for with bullets that land just before it; the rest of the time the guns fire up at the saucers
  ground.forEach((g, k) => {
    const w = walkers.find((x) => x.id === g.id)!
    armoury.kill({ target: g.id, at: KILLS[k] - 0.02, hits: 4 + (k % 2), where: (t) => chest(w.st(Math.min(t, KILLS[k] - 0.02))?.pos ?? V(), 2.0) })
  })
  saucers.forEach((s, i) => {
    const only = defenders.map((d, j) => (j % 3 === i ? d.shooters[0] : -1)).filter((x) => x >= 0)
    armoury.volley(s.id, (t) => s.pos(Math.min(t, s.leaves + 3)).clone().add(V(0, -0.6, 0)), 3 + i * 0.4, s.leaves + 3, 0.5, only)
  })

  const fliers: AlienScript['fliers'] = [
    { id: 'flier-0', saucer: 0, model: 'EnemyFlying', phase: 0 },
    { id: 'flier-1', saucer: 1, model: 'EnemySmall', phase: 1.7 },
    { id: 'flier-2', saucer: 2, model: 'EnemyFlying', phase: 3.4 },
    { id: 'flier-3', saucer: 0, model: 'EnemySmall', phase: 5.1 },
  ]
  return { saucers, walkers, armoury, fliers, falls, streets: SPOTS.map((s) => ({ x: s.x, z: s.z })), targets, hit, mech: mechAt }
}
