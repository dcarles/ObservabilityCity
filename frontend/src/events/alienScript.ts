// The alien invasion, worked out as plain data: where the saucers hover, where the aliens land and walk (along the streets, never through a
// building), where the defenders stand and who shoots at what, and when.

import * as THREE from 'three'
import { Armoury, chest, type Shooter } from './combat'
import { clamp, ease, seq, V, type Seg } from './rig'

export const ALOOP = 64
const DEATH = 1.5

export interface Block {
  x: number
  z: number
  w: number
  d: number
}

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
  /** The ring road the defenders stand on, and the street spots the saucers drop aliens at. */
  streets: { x: number; z: number }[]
}

const at = (x: number, z: number): THREE.Vector3 => V(x, 0, z)
const walk = (from: THREE.Vector3, to: THREE.Vector3, speed: number): Seg => ({ d: Math.max(0.01, from.distanceTo(to) / speed), from, to, clip: 'Walk', rate: 1.4 })

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

export function alienScript(blocks: readonly Block[]): AlienScript {
  const shooters: Shooter[] = []
  const walkers: Walker[] = []
  const falls: AlienScript['falls'] = []
  const armoury = new Armoury(shooters)

  // three saucers hover over three street spots
  const SPOTS = [at(-5.5, 0), at(5.5, 0), at(0, 0)]
  const DROP = [6, 10, 16]
  const LEAVE = [50, 38, 54]
  const away = [V(-1, 0, 0.4).normalize(), V(1, 0, -0.5).normalize(), V(0.2, 0, -1).normalize()]
  const saucers: Saucer[] = SPOTS.map((s, i) => {
    const hover = V(s.x, 13 + i * 1.4, s.z + (i === 2 ? 0 : 0))
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

  // the aliens: one comes down at the first two spots, two at the third; each walks along its street punching the buildings beside it
  const ground: { id: string; spot: THREE.Vector3; ship: number; street: 'v' | 'h'; dir: number; lateOnTop: number }[] = [
    { id: 'alien-0', spot: SPOTS[0], ship: 0, street: 'v', dir: -1, lateOnTop: 0 },
    { id: 'alien-1', spot: SPOTS[1], ship: 1, street: 'v', dir: 1, lateOnTop: 0 },
    { id: 'alien-2', spot: V(-1.4, 0, 0), ship: 2, street: 'h', dir: -1, lateOnTop: 0 },
    { id: 'alien-3', spot: V(1.4, 0, 0), ship: 2, street: 'h', dir: 1, lateOnTop: 0.6 },
  ]
  const KILLS = [27, 33, 41, 46]
  const stands = (g: (typeof ground)[number]): { p: THREE.Vector3; face: THREE.Vector3 }[] => {
    const out: { p: THREE.Vector3; face: THREE.Vector3; key: number }[] = []
    for (const b of blocks) {
      if (g.street === 'v') {
        const sx = g.spot.x
        if (Math.abs(b.x - sx) < 5 && Math.abs(b.z) > 1.8 && Math.sign(b.z) === g.dir) out.push({ p: at(sx, b.z), face: at(b.x, b.z), key: Math.abs(b.z) })
      } else if (Math.abs(b.z) < 5.2 && Math.abs(b.x) < 3.6 && Math.sign(b.x - g.spot.x) === g.dir) out.push({ p: at(clamp(b.x, -3.2, 3.2), 0), face: at(b.x, b.z), key: Math.abs(b.x - g.spot.x) })
    }
    return out.sort((a, b) => a.key - b.key).map((o) => ({ p: o.p, face: o.face }))
  }
  ground.forEach((g, k) => {
    const sh = saucers[g.ship]
    const td = sh.drop + g.lateOnTop
    const land = g.spot.clone()
    const top = V(land.x, sh.hover.y - 1.5, land.z)
    const segs: Seg[] = [{ d: 2.4, from: top, to: land, clip: 'Jump_Idle' }]
    const st = stands(g)
    let cur = land
    for (let n = 0; n < 3 && n < st.length; n++) {
      const { p, face } = st[n]
      segs.push(walk(cur, p, 1.5), { d: 3.5 + n * 0.7, from: p, faceTo: face, clip: 'Punch' })
      cur = p
    }
    segs.push({ d: 30, from: cur, clip: 'Idle' })
    const tk = KILLS[k]
    const done = cut(segs, td, tk)
    done.segs.push({ d: DEATH + 1.4, from: done.pos, clip: 'Death', hold: true }, { d: 0.9, from: done.pos, to: done.pos.clone().add(V(0, -1, 0)), clip: 'Death', hold: true }, { d: 999, from: done.pos, clip: 'Death', hide: true })
    walkers.push({ id: g.id, model: 'EnemyLarge', h: 4.6, role: 'alien', st: seq(td, done.segs), shooters: [] })
    falls.push({ id: g.id, at: tk })
  })

  // the defenders stand on the road along the south edge: astronauts and survivors, all firing up at the saucers and down at the aliens
  const DEF: { model: DefenderModel; x: number; weapon: 'Rifle' | 'Smg' }[] = [
    { model: 'AstroA', x: -15, weapon: 'Rifle' },
    { model: 'Matt', x: -10, weapon: 'Smg' },
    { model: 'AstroC', x: -5, weapon: 'Rifle' },
    { model: 'Sam', x: 0, weapon: 'Rifle' },
    { model: 'AstroA', x: 5, weapon: 'Smg' },
    { model: 'Matt', x: 10, weapon: 'Rifle' },
    { model: 'AstroC', x: 15, weapon: 'Rifle' },
  ]
  const ROAD_Z = 14
  const defenderStart = 1
  const defenders: Walker[] = DEF.map((d, i) => {
    const pos = at(d.x, ROAD_Z + (i % 2) * 0.5)
    const segs: Seg[] = [
      { d: ALOOP - 8, from: pos, faceTo: at(d.x, 0), clip: 'Idle_Gun' },
      { d: 4, from: pos, clip: 'Wave' },
      { d: 99, from: pos, clip: 'Yes' },
    ]
    const w: Walker = { id: `defender-${i}`, model: d.model, h: d.model === 'Matt' || d.model === 'Sam' ? 2.1 : 2.0, role: 'defender', weapon: d.weapon, st: seq(0, segs), shooters: [] }
    shooters.push({ id: w.id, at: pos.clone().add(V(0, 1.45, 0)), from: defenderStart, until: ALOOP - 8, gap: d.weapon === 'Smg' ? 0.12 : 0.24, range: 40 })
    w.shooters.push(shooters.length - 1)
    return w
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
  return { saucers, walkers, armoury, fliers, falls, streets: SPOTS.map((s) => ({ x: s.x, z: s.z })) }
}
