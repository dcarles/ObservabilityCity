// The pirate raid (harbour town): a ship sails in and moors at a jetty, eight pirates land and run to four buildings, the ship's cannon
// bombards them, and the crew carry gold, chests and rum back aboard before the ship sails away loaded.

import * as THREE from 'three'
import { palette } from '../themes/active'
import { Actor, glowMat, loadModels, Puffs, staticModel } from './models'
import { clamp, ease, lerp, seq, V, type Seg } from './rig'
import { EVENT_COLOURS as C } from './colours'
import { island } from './world'
import type { BuildContext, EventScene } from './types'

const LOOP = 66
const Y = V(0, 1, 0)
const SHOTS = [13.5, 17, 20.5, 24]
const SHIP_X = 12.6
const SHIP_Z = 20.5
const DECK = 3.1
const DOCK_Y = 0.7

export async function buildPirates({ root }: BuildContext): Promise<EventScene> {
  island(root, 44, 26, palette.island.grass)
  const m = await loadModels('pirates', ['Ship', 'Cannon', 'Dock', 'Tower', 'Tavern', 'Palm', 'Barrel', 'GoldBag', 'Rocks', 'Chest', 'Captain', 'Sharky', 'Skeleton'] as const)
  const crew = [m.Captain, m.Sharky, m.Skeleton]
  const upd: ((t: number) => void)[] = []

  // buildings: [model, x, z, depth, height]
  const HDEF: [typeof m.Tower, number, number, number, number][] = [[m.Tower, -17, -3, 3.7, 9.4], [m.Tower, -9, 3, 3.7, 9.4], [m.Tower, -1, -6, 3.7, 9.4], [m.Tavern, 8, -6, 4.6, 6.8]]
  const HOUSES = HDEF.map(([, x, z]) => V(x, 0, z))
  const hs = HDEF.map(([g, x, z, dp, ht]) => {
    const h = staticModel(g, { scale: 1 })
    h.position.set(x, 0, z)
    root.add(h)
    const fire = new THREE.Mesh(new THREE.ConeGeometry(1.1, 2.8, 6), glowMat(C.houseFire, { opacity: 0 }))
    fire.position.set(x, ht * 0.85, z)
    fire.visible = false
    root.add(fire)
    return { h, fire, p: V(x, 0, z), ht, dp, hit: 1e9 }
  })
  for (const [x, z] of [[-19, 6], [-14, 9], [4, 6], [13, 3], [-5, 8], [16, -4]]) {
    const t = staticModel(m.Palm, { scale: 1 })
    t.position.set(x, 0, z)
    root.add(t)
  }
  for (const [x, z] of [[-3.5, 3], [3.5, 4], [-12, -5.5]]) {
    const b = staticModel(m.Barrel, { scale: 1 })
    b.position.set(x, 0, z)
    root.add(b)
  }
  for (const [x, z] of [[18, -9], [-20, 10]]) {
    const r = staticModel(m.Rocks, { maxDim: 3 })
    r.position.set(x, 0, z)
    root.add(r)
  }
  // the jetty runs along z from the island's edge out to sea
  for (let k = 0; k < 4; k++) {
    const dk = staticModel(m.Dock, { scale: 1 })
    dk.position.set(8.2, -1.3, 13.2 + k * 2.7)
    root.add(dk)
  }

  const shipState = (t: number): { pos: THREE.Vector3; yaw: number } => {
    let pos: THREE.Vector3
    let yaw = Math.PI
    if (t < 12) {
      const k = 1 - Math.pow(1 - t / 12, 2.2)
      pos = V(SHIP_X, 0, lerp(70, SHIP_Z, k))
    } else if (t < 46) pos = V(SHIP_X, 0, SHIP_Z)
    else if (t < 52) {
      pos = V(SHIP_X, 0, SHIP_Z)
      yaw = lerp(Math.PI, Math.PI / 2, ease((t - 46) / 6))
    } else {
      const k = (t - 52) / 14
      pos = V(SHIP_X + k * k * 90, 0, SHIP_Z)
      yaw = Math.PI / 2
    }
    pos.y = 0.1 + Math.sin(t * 1.3) * 0.08
    return { pos, yaw }
  }
  const sh = staticModel(m.Ship, { scale: 1 })
  root.add(sh)
  const onShip = (off: THREE.Vector3): Pick<Seg, 'fn' | 'yawFn'> => ({
    fn: (t) => {
      const s = shipState(t)
      return s.pos.clone().add(V(off.x, DECK, off.z).applyAxisAngle(Y, s.yaw - Math.PI))
    },
    yawFn: (t) => shipState(t).yaw,
  })
  const can = staticModel(m.Cannon, { scale: 1.1 })
  root.add(can)
  const F = new Puffs(root)
  const ball = F.make(C.cannonBall)
  const flash = F.make(C.cannonFlash)
  const smoke = [0, 1, 2, 3].map(() => F.make(C.cannonSmoke))
  const boom = HOUSES.map(() => F.make(C.cannonBoom))

  const dockEnd = V(9.4, DOCK_Y, 18.2)
  const landPt = V(8.4, 0, 10.5)
  const actors: { a: Actor; st: ReturnType<typeof seq> }[] = []
  const loot: { b: THREE.Group; i: number; t0: number; t1: number }[] = []
  for (let i = 0; i < 8; i++) {
    const a = new Actor(crew[i % 3], { h: 2.5, off: i * 0.37 })
    root.add(a.root)
    const hi = i % 4
    const door = HOUSES[hi].clone().add(V(i < 4 ? -1.1 : 1.1, 0, hs[hi].dp / 2 + 1.6))
    const off = V(-0.2 + (i % 2) * 1.4, 0, -5.4 + i * 1.5)
    const s0 = 13.5 + i * 0.9
    const stay = 4 + (i % 3)
    const dp = onShip(off).fn!(s0)
    const segs: Seg[] = [
      { d: s0, clip: 'Idle', ...onShip(off) },
      { d: 2.0, from: dp, to: dockEnd, clip: 'Walk' },
      { d: 3.2, from: dockEnd, to: landPt, clip: 'Walk' },
      { d: 5.5, from: landPt, to: door, clip: 'Run' },
      { d: stay, from: door, faceTo: HOUSES[hi], clip: 'Sword' },
    ]
    const t1 = s0 + 2 + 3.2 + 5.5 + stay
    segs.push({ d: 5.8, from: door, to: landPt, clip: 'Run', carry: true }, { d: 3.2, from: landPt, to: dockEnd, clip: 'Run', carry: true }, { d: 2.0, from: dockEnd, to: dp, clip: 'Run', carry: true })
    const back = t1 + 5.8 + 3.2 + 2.0
    segs.push({ d: LOOP - back + 0.01, clip: 'Idle', ...onShip(off) })
    actors.push({ a, st: seq(0, segs, Math.PI) })
    const kind = i % 3
    const b = staticModel(kind === 0 ? m.GoldBag : kind === 1 ? m.Chest : m.Barrel, kind === 1 ? { scale: 0.9 } : { scale: kind === 0 ? 1.1 : 1 })
    root.add(b)
    loot.push({ b, i, t0: t1, t1: back })
  }
  const pile = (i: number): THREE.Vector3 => V(-0.9 + (i % 2) * 1.8, DECK, -3.2 + (i >> 1) * 1.9)
  const cpOff = V(-2.0, DECK + 0.2, 3.0)
  upd.push((t) => {
    const s = shipState(t)
    sh.position.copy(s.pos)
    sh.rotation.y = s.yaw + Math.PI / 2
    const cp = s.pos.clone().add(cpOff.clone().applyAxisAngle(Y, s.yaw - Math.PI))
    can.position.copy(cp)
    can.rotation.y = s.yaw
    actors.forEach((o) => o.a.apply(o.st(t)))
    loot.forEach((l) => {
      const st = actors[l.i].st(t)
      if (t < l.t0 || !st) {
        l.b.visible = false
        return
      }
      l.b.visible = true
      if (t < l.t1) {
        const p = st.pos.clone()
        p.y += 2.3
        l.b.position.copy(p)
      } else {
        const s2 = shipState(t)
        l.b.position.copy(s2.pos.clone().add(pile(l.i).applyAxisAngle(Y, s2.yaw - Math.PI)))
      }
    })
    let fl = 0
    SHOTS.forEach((ts, k) => {
      const hi = k % HOUSES.length
      const target = HOUSES[hi].clone().add(V(0, hs[hi].ht * 0.6, hs[hi].dp / 2))
      const dt = t - ts
      if (dt >= 0 && dt < 0.25) fl = 1 - dt / 0.25
      if (dt >= 0 && dt < 1.6) {
        const u = dt / 1.6
        const from = cp.clone().add(V(-1.2, 0.3, 0))
        const p = from.clone().lerp(target, u)
        p.y += Math.sin(u * Math.PI) * 8
        F.set(ball, p, 0.35, 1)
      }
      if (dt >= 1.6 && dt < 2.5) F.set(boom[hi], target, 1 + (dt - 1.6) * 6, 1 - (dt - 1.6) / 0.9)
    })
    if (!SHOTS.some((ts) => t - ts >= 0 && t - ts < 1.6)) F.set(ball, V(), 0, 0)
    boom.forEach((b, i) => {
      if (!SHOTS.some((ts, k) => k % HOUSES.length === i && t - ts >= 1.6 && t - ts < 2.5)) F.set(b, V(), 0, 0)
    })
    hs.forEach((h) => (h.hit = 1e9))
    SHOTS.forEach((ts, k) => {
      const h = hs[k % HOUSES.length]
      h.hit = Math.min(h.hit, ts + 1.6)
    })
    F.set(flash, cp.clone().add(V(-1.8, 0.4, 0)), 0.8 * fl + 0.01, fl)
    hs.forEach((h, i) => {
      const dt = t - h.hit
      const shake = dt > 0 && dt < 1.5 ? Math.exp(-dt * 3) * 0.14 : 0
      h.h.position.set(h.p.x + Math.sin(t * 60) * shake, 0, h.p.z)
      h.h.rotation.z = Math.sin(t * 50) * shake * 0.15
      if (dt > 0) {
        h.fire.visible = true
        ;(h.fire.material as THREE.MeshBasicMaterial).opacity = 0.75
        const f = 1 + 0.25 * Math.sin(t * 14 + i * 2)
        h.fire.scale.set(f, f * 1.2, f)
      } else h.fire.visible = false
    })
    smoke.forEach((sm, k) => {
      const h = hs.find((x) => t > x.hit)
      if (!h) {
        F.set(sm, V(), 0, 0)
        return
      }
      const dt = ((t - h.hit) * 0.6 + k * 0.25) % 1
      F.set(sm, V(h.p.x + Math.sin(k * 2) * 0.5, h.ht * 0.8 + dt * 6, h.p.z), 0.7 + dt * 1.6, 0.55 * (1 - dt))
    })
  })

  return {
    id: 'pirates',
    title: 'Pirate raid',
    radius: 30,
    loop: LOOP,
    update: (t) => upd.forEach((f) => f(clamp(t, 0, LOOP))),
    camera: { pos: V(0, 20, 54), target: V(6, 2, 8) },
    caption: (t) => (t < 12 ? 'A pirate ship sails in' : t < 20 ? 'Crew disembark and spread out' : t < 28 ? 'Cannon fire and raiding' : t < 46 ? 'Gold, chests and rum carried back to the ship' : 'The ship sails off loaded with plunder'),
    inspect: (t) => ({
      shipZ: shipState(t).pos.z,
      shipX: shipState(t).pos.x,
      burning: hs.filter((h) => t > h.hit).length,
      ashore: actors.filter((o) => (o.st(t)?.pos.y ?? 9) < 0.5 && (o.st(t)?.pos.z ?? 99) < 12).length,
      looted: loot.filter((l) => t >= l.t0).length,
    }),
  }
}
