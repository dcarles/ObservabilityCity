// The pirate raid on a real island, worked out as plain data: where the ship moors, the route each pirate takes to a real building and back, when
// the cannon hits each building, and what is carried aboard. Drawing is in pirates.ts; keeping this apart lets a test check any island.

import * as THREE from 'three'
import { settle } from './crowd'
import { Arena, along, lengthOf, middleOf, type Block } from './arena'
import { ease, lerp, seq, V, type Seg } from './rig'

/** The least time the raid lasts; it is longer on a big island, where the crew have farther to run. */
export const PLOOP = 66
export const SHOTS = [13.5, 17, 20.5, 24]
export const DECK = 3.1
export const DOCK_Y = 0.7
/** Frame of the harbour scene: z grows out to sea, and the coast is at this z. */
const COAST_Z = 13
const SHIP_X = 12.6
const SHIP_Z = 20.5
const Y = V(0, 1, 0)

export interface Pirate {
  id: string
  /** Index of the building raided. */
  target: number
  st: ReturnType<typeof seq>
  /** When the loot is picked up and when it is put aboard. */
  lootFrom: number
  lootTo: number
  kind: number
}

export interface PirateScript {
  /** The coast point the jetty starts from and the way out to sea. */
  shore: THREE.Vector3
  seaward: number
  /** How long this raid lasts, and when the ship turns to leave. */
  loop: number
  departs: number
  /** Maps a point of the harbour scene (x sideways, z out to sea; the coast at z = 13) onto the island. */
  at(fx: number, fz: number, y?: number): THREE.Vector3
  targets: Block[]
  pirates: Pirate[]
  ship(t: number): { pos: THREE.Vector3; yaw: number }
  /** Where a point on the ship's deck is, with the ship at time `t`. */
  onShip(off: THREE.Vector3, t: number): THREE.Vector3
  /** When each building is first hit. */
  hit: number[]
  /** Which building each cannon shot is aimed at. */
  shotTarget: number[]
  dockEnd: THREE.Vector3
  landPt: THREE.Vector3
}

export function pirateScript(arena: Arena): PirateScript {
  const a = arena.src.seaward
  const S = arena.shore
  const d = V(Math.sin(a), 0, Math.cos(a))
  const u = V(Math.cos(a), 0, -Math.sin(a))
  const at = (fx: number, fz: number, y = 0): THREE.Vector3 => V(S.x + d.x * (fz - COAST_Z) + u.x * fx, y, S.z + d.z * (fz - COAST_Z) + u.z * fx)

  // the ship waits for the last of the crew, and not less than the usual time
  let tDep = 46
  const ship = (t: number): { pos: THREE.Vector3; yaw: number } => {
    let fx = SHIP_X
    let fz = SHIP_Z
    let yaw = Math.PI
    if (t < 12) fz = lerp(70, SHIP_Z, 1 - Math.pow(1 - t / 12, 2.2))
    else if (t >= tDep && t < tDep + 6) yaw = lerp(Math.PI, Math.PI / 2, ease((t - tDep) / 6))
    else if (t >= tDep + 6) {
      const k = (t - tDep - 6) / 14
      fx = SHIP_X + k * k * 90
      yaw = Math.PI / 2
    }
    return { pos: at(fx, fz, 0.1 + Math.sin(t * 1.3) * 0.08), yaw: yaw + a }
  }
  const onShip = (off: THREE.Vector3, t: number): THREE.Vector3 => {
    const s = ship(t)
    return s.pos.clone().add(V(off.x, DECK, off.z).applyAxisAngle(Y, s.yaw - Math.PI))
  }
  const deck = (off: THREE.Vector3): Pick<Seg, 'fn' | 'yawFn'> => ({ fn: (t) => onShip(off, t), yawFn: (t) => ship(t).yaw })

  const dockEnd = at(9.4, 18.2, DOCK_Y)
  const landPt = arena.nearestClear(at(8.4, 10.5).x, at(8.4, 10.5).z) ?? S.clone()
  // the four buildings raided: the one nearest the landing, then the ones furthest from those chosen, so the raid spreads
  const targets = arena.spread(4, landPt.x, landPt.z, 4.2)
  const pirates: Pirate[] = []

  const prep: { i: number; ti: number; door: THREE.Vector3; there: THREE.Vector3[]; s0: number; stay: number; off: THREE.Vector3 }[] = []
  // each pirate has a door of his own; a pirate standing at his door is in the way of everyone else's route, so the routes go round the doors
  const doors: THREE.Vector3[] = []
  for (let i = 0; i < 8; i++) {
    const ti = i % targets.length
    const spots = arena.spotsAround(targets[ti], Math.ceil(8 / targets.length), undefined, 4.2)
    const mine = spots[Math.floor(i / targets.length)]
    // a building with too few free spots round it gives the next pirate the nearest free ground, not somebody else's door
    doors.push(mine ?? arena.nearestClear(middleOf(targets[ti]).x, middleOf(targets[ti]).z, 0.3, (x, z) => doors.every((d) => Math.hypot(d.x - x, d.z - z) > 4.2)) ?? landPt)
  }
  arena.addObstacle(...doors.map((d) => ({ x: d.x, z: d.z, r: 0.3 })))
  for (let i = 0; i < 8; i++) {
    const there = arena.path(landPt, doors[i], { x: doors[i].x, z: doors[i].z, r: 0.3 }) ?? [landPt, doors[i]]
    // the walk may stop short of a door that cannot be reached; he works at the end of it
    const door = there[there.length - 1]
    prep.push({ i, ti: i % targets.length, door, there, s0: 13.5 + i * 1.1, stay: 0, off: V(-0.2 + (i % 2) * 1.4, 0, -5.4 + i * 1.5) })
  }
  // The crew all go out first and all come back after, in the order they left, so nobody meets another head on in a narrow street. As fast as it
  // takes for everyone to be back aboard before the ship turns.
  const arrive = (p: (typeof prep)[number], v: number): number => p.s0 + 2 + 3.2 + lengthOf(p.there) / v
  const turn = (v: number): number => Math.max(...prep.map((p) => arrive(p, v))) + 1.5
  const back = (p: (typeof prep)[number], v: number): number => turn(v) + 1.1 * p.i + lengthOf(p.there) / v + 3.2 + 2
  let speed = 4.2
  while (speed < 8 && prep.some((p) => back(p, speed) > 40)) speed += 0.3
  for (const p of prep) p.stay = Math.max(4 + (p.i % 3), turn(speed) + 1.1 * p.i - arrive(p, speed))

  /** `extra` is how much longer this pirate stays at the building (which is how a pirate who would meet another on the way back waits his turn). */
  const build = (p: (typeof prep)[number], extra: number): { st: Pirate['st']; t1: number; back: number } => {
    const go = along(p.there, speed, 'Run')
    const home = along([...p.there].reverse(), speed, 'Run', { carry: true })
    const s0 = p.s0
    const stay = p.stay + extra
    const dp = onShip(p.off, s0)
    const segs: Seg[] = [
      { d: s0, clip: 'Idle', ...deck(p.off) },
      { d: 2.0, from: dp, to: dockEnd, clip: 'Walk' },
      { d: 3.2, from: dockEnd, to: landPt, clip: 'Walk' },
      ...go,
      { d: stay, from: p.door, faceTo: middleOf(targets[p.ti]), clip: 'Sword' },
      ...home,
      { d: 3.2, from: landPt, to: dockEnd, clip: 'Run', carry: true },
      { d: 2.0, from: dockEnd, to: dp, clip: 'Run', carry: true },
    ]
    const t1 = s0 + 2 + 3.2 + go.reduce((x, sg) => x + sg.d, 0) + stay
    const backAt = t1 + home.reduce((x, sg) => x + sg.d, 0) + 3.2 + 2
    segs.push({ d: Math.max(0.01, 999 - backAt), clip: 'Idle', ...deck(p.off) })
    return { st: seq(0, segs, Math.PI), t1, back: backAt }
  }

  // the crew go out one after another and come back in the same order, each by a door of his own, so nobody walks into anybody
  // one who would meet another on the way back waits a little longer at his door
  const delays = settle(
    prep.map((p) => ({ id: `pirate-${p.i}`, r: 0.6, make: (extra: number) => build(p, extra).st })),
    100,
    { step: 0.5, tries: 80, dt: 0.1 },
  )
  tDep = Math.max(46, ...prep.map((p, k) => build(p, delays[k]).back + 1.5))
  const loop = Math.max(PLOOP, tDep + 20)
  prep.forEach((p, k) => {
    const b = build(p, delays[k])
    pirates.push({ id: `pirate-${p.i}`, target: p.ti, st: b.st, lootFrom: b.t1, lootTo: b.back, kind: p.i % 3 })
  })

  const shotTarget = SHOTS.map((_, k) => k % targets.length)
  const hit = targets.map((_, ti) => Math.min(1e9, ...SHOTS.filter((_, k) => shotTarget[k] === ti).map((ts) => ts + 1.6)))
  return { shore: S, seaward: a, loop, departs: tDep, at, targets, pirates, ship, onShip, hit, shotTarget, dockEnd, landPt }
}

