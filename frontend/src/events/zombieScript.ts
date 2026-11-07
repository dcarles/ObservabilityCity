// The zombie defence, worked out as plain data before anything is drawn: where each prop stands, where each person is at each moment, and who
// shoots whom. Keeping it apart from the drawing is what lets a test prove, for every moment, that nothing stands on anything else.

import * as THREE from 'three'
import { Armoury, chest, type Shooter } from './combat'
import { capsule, clamp, ease, lerp, rng, seq, V, type Disc, type Seg } from './rig'

export const ZLOOP = 90
/** The barricade runs across the map at this z; the town and the horde are at smaller z, the defenders at larger z. */
export const BZ = 12

export type Model = 'ZombieGreen' | 'BigArm' | 'Matt' | 'Sam' | 'Shaun' | 'Lis'
export type Weapon = 'Rifle' | 'Smg' | 'Shotgun' | 'Pistol' | 'Axe' | 'Spear'
export type PropKind = 'ContainerRed' | 'ContainerGreen' | 'TBarrier' | 'Barrier' | 'Wheels' | 'Couch' | 'Barrel' | 'WaterTower'

export interface Prop {
  kind: PropKind
  x: number
  z: number
  yaw: number
  scale: number
  height?: number
  discs: Disc[]
  /** A burning barrel. */
  fire?: boolean
}

export interface Person {
  id: string
  model: Model
  /** How tall it stands, in world units. */
  h: number
  weapon?: Weapon
  role: 'horde' | 'turned' | 'boss' | 'fighter' | 'defender'
  st: ReturnType<typeof seq>
  /** The shooter this person is while in place (an index into the armoury), if it shoots. */
  shooters: number[]
}

/** True while the person is on their feet and in the scene: a body on the ground, or one not there yet, is not in anyone's way. */
export const upright = (p: Person, t: number): boolean => {
  const s = p.st(t)
  return !!s && !s.hide && s.clip !== 'Death'
}

export const LANES = [-17, -5.5, 5.5, 17]
const DEATH = 1.5

export interface ZombieScript {
  props: Prop[]
  /** The armoured cars: where each is and which way it faces, at a time. */
  cars: { id: string; pos: (t: number) => THREE.Vector3; yaw: number; length: number; width: number; since: number }[]
  people: Person[]
  armoury: Armoury
  /** The footprint of the cars at a time. */
  carDiscs(i: number, t: number): Disc[]
  /** When each person falls, for the caption and for tests. */
  falls: { id: string; at: number }[]
  bossStart: number
  bossFall: number
}

const run = (from: THREE.Vector3, to: THREE.Vector3, speed: number, clip = 'Run'): Seg => ({ d: Math.max(0.01, from.distanceTo(to) / speed), from, to, clip })
const at = (x: number, z: number): THREE.Vector3 => V(x, 0, z)

/** A fall: the body drops, lies for a while, sinks a little and is gone. */
function falls(p: THREE.Vector3, lie = 2.2): Seg[] {
  return [
    { d: DEATH + lie - 0.9, from: p, clip: 'Death', hold: true },
    { d: 0.9, from: p, to: p.clone().add(V(0, -0.8, 0)), clip: 'Death', hold: true },
    { d: 999, from: p, clip: 'Death', hide: true },
  ]
}

export function zombieScript(): ZombieScript {
  const R = rng(7)
  const props: Prop[] = []
  const add = (kind: PropKind, x: number, z: number, o: { yaw?: number; scale?: number; r?: number; length?: number; width?: number; height?: number; fire?: boolean } = {}): void => {
    const discs = o.length ? capsule(x, z, o.length, o.width ?? 1, o.yaw ?? 0) : [{ x, z, r: o.r ?? 0.6 }]
    props.push({ kind, x, z, yaw: o.yaw ?? 0, scale: o.scale ?? 1, height: o.height, discs, fire: o.fire })
  }
  // the barricade: a container at each end and barriers between, with a gate left open in the middle
  add('ContainerRed', -14, BZ - 0.5, { yaw: 0, length: 5.7, width: 2.6 })
  props[0].discs = capsule(-14, BZ - 0.5, 5.7, 2.6, Math.PI / 2)
  add('ContainerGreen', 14, BZ - 0.5, { yaw: 0, length: 5.7, width: 2.6 })
  props[1].discs = capsule(14, BZ - 0.5, 5.7, 2.6, Math.PI / 2)
  for (let k = 0; k < 10; k++) {
    const x = -10.55 + k * 2.35
    if (Math.abs(x) < 1.8) continue
    add(k % 2 ? 'TBarrier' : 'Barrier', x, BZ + (k % 2) * 0.2, { scale: k % 2 ? 1.35 : 2.0, length: 2.16, width: 1.08, yaw: Math.PI / 2 })
  }
  add('Wheels', -7.4, BZ + 2.9, { scale: 1.4, r: 0.65 })
  add('Wheels', 21, BZ + 2.4, { scale: 1.4, r: 0.65 })
  add('Couch', -3.9, BZ + 2.9, { scale: 1.3, yaw: 0.4, r: 1.2 })
  add('Barrel', -12.5, BZ + 2.7, { scale: 1.2, r: 0.6, fire: true })
  add('Barrel', 12.8, BZ + 2.2, { scale: 1.2, r: 0.6, fire: true })
  add('Barrel', 17.5, BZ + 2.4, { scale: 1.2, r: 0.6, fire: true })
  add('WaterTower', -24, -17, { height: 9, r: 2.2 })

  // two armoured cars behind the barricade, along it: one is already there, the other races in
  const CZ = BZ + 5.2
  const carLen = 5.5
  const carW = 2.6
  const cars: ZombieScript['cars'] = [
    { id: 'car-a', pos: () => V(-10, 0, CZ), yaw: Math.PI / 2, length: carLen, width: carW, since: 0 },
    { id: 'car-b', pos: (t) => V(lerp(26, 9, ease(clamp((t - 0.5) / 4.5))), 0, CZ), yaw: -Math.PI / 2, length: carLen, width: carW, since: 0.5 },
  ]
  const carDiscs = (i: number, t: number): Disc[] => {
    const p = cars[i].pos(t)
    return capsule(p.x, p.z, carLen, carW, cars[i].yaw)
  }

  const people: Person[] = []
  const fallsList: ZombieScript['falls'] = []
  const shooters: Shooter[] = []
  const owner: number[] = [] // which person each shooter belongs to (-1 for a car)
  const defenders: { p: Person; spots: [THREE.Vector3, number, number][] }[] = []
  const addShooter = (id: string, pos: THREE.Vector3, from: number, until: number, gap: number, p: Person | null): number => {
    shooters.push({ id, at: pos, from, until, gap, range: 32 })
    owner.push(p ? people.indexOf(p) : -1)
    return shooters.length - 1
  }

  // --- the defenders behind the barricade (Matt with a rifle, an SMG or a shotgun) ---
  const DX = [-10.2, -6.0, 5.2, 8.4, 11.2]
  const GUNS: Weapon[] = ['Rifle', 'Smg', 'Shotgun', 'Rifle', 'Smg']
  const BOSS_START = 50
  DX.forEach((x, i) => {
    const pos = at(x, BZ + 1.6 + (i % 2) * 0.4)
    const segs: Seg[] = [
      { d: 42, from: pos, faceTo: at(x, 0), clip: 'Idle_Gun' },
      { d: 3, from: pos, clip: 'Wave' },
      { d: 3, from: pos, clip: 'Yes' },
      { d: BOSS_START + 1.3 - 48, from: pos, clip: 'Idle_Gun' },
      { d: 0.7, from: pos, clip: 'HitReact' },
      { d: 1.8, from: pos, clip: 'Duck', hold: true },
      { d: 74 - (BOSS_START + 3.8), from: pos, clip: 'Idle_Gun' },
      { d: 4, from: pos, clip: 'Wave' },
      { d: 99, from: pos, clip: 'Yes' },
    ]
    const p: Person = { id: `defender-${i}`, model: 'Matt', h: 2.1, weapon: GUNS[i], role: 'defender', st: seq(0, segs), shooters: [] }
    people.push(p)
    p.shooters.push(addShooter(p.id, pos.clone().add(V(0, 1.45, 0)), 0, 99, GUNS[i] === 'Shotgun' ? 0.7 : GUNS[i] === 'Smg' ? 0.11 : 0.22, p))
    // the shooter cannot fire while ducking
    const s = shooters[p.shooters[0]]
    s.until = BOSS_START + 1.3
    const s2 = addShooter(p.id, pos.clone().add(V(0, 1.45, 0)), BOSS_START + 3.8, 74, s.gap, p)
    p.shooters.push(s2)
  })

  // --- the fighters outside the barricade ---
  type Outcome = 'win' | 'lose'
  const fighters: { id: string; model: Model; weapon: Weapon; at: THREE.Vector3; fights: { arrive: number; lane: number; outcome: Outcome; end: number }[] }[] = [
    { id: 'sam', model: 'Sam', weapon: 'Axe', at: at(-13.5, 6), fights: [{ arrive: 11.5, lane: -17, outcome: 'win', end: 14.5 }, { arrive: 20, lane: -17, outcome: 'lose', end: 24.5 }] },
    { id: 'lis', model: 'Lis', weapon: 'Axe', at: at(0, 7.5), fights: [{ arrive: 13, lane: -5.5, outcome: 'win', end: 17 }, { arrive: 24, lane: 5.5, outcome: 'win', end: 28 }] },
    { id: 'shaun', model: 'Shaun', weapon: 'Spear', at: at(13.5, 6), fights: [{ arrive: 15, lane: 17, outcome: 'win', end: 19 }, { arrive: 27, lane: 17, outcome: 'lose', end: 31.5 }] },
  ]
  const turnedKills: { id: string; at: number; person: Person }[] = []
  const hordeKills: { id: string; at: number; person: Person }[] = []
  const gate = at(0, BZ - 1.1)
  const inside = [at(-1.4, BZ + 2.9), at(1.4, BZ + 2.9)]

  fighters.forEach((f, fi) => {
    const segs: Seg[] = []
    let clock = 0
    const idle = (to: number, face: THREE.Vector3): void => {
      if (to > clock) segs.push({ d: to - clock, from: f.at, faceTo: face, clip: 'Idle' })
      clock = Math.max(clock, to)
    }
    f.fights.forEach((fight, k) => {
      const start = at(fight.lane, -18)
      const dir = V(start.x - f.at.x, 0, start.z - f.at.z).normalize()
      const engage = f.at.clone().add(dir.multiplyScalar(1.3))
      const killer = fight.outcome === 'lose'
      idle(fight.arrive, engage)
      const slashEnd = killer ? fight.end - 0.7 : fight.end
      segs.push({ d: slashEnd - clock, from: f.at, faceTo: engage, clip: f.weapon === 'Spear' ? 'Stab' : 'Slash' })
      clock = slashEnd
      // the opponent
      const speed = 3.6
      // down the street, out past the last building, and only then across to the fighter
      const out = at(start.x, 3.4)
      const len = start.distanceTo(out) + out.distanceTo(engage)
      const s0 = fight.arrive - len / speed
      const oSegs: Seg[] = [run(start, out, speed), run(out, engage, speed), { d: killer ? fight.end + 1.6 - fight.arrive : fight.end - fight.arrive, from: engage, faceTo: f.at, clip: 'Idle_Attack' }]
      const oid = `${f.id}-opponent-${k}`
      if (killer) {
        const target = at(clamp(f.at.x * 0.8, -11, 11), BZ - 1.6)
        const walk = run(engage, target, 2.9, 'Walk')
        oSegs.push(walk)
        const tk = fight.end + 1.6 + walk.d
        oSegs.push(...falls(target))
        const op: Person = { id: oid, model: 'ZombieGreen', h: 2.0, role: 'horde', st: seq(s0, oSegs), shooters: [] }
        people.push(op)
        hordeKills.push({ id: oid, at: tk, person: op })
        fallsList.push({ id: oid, at: tk })
        // the fighter goes down, lies, and rises as one of them
        segs.push({ d: 0.7, from: f.at, faceTo: engage, clip: 'HitReact' })
        segs.push({ d: 3.0, from: f.at, clip: 'Death', hold: true })
        const rise = fight.end + 3.0
        segs.push({ d: 999, from: f.at, clip: 'Death', hide: true })
        clock = Infinity
        fallsList.push({ id: f.id, at: fight.end })
        const tTarget = at(f.at.x * 0.65, BZ - 1.6)
        const tSegs: Seg[] = [{ d: 1.4, from: f.at, faceTo: tTarget, clip: 'Death', hold: true, rate: -1 }]
        const tr = run(f.at, tTarget, 3.0)
        tSegs.push(tr, ...falls(tTarget))
        const tid = `${f.id}-turned`
        const tp: Person = { id: tid, model: 'ZombieGreen', h: 2.0, role: 'turned', st: seq(rise, tSegs), shooters: [] }
        people.push(tp)
        const tkk = rise + 1.4 + tr.d
        turnedKills.push({ id: tid, at: tkk, person: tp })
        fallsList.push({ id: tid, at: tkk })
      } else {
        oSegs.push(...falls(engage, 1.2))
        const op: Person = { id: oid, model: 'ZombieGreen', h: 2.0, role: 'horde', st: seq(s0, oSegs), shooters: [] }
        people.push(op)
        fallsList.push({ id: oid, at: fight.end })
      }
    })
    if (clock !== Infinity) {
      // a fighter who lives falls back to the gate once it is quiet
      idle(40 + fi * 0.8, at(f.at.x, 0))
      const to1 = run(f.at, gate, 4.2)
      const to2 = run(gate, inside[0], 4.2)
      segs.push(to1, to2, { d: 999, from: inside[0], faceTo: at(0, 0), clip: 'Idle' })
    }
    const p: Person = { id: f.id, model: f.model, h: 2.1, weapon: f.weapon, role: 'fighter', st: seq(0, segs), shooters: [] }
    people.push(p)
    defenders.push({ p, spots: [] })
  })

  // --- a fighter with a pistol, outside, who also falls back ---
  {
    const spot = at(-8.8, 8.8)
    const to1 = run(spot, gate, 4.2)
    const to2 = run(gate, inside[1], 4.2)
    const segs: Seg[] = [{ d: 40.4, from: spot, faceTo: at(-8.8, 0), clip: 'Idle_Gun' }, to1, to2, { d: 999, from: inside[1], faceTo: at(0, 0), clip: 'Idle_Gun' }]
    const p: Person = { id: 'pistol', model: 'Matt', h: 2.1, weapon: 'Pistol', role: 'fighter', st: seq(0, segs), shooters: [] }
    people.push(p)
    p.shooters.push(addShooter(p.id, spot.clone().add(V(0, 1.45, 0)), 0, 40.4, 0.3, p))
    p.shooters.push(addShooter(p.id, inside[1].clone().add(V(0, 1.45, 0)), 40.4 + to1.d + to2.d, 99, 0.3, p))
  }

  // --- the armoured cars' guns ---
  cars.forEach((c, i) => addShooter(c.id, c.pos(99).add(V(0, 2.7, 0)), c.since + (i === 1 ? 5.2 : 0), 99, 0.1, null))

  // --- the horde ---
  const LANE_N = 22
  for (let i = 0; i < LANE_N; i++) {
    const lane = LANES[i % 4] + (R() - 0.5) * 1.2
    const start = at(lane, -18 + R() * 3)
    const speed = 3.3 + R() * 0.7
    const s0 = 2.5 + i * 1.1
    const reachLine = R() < 0.3
    // the outer lanes run into the containers at the ends of the barricade, so they fall earlier
    const zd = Math.abs(lane) > 11 ? 3.5 + R() * 4.3 : reachLine ? BZ - 1.8 : 3.5 + R() * 7.5
    const p1 = at(lane, zd)
    const r1 = run(start, p1, speed)
    const id = `zombie-${i}`
    const z: Person = { id, model: 'ZombieGreen', h: 2.0, role: 'horde', st: seq(s0, [r1, ...falls(p1)]), shooters: [] }
    people.push(z)
    hordeKills.push({ id, at: s0 + r1.d, person: z })
    fallsList.push({ id, at: s0 + r1.d })
  }

  // --- the giant ---
  const BOSS_LANE = -5.5
  const b0 = at(BOSS_LANE, -19)
  const b1 = at(BOSS_LANE, 4.5)
  const bSegs: Seg[] = [{ ...run(b0, b1, 2.4, 'Walk'), rate: 1.2 }]
  let bz = 4.5
  const bossSteps: [number, number][] = [[5.4, 2.2], [6.3, 2.2], [7.1, 2.2], [7.8, 2.0], [8.2, 1.2]]
  bossSteps.forEach(([z, d], k) => {
    const from = at(BOSS_LANE, bz)
    const to = at(BOSS_LANE, z)
    bSegs.push({ d, from, to, clip: 'Walk', rate: 0.55 })
    bz = z
    if (k < bossSteps.length - 1) bSegs.push({ d: 0.6, from: to, clip: 'HitReact' })
  })
  const bEnd = BOSS_START + b0.distanceTo(b1) / 2.4 + bossSteps.reduce((a, [, d]) => a + d, 0) + (bossSteps.length - 1) * 0.6
  const bp = at(BOSS_LANE, bz)
  bSegs.push({ d: 2.5, from: bp, clip: 'Death', hold: true }, { d: 11, from: bp, clip: 'Death', hold: true }, { d: 0.9, from: bp, to: bp.clone().add(V(0, -1.2, 0)), clip: 'Death', hold: true }, { d: 999, from: bp, clip: 'Death', hide: true })
  const boss: Person = { id: 'boss', model: 'BigArm', h: 6.2, role: 'boss', st: seq(BOSS_START, bSegs), shooters: [] }
  people.push(boss)
  fallsList.push({ id: 'boss', at: bEnd })

  const armoury = new Armoury(shooters)
  // the fall of each zombie is paid for with bullets that land just before it
  const byTime = [...hordeKills, ...turnedKills].sort((a, b) => a.at - b.at)
  for (const k of byTime) {
    const hits = 3 + Math.floor(R() * 3)
    armoury.kill({ target: k.id, at: k.at - 0.02, hits, where: (t) => chest(k.person.st(Math.min(t, k.at - 0.02))?.pos ?? V(), 1.1) })
  }
  // the whole line opens up on the giant
  const bossWhere = (t: number): THREE.Vector3 => chest(boss.st(Math.min(t, bEnd - 0.02))?.pos ?? bp, 3.3)
  armoury.volley('boss', bossWhere, BOSS_START + 5.2, bEnd - 0.4, 0.26)
  armoury.kill({ target: 'boss', at: bEnd - 0.02, hits: 4, where: bossWhere })
  void owner
  void defenders

  return { props, cars, people, armoury, carDiscs, falls: fallsList, bossStart: BOSS_START, bossFall: bEnd }
}
