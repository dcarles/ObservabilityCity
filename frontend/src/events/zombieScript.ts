// The zombie defence on a real island, worked out as plain data before anything is drawn: the barricade across the island's sea side, where each
// person is at each moment (round the island's own buildings, never through one, never through each other), who shoots whom, and which buildings
// the horde gets to and claws at. Keeping it apart from the drawing is what lets a test prove it on towns of any shape.

import * as THREE from 'three'
import { Arena, along, lengthOf, middleOf, type Block } from './arena'
import { Armoury, chest, type Shooter } from './combat'
import { settle } from './crowd'
import { capsule, clamp, ease, rng, seq, V, type Disc, type Seg } from './rig'

export const ZLOOP = 90

export type Model = 'ZombieGreen' | 'BigArm' | 'Matt' | 'Sam' | 'Shaun' | 'Lis'
export type Weapon = 'Rifle' | 'Smg' | 'Shotgun' | 'Pistol' | 'Axe' | 'Spear'
export type PropKind = 'ContainerRed' | 'ContainerGreen' | 'TBarrier' | 'Barrier' | 'Wheels' | 'Couch' | 'Barrel'

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
  /** Part of the barricade wall itself. */
  wall?: boolean
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
  /** How wide it stands. */
  r: number
}

/** True while the person is on their feet and in the scene: a body on the ground, or one not there yet, is not in anyone's way. */
export const upright = (p: Person, t: number): boolean => {
  const s = p.st(t)
  return !!s && !s.hide && s.clip !== 'Death'
}

const DEATH = 1.5
export const BOSS_START = 50

export interface ZombieScript {
  props: Prop[]
  /** The armoured cars: where each is and which way it faces, at a time. */
  cars: { id: string; pos: (t: number) => THREE.Vector3; yaw: (t: number) => number; length: number; width: number; since: number }[]
  people: Person[]
  armoury: Armoury
  /** The footprint of the cars at a time. */
  carDiscs(i: number, t: number): Disc[]
  /** When each person falls, for the caption and for tests. */
  falls: { id: string; at: number }[]
  bossStart: number
  bossFall: number
  /** The buildings the horde claws at and when each is first reached. */
  targets: Block[]
  hit: number[]
  /** The middle of the barricade, and the way out to sea. */
  barricade: THREE.Vector3
  seaward: number
}

/** A fall: the body drops, lies for a while, sinks a little and is gone. */
function falls(p: THREE.Vector3, lie = 2.2): Seg[] {
  return [
    { d: DEATH + lie - 0.9, from: p, clip: 'Death', hold: true },
    { d: 0.9, from: p, to: p.clone().add(V(0, -0.8, 0)), clip: 'Death', hold: true },
    { d: 999, from: p, clip: 'Death', hide: true },
  ]
}

export function zombieScript(arena: Arena): ZombieScript {
  const R = rng(7)
  const a = arena.src.seaward
  const d = V(Math.sin(a), 0, Math.cos(a))
  const u = V(Math.cos(a), 0, -Math.sin(a))
  const S = arena.shore
  const wide = new Arena(arena.src, 3.2, 1.3)

  // the barricade stands across the sea side of the island, a good way in from the coast, on clear ground
  const back = clamp(arena.reach * 0.4, 9, 20)
  const B = arena.nearestClear(S.x - d.x * back, S.z - d.z * back, 2.5) ?? V(S.x - d.x * back, 0, S.z - d.z * back)
  /** A point in the barricade's frame: `fu` along the line, `fd` out toward the sea. */
  const L = (fu: number, fd: number): THREE.Vector3 => V(B.x + u.x * fu + d.x * fd, 0, B.z + u.z * fu + d.z * fd)

  const props: Prop[] = []
  const add = (kind: PropKind, fu: number, fd: number, o: { yaw?: number; scale?: number; r?: number; length?: number; width?: number; height?: number; fire?: boolean; wall?: boolean } = {}): void => {
    const p = L(fu, fd)
    const r = o.length ? Math.max(o.width ?? 1, 1) / 2 + 0.2 : (o.r ?? 0.6)
    // a prop only stands where there is room: on the island and clear of every building
    if (!arena.clear(p.x, p.z, r, true)) return
    const discs = o.length ? capsule(p.x, p.z, o.length, o.width ?? 1, Math.PI / 2 + a) : [{ x: p.x, z: p.z, r: o.r ?? 0.6 }]
    props.push({ kind, x: p.x, z: p.z, yaw: o.wall ? a : (o.yaw ?? 0) + a, scale: o.scale ?? 1, height: o.height, discs, fire: o.fire, wall: o.wall })
  }
  add('ContainerRed', -14, 0.5, { length: 5.7, width: 2.6, wall: true })
  add('ContainerGreen', 14, 0.5, { length: 5.7, width: 2.6, wall: true })
  for (let k = 0; k < 10; k++) {
    const fu = -10.55 + k * 2.35
    if (Math.abs(fu) < 1.8) continue
    add(k % 2 ? 'TBarrier' : 'Barrier', fu, -(k % 2) * 0.2, { scale: k % 2 ? 1.35 : 2.0, length: 2.16, width: 1.08, yaw: Math.PI / 2, wall: true })
  }
  add('Wheels', -7.4, -2.9, { scale: 1.4, r: 0.65 })
  add('Wheels', 21, -2.4, { scale: 1.4, r: 0.65 })
  add('Couch', -3.9, -2.9, { scale: 1.3, yaw: 0.4, r: 1.2 })
  add('Barrel', -12.5, -2.7, { scale: 1.2, r: 0.6, fire: true })
  add('Barrel', 12.8, -2.2, { scale: 1.2, r: 0.6, fire: true })
  add('Barrel', 17.5, -2.4, { scale: 1.2, r: 0.6, fire: true })
  arena.addObstacle(...props.flatMap((p) => p.discs))
  wide.addObstacle(...props.flatMap((p) => p.discs))

  // two armoured cars behind the barricade, along it: one is already there, the other races in from the bridge
  const carLen = 5.5
  const carW = 2.6
  const parkA = wide.nearestClear(L(-10, -5.2).x, L(-10, -5.2).z) ?? L(-10, -5.2)
  wide.addObstacle(...capsule(parkA.x, parkA.z, carLen, carW, Math.PI / 2 + a))
  const parkB = wide.nearestClear(L(9, -5.2).x, L(9, -5.2).z, 0, (x, z) => Math.hypot(x - parkA.x, z - parkA.z) > 7) ?? L(9, -5.2)
  const gate = arena.src.gate ? V(arena.src.gate.x, 0, arena.src.gate.z) : arena.coastAt(a + Math.PI)
  let roadB = wide.path(gate, parkB)
  const lenB = roadB ? lengthOf(roadB) : 0
  const driveEnd = roadB ? 0.5 + Math.max(4.5, lenB / 14) : 0.5
  // set below if the people who must be where they are would be in the way of the drive in: the car is then there from the start
  let parked = false
  const posB = (t: number): THREE.Vector3 => {
    if (!roadB || parked) return parkB.clone()
    let s = ease(clamp((t - 0.5) / (driveEnd - 0.5))) * lenB
    for (let i = 0; i + 1 < roadB.length; i++) {
      const l = roadB[i].distanceTo(roadB[i + 1])
      if (s <= l || i + 2 === roadB.length) return roadB[i].clone().lerp(roadB[i + 1], clamp(s / Math.max(l, 1e-6)))
      s -= l
    }
    return parkB.clone()
  }
  const yawB = (t: number): number => {
    if (!roadB || parked) return Math.PI / 2 + a
    const p0 = posB(Math.max(0.5, t - 0.05))
    const p1 = posB(Math.max(0.55, t + 0.05))
    return p1.distanceTo(p0) > 1e-4 ? Math.atan2(p1.x - p0.x, p1.z - p0.z) : yawEnd
  }
  const yawEnd = roadB && roadB.length > 1 ? Math.atan2(roadB[roadB.length - 1].x - roadB[roadB.length - 2].x, roadB[roadB.length - 1].z - roadB[roadB.length - 2].z) : Math.PI / 2 + a
  const cars: ZombieScript['cars'] = [
    { id: 'car-a', pos: () => parkA.clone(), yaw: () => Math.PI / 2 + a, length: carLen, width: carW, since: 0 },
    { id: 'car-b', pos: posB, yaw: (t) => (parked ? Math.PI / 2 + a : t >= driveEnd ? yawEnd : yawB(t)), length: carLen, width: carW, since: 0.5 },
  ]
  const carDiscs = (i: number, t: number): Disc[] => {
    const p = cars[i].pos(t)
    return capsule(p.x, p.z, carLen, carW, cars[i].yaw(t))
  }
  arena.addObstacle(...carDiscs(0, 99), ...carDiscs(1, 99))
  // nobody is put where the second car drives in
  const road: THREE.Vector3[] = []
  for (let t = 0.5; t <= driveEnd; t += 0.25) road.push(posB(t))

  const people: Person[] = []
  const fallsList: ZombieScript['falls'] = []
  const shooters: Shooter[] = []
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
  const addShooter = (id: string, pos: THREE.Vector3, from: number, until: number, gap: number): number => {
    shooters.push({ id, at: pos, from, until, gap, range: 60 })
    return shooters.length - 1
  }
  const taken: THREE.Vector3[] = []
  /** The nearest clear spot to a point in the barricade's frame that is not crowding anyone already placed. */
  const stand = (fu: number, fd: number): THREE.Vector3 => {
    const p = L(fu, fd)
    const s = arena.nearestClear(p.x, p.z, 0.3, (x, z) => taken.every((o) => Math.hypot(o.x - x, o.z - z) > 1.9) && road.every((o) => Math.hypot(o.x - x, o.z - z) > 3.4)) ?? p
    taken.push(s)
    return s
  }

  // --- the defenders behind the barricade (Matt with a rifle, an SMG or a shotgun) ---
  const DX = [-10.2, -6.0, 5.2, 8.4, 11.2]
  const GUNS: Weapon[] = ['Rifle', 'Smg', 'Shotgun', 'Rifle', 'Smg']
  DX.forEach((fu, i) => {
    const pos = stand(fu, -(1.6 + (i % 2) * 0.4))
    const segs: Seg[] = [
      { d: 42, from: pos, faceTo: L(fu, 20), clip: 'Idle_Gun' },
      { d: 3, from: pos, clip: 'Wave' },
      { d: 3, from: pos, clip: 'Yes' },
      { d: BOSS_START + 1.3 - 48, from: pos, clip: 'Idle_Gun' },
      { d: 0.7, from: pos, clip: 'HitReact' },
      { d: 1.8, from: pos, clip: 'Duck', hold: true },
      { d: 74 - (BOSS_START + 3.8), from: pos, clip: 'Idle_Gun' },
      { d: 4, from: pos, clip: 'Wave' },
      { d: 99, from: pos, clip: 'Yes' },
    ]
    const p: Person = { id: `defender-${i}`, model: 'Matt', h: 2.1, weapon: GUNS[i], role: 'defender', st: seq(0, segs), shooters: [], r: 0.45 }
    people.push(p)
    const gap = GUNS[i] === 'Shotgun' ? 0.7 : GUNS[i] === 'Smg' ? 0.11 : 0.22
    // the shooter cannot fire while ducking
    p.shooters.push(addShooter(p.id, pos.clone().add(V(0, 1.45, 0)), 0, BOSS_START + 1.3, gap))
    p.shooters.push(addShooter(p.id, pos.clone().add(V(0, 1.45, 0)), BOSS_START + 3.8, 74, gap))
  })

  // --- the sea, where the horde comes from: they wade ashore ---
  /** The way in from the sea at an angle off the sea side: a short wade, then the coast. */
  const landing = (off: number): { wade: Seg; shore: THREE.Vector3 } => {
    let ang = a + off
    let coast = arena.coastAt(ang)
    let dir = V(Math.sin(ang), 0, Math.cos(ang))
    let shore: THREE.Vector3 | null = null
    // where buildings crowd the coast, come ashore nearer the middle of the sea side
    for (let k = 0; k < 8 && !shore; k++) {
      ang = a + off * (1 - k * 0.14)
      coast = arena.coastAt(ang)
      dir = V(Math.sin(ang), 0, Math.cos(ang))
      const c = arena.nearestClear(coast.x - dir.x * 1.4, coast.z - dir.z * 1.4, 0.3)
      if (c && c.distanceTo(coast) < 4) shore = c
    }
    shore ??= arena.nearestClear(coast.x - dir.x * 1.4, coast.z - dir.z * 1.4, 0.3) ?? coast
    const out = V(coast.x + dir.x * 3.2, -0.45, coast.z + dir.z * 3.2)
    return { wade: { d: out.distanceTo(shore) / 2.6, from: out, to: shore, clip: 'Run' }, shore }
  }

  // --- the fighters outside the barricade ---
  type Outcome = 'win' | 'lose'
  const fighters: { id: string; model: Model; weapon: Weapon; fu: number; fd: number; fights: { arrive: number; off: number; outcome: Outcome; end: number }[] }[] = [
    { id: 'sam', model: 'Sam', weapon: 'Axe', fu: -13.5, fd: 6, fights: [{ arrive: 11.5, off: -0.5, outcome: 'win', end: 14.5 }, { arrive: 20, off: -0.5, outcome: 'lose', end: 24.5 }] },
    { id: 'lis', model: 'Lis', weapon: 'Axe', fu: 0, fd: 7.5, fights: [{ arrive: 13, off: -0.15, outcome: 'win', end: 17 }, { arrive: 24, off: 0.15, outcome: 'win', end: 28 }] },
    { id: 'shaun', model: 'Shaun', weapon: 'Spear', fu: 13.5, fd: 6, fights: [{ arrive: 15, off: 0.5, outcome: 'win', end: 19 }, { arrive: 27, off: 0.5, outcome: 'lose', end: 31.5 }] },
  ]
  const turnedKills: { id: string; at: number; person: Person }[] = []
  const hordeKills: { id: string; at: number; person: Person }[] = []
  const gateAt = arena.nearestClear(B.x, B.z, 0.3) ?? B
  const inside = [stand(-2.8, -2.9), stand(-0.2, -4.6), stand(2.8, -2.9), stand(-5.4, -4.4)]
  const fixedSpots = fighters.map((f) => stand(f.fu, f.fd))
  const pistolSpot = stand(-8.8, 3.2)
  // everyone who stands in place is in the way of the others' routes
  arena.addObstacle(...[...fixedSpots, pistolSpot, ...inside].map((p) => ({ x: p.x, z: p.z, r: 0.45 })), ...people.map((p) => p.st(0)).filter((s) => s).map((s) => ({ x: s!.pos.x, z: s!.pos.z, r: 0.45 })))
  const bodies: { p: Person; fixed: boolean; make: (delay: number) => Person['st'] }[] = []
  const keep = (p: Person, fixed: boolean, make?: (delay: number) => Person['st']): void => {
    people.push(p)
    bodies.push({ p, fixed, make: make ?? (() => p.st) })
  }

  fighters.forEach((f, fi) => {
    const at = fixedSpots[fi]
    const segs: Seg[] = []
    let clock = 0
    const idle = (to: number, face: THREE.Vector3): void => {
      if (to > clock) segs.push({ d: to - clock, from: at, faceTo: face, clip: 'Idle' })
      clock = Math.max(clock, to)
    }
    f.fights.forEach((fight, k) => {
      const engage = arena.nearestClear(at.x + d.x * 1.3, at.z + d.z * 1.3, 0.3, (x, z) => Math.hypot(x - at.x, z - at.z) > 0.95) ?? at.clone().add(d.clone().multiplyScalar(1.3))
      const killer = fight.outcome === 'lose'
      idle(fight.arrive, engage)
      const slashEnd = killer ? fight.end - 0.7 : fight.end
      segs.push({ d: slashEnd - clock, from: at, faceTo: engage, clip: f.weapon === 'Spear' ? 'Stab' : 'Slash' })
      clock = slashEnd
      // the opponent wades ashore, runs in and squares up to the fighter
      const speed = 3.6
      const { wade, shore } = landing(fight.off)
      const route = arena.path(shore, engage) ?? [shore, engage]
      const len = lengthOf(route)
      const s0 = fight.arrive - wade.d - len / speed
      const oSegs: Seg[] = [wade, ...along(route, speed), { d: killer ? fight.end + 1.6 - fight.arrive : fight.end - fight.arrive, from: engage, faceTo: at, clip: 'Idle_Attack' }]
      const oid = `${f.id}-opponent-${k}`
      if (killer) {
        const target = arena.nearestClear(L(clamp(f.fu * 0.8, -11, 11), 1.6).x, L(clamp(f.fu * 0.8, -11, 11), 1.6).z, 0.3) ?? engage
        const toTarget = along(arena.path(engage, target) ?? [engage, target], 2.9, 'Walk')
        oSegs.push(...toTarget)
        const tk = fight.end + 1.6 + toTarget.reduce((x, s) => x + s.d, 0)
        oSegs.push(...falls(target))
        const op: Person = { id: oid, model: 'ZombieGreen', h: 2.0, role: 'horde', st: seq(s0, oSegs), shooters: [], r: 0.45 }
        keep(op, true)
        hordeKills.push({ id: oid, at: tk, person: op })
        fallsList.push({ id: oid, at: tk })
        // the fighter goes down, lies, and rises as one of them
        segs.push({ d: 0.7, from: at, faceTo: engage, clip: 'HitReact' })
        segs.push({ d: 3.0, from: at, clip: 'Death', hold: true })
        const rise = fight.end + 3.0
        segs.push({ d: 999, from: at, clip: 'Death', hide: true })
        clock = Infinity
        fallsList.push({ id: f.id, at: fight.end })
        const tTarget = arena.nearestClear(L(f.fu * 0.65, 1.6).x, L(f.fu * 0.65, 1.6).z, 0.3) ?? at
        const tr = along(arena.path(at, tTarget) ?? [at, tTarget], 3.0)
        const tSegs: Seg[] = [{ d: 1.4, from: at, faceTo: tTarget, clip: 'Death', hold: true, rate: -1 }, ...tr, ...falls(tTarget)]
        const tid = `${f.id}-turned`
        const tp: Person = { id: tid, model: 'ZombieGreen', h: 2.0, role: 'turned', st: seq(rise, tSegs), shooters: [], r: 0.45 }
        keep(tp, true)
        const tkk = rise + 1.4 + tr.reduce((x, s) => x + s.d, 0)
        turnedKills.push({ id: tid, at: tkk, person: tp })
        fallsList.push({ id: tid, at: tkk })
      } else {
        oSegs.push(...falls(engage, 1.2))
        const op: Person = { id: oid, model: 'ZombieGreen', h: 2.0, role: 'horde', st: seq(s0, oSegs), shooters: [], r: 0.45 }
        keep(op, true)
        fallsList.push({ id: oid, at: fight.end })
      }
    })
    if (clock !== Infinity) {
      // a fighter who lives falls back through the gate once it is quiet
      idle(43.5 + fi * 2.5, L(f.fu, -20))
      const spot = inside[fi === 0 ? 0 : fi === 1 ? 1 : 2]
      const back1 = along(arena.path(at, gateAt) ?? [at, gateAt], 4.2)
      const back2 = along(arena.path(gateAt, spot) ?? [gateAt, spot], 4.2)
      segs.push(...back1, ...back2, { d: 999, from: spot, faceTo: L(0, 20), clip: 'Idle' })
    }
    keep({ id: f.id, model: f.model, h: 2.1, weapon: f.weapon, role: 'fighter', st: seq(0, segs), shooters: [], r: 0.45 }, true)
  })

  // --- a fighter with a pistol, outside, who also falls back ---
  {
    const to1 = along(arena.path(pistolSpot, gateAt) ?? [pistolSpot, gateAt], 4.2)
    const to2 = along(arena.path(gateAt, inside[3]) ?? [gateAt, inside[3]], 4.2)
    const walk = to1.reduce((x, s) => x + s.d, 0) + to2.reduce((x, s) => x + s.d, 0)
    const segs: Seg[] = [{ d: 36, from: pistolSpot, faceTo: L(-8.8, 20), clip: 'Idle_Gun' }, ...to1, ...to2, { d: 999, from: inside[3], faceTo: L(0, 20), clip: 'Idle_Gun' }]
    const p: Person = { id: 'pistol', model: 'Matt', h: 2.1, weapon: 'Pistol', role: 'fighter', st: seq(0, segs), shooters: [], r: 0.45 }
    keep(p, true)
    p.shooters.push(addShooter(p.id, pistolSpot.clone().add(V(0, 1.45, 0)), 0, 36, 0.3))
    p.shooters.push(addShooter(p.id, inside[3].clone().add(V(0, 1.45, 0)), 36 + walk, 99, 0.3))
  }

  // --- the armoured cars' guns ---
  cars.forEach((c, i) => addShooter(c.id, c.pos(99).add(V(0, 2.7, 0)), c.since + (i === 1 ? driveEnd - 0.5 : 0), 99, 0.1))

  // --- the horde: wades ashore along the sea side, runs at the barricade, and some get past it to the buildings ---
  const LANES = [-17, -5.5, 5.5, 17]
  const LANE_N = 22
  const near = arena.blocksByDistance(B.x, B.z).slice(0, 3)
  interface Horde {
    id: string
    plan: (delay: number) => { st: Person['st']; fallAt: number; block?: Block; reach?: number }
  }
  const hordes: Horde[] = []
  for (let i = 0; i < LANE_N; i++) {
    const lane = LANES[i % 4] + (R() - 0.5) * 1.2
    const off = clamp(lane / 40, -0.5, 0.5) + (R() - 0.5) * 0.1
    const speed = 3.3 + R() * 0.7
    const reachLine = R() < 0.3
    const leaker = near.length > 0 && i % 4 === 3
    // the outer lanes run into the containers at the ends of the barricade, so they fall earlier
    const fd = Math.abs(lane) > 11 ? 4.2 + R() * 4.3 : reachLine ? 1.8 : 4.5 + R() * 7.5
    const block = leaker ? near[i % near.length] : undefined
    const doorSpots = block ? arena.spotsAround(block, 8) : []
    const door = block ? (doorSpots[(i >> 2) % Math.max(1, doorSpots.length)] ?? arena.doorOf(block, B)) : null
    const want = leaker && door ? door : (arena.nearestClear(L(lane, fd).x, L(lane, fd).z, 0.3) ?? L(lane, fd))
    const { wade, shore } = landing(off)
    const route = arena.path(shore, want) ?? [shore, want]
    const goal = route[route.length - 1]
    hordes.push({
      id: `zombie-${i}`,
      plan: (delay) => {
        const legs = [wade, ...along(route, speed)]
        const travel = legs.reduce((x, sg) => x + sg.d, 0)
        // they reach the line one after another whatever the size of the island: a long way in just means starting sooner
        const s0 = Math.max(0.3, 8 + i * 1.1 - travel)
        const claw: Seg[] = leaker && door && block ? [{ d: 2.6, from: goal, faceTo: middleOf(block), clip: 'Idle_Attack' }] : []
        const arrive = s0 + delay + legs.reduce((x, s) => x + s.d, 0)
        const fallAt = arrive + claw.reduce((x, s) => x + s.d, 0)
        return { st: seq(s0 + delay, [...legs, ...claw, ...falls(goal)]), fallAt, block: leaker ? block : undefined, reach: arrive }
      },
    })
  }

  // --- the giant ---
  const bossFirst = wide.nearestClear(L(-5.5, 7.5).x, L(-5.5, 7.5).z, 1.2) ?? L(-5.5, 7.5)
  const bossLand = landing(0)
  const bossRoute = wide.path(bossLand.shore, bossFirst) ?? [bossLand.shore, bossFirst]
  const bossWalk = along(bossRoute, 2.4, 'Walk', { rate: 1.2 })
  const toward = V(B.x - bossFirst.x, 0, B.z - bossFirst.z)
  const toGo = Math.max(0, Math.min(3.7, toward.length() - 4.2))
  toward.normalize()
  const bossSteps: [number, number][] = [[0.9, 2.2], [0.9, 2.2], [0.8, 2.2], [0.7, 2.0], [0.4, 1.2]]
  const scale = bossSteps.reduce((x, [m]) => x + m, 0) > 0 ? toGo / bossSteps.reduce((x, [m]) => x + m, 0) : 0
  let cur = bossFirst.clone()
  const bSegs: Seg[] = [{ d: bossLand.wade.d, from: bossLand.wade.from, to: bossLand.wade.to, clip: 'Walk', rate: 1.2 }, ...bossWalk]
  bossSteps.forEach(([m, dur], k) => {
    const to = cur.clone().addScaledVector(toward, m * scale)
    bSegs.push({ d: dur, from: cur, to, clip: 'Walk', rate: 0.55 })
    cur = to
    if (k < bossSteps.length - 1) bSegs.push({ d: 0.6, from: to, clip: 'HitReact' })
  })
  const walkTime = bSegs.slice(0, 1 + bossWalk.length).reduce((x, s) => x + s.d, 0)
  const bEnd = BOSS_START + walkTime + bossSteps.reduce((x, [, dur]) => x + dur, 0) + (bossSteps.length - 1) * 0.6
  const bp = cur.clone()
  bSegs.push({ d: 2.5, from: bp, clip: 'Death', hold: true }, { d: 11, from: bp, clip: 'Death', hold: true }, { d: 0.9, from: bp, to: bp.clone().add(V(0, -1.2, 0)), clip: 'Death', hold: true }, { d: 999, from: bp, clip: 'Death', hide: true })
  const boss: Person = { id: 'boss', model: 'BigArm', h: 6.2, role: 'boss', st: seq(BOSS_START, bSegs), shooters: [], r: 1.2 }

  // --- the horde keeps out of everyone's way: a zombie who would run into somebody starts a little later ---
  if (roadB) {
    for (let t = 0.5; t <= driveEnd && !parked; t += 0.1)
      for (const b of bodies) {
        const s = b.p.st(t)
        if (s && !s.hide && s.clip !== 'Death' && s.pos.y > -0.3 && s.pos.y < 1.2 && s.pos.distanceTo(posB(t)) < 2.0 + b.p.r + 0.1) parked = true
      }
  }
  const hordeBodies = hordes.map((h) => ({ id: h.id, r: 0.45, make: (dl: number) => h.plan(dl).st }))
  const fixedBodies = [
    ...bodies.map((b) => ({ id: b.p.id, r: b.p.r, fixed: true, make: b.make })),
    { id: 'boss', r: 1.2, fixed: true, make: () => boss.st },
    // the armoured cars are in the way too: the second one as it drives in
    ...cars.map((c) => ({ id: c.id, r: 2.0, fixed: true, solid: () => true, make: () => (t: number) => (t >= c.since ? ({ pos: c.pos(t), yaw: 0, clip: 'Idle', ct: 0, rate: 1, hold: false, hide: false, carry: false } as ReturnType<Person['st']>) : null) })),
  ]
  const delays = settle([...fixedBodies, ...hordeBodies], ZLOOP, { step: 0.5, tries: 24 }).slice(fixedBodies.length)
  hordes.forEach((h, i) => {
    const pl = h.plan(delays[i])
    const z: Person = { id: h.id, model: 'ZombieGreen', h: 2.0, role: 'horde', st: pl.st, shooters: [], r: 0.45 }
    people.push(z)
    hordeKills.push({ id: h.id, at: pl.fallAt, person: z })
    fallsList.push({ id: h.id, at: pl.fallAt })
    if (pl.block && pl.reach !== undefined) mark(pl.block, pl.reach)
  })
  people.push(boss)
  fallsList.push({ id: 'boss', at: bEnd })

  const armoury = new Armoury(shooters)
  // the fall of each zombie is paid for with bullets that land just before it
  const byTime = [...hordeKills, ...turnedKills].sort((x, y) => x.at - y.at)
  for (const k of byTime) {
    const hits = 3 + Math.floor(R() * 3)
    armoury.kill({ target: k.id, at: k.at - 0.02, hits, where: (t) => chest(k.person.st(Math.min(t, k.at - 0.02))?.pos ?? V(), 1.1) })
  }
  // the whole line opens up on the giant
  const bossWhere = (t: number): THREE.Vector3 => chest(boss.st(Math.min(t, bEnd - 0.02))?.pos ?? bp, 3.3)
  armoury.volley('boss', bossWhere, BOSS_START + 5.2, bEnd - 0.4, 0.26)
  armoury.kill({ target: 'boss', at: bEnd - 0.02, hits: 4, where: bossWhere })

  return { props, cars, people, armoury, carDiscs, falls: fallsList, bossStart: BOSS_START, bossFall: bEnd, targets, hit, barricade: B, seaward: a }
}

