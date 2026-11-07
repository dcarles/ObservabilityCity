// The pirate raid (harbour town) on a real island: a ship sails in and moors at a jetty, eight pirates land and run to four of the island's own
// buildings, the ship's cannon bombards them, and the crew carry gold, chests and rum back aboard before the ship sails away loaded.
// The story is worked out in pirateScript.ts; this file draws it. The buildings are the town's own: only fire and scorch are laid over them.

import * as THREE from 'three'
import { Actor, loadModels, Puffs, staticModel } from './models'
import { middleOf } from './arena'
import { clamp, V } from './rig'
import { EVENT_COLOURS as C } from './colours'
import { pirateScript, SHOTS, DECK } from './pirateScript'
import { Ruin } from './ruin'
import type { BuildContext, EventScene } from './types'

export async function buildPirates({ root, arena }: BuildContext): Promise<EventScene> {
  const S = pirateScript(arena)
  const m = await loadModels('pirates', ['Ship', 'Cannon', 'Dock', 'Palm', 'Barrel', 'GoldBag', 'Rocks', 'Chest', 'Captain', 'Sharky', 'Skeleton'] as const)
  const crew = [m.Captain, m.Sharky, m.Skeleton]
  // the harbour: the jetty runs out from the coast, in the harbour's own turn
  const harbour = new THREE.Group()
  harbour.position.copy(S.at(0, 13))
  harbour.rotation.y = S.seaward
  root.add(harbour)
  for (let k = 0; k < 4; k++) {
    const dk = staticModel(m.Dock, { scale: 1 })
    dk.position.set(8.2, -1.3, 0.2 + k * 2.7)
    harbour.add(dk)
  }
  const rocks = staticModel(m.Rocks, { maxDim: 3 })
  rocks.position.copy(S.at(18, 12))
  root.add(rocks)

  const Y = V(0, 1, 0)
  const sh = staticModel(m.Ship, { scale: 1 })
  root.add(sh)
  const can = staticModel(m.Cannon, { scale: 1.1 })
  root.add(can)
  const F = new Puffs(root)
  const ball = F.make(C.cannonBall)
  const flash = F.make(C.cannonFlash)
  const smoke = [0, 1, 2, 3].map(() => F.make(C.cannonSmoke))
  const boom = S.targets.map(() => F.make(C.cannonBoom))
  const ruin = new Ruin(root, S.targets)
  const cpOff = V(-2.0, DECK + 0.2, 3.0)

  const crewActors = S.pirates.map((p, i) => {
    const a = new Actor(crew[i % 3], { h: 2.5, off: i * 0.37 })
    root.add(a.root)
    const kind = p.kind
    const b = staticModel(kind === 0 ? m.GoldBag : kind === 1 ? m.Chest : m.Barrel, kind === 1 ? { scale: 0.9 } : { scale: kind === 0 ? 1.1 : 1 })
    root.add(b)
    return { p, a, b }
  })
  const pile = (i: number): THREE.Vector3 => V(-0.9 + (i % 2) * 1.8, DECK, -3.2 + (i >> 1) * 1.9)
  const aim = S.targets.map((b) => middleOf(b).setY(b.h * 0.6))

  const update = (t: number): void => {
    const s = S.ship(t)
    sh.position.copy(s.pos)
    sh.rotation.y = s.yaw + Math.PI / 2
    const cp = s.pos.clone().add(cpOff.clone().applyAxisAngle(Y, s.yaw - Math.PI))
    can.position.copy(cp)
    can.rotation.y = s.yaw
    for (const { p, a, b } of crewActors) {
      const st = p.st(t)
      a.apply(st)
      if (t < p.lootFrom || !st) {
        b.visible = false
        continue
      }
      b.visible = true
      if (t < p.lootTo) b.position.copy(st.pos).add(V(0, 2.3, 0))
      else b.position.copy(s.pos.clone().add(pile(crewActors.findIndex((x) => x.p === p)).applyAxisAngle(Y, s.yaw - Math.PI)))
    }
    let fl = 0
    SHOTS.forEach((ts, k) => {
      const hi = S.shotTarget[k]
      const dt = t - ts
      if (dt >= 0 && dt < 0.25) fl = 1 - dt / 0.25
      if (dt >= 0 && dt < 1.6) {
        const u = dt / 1.6
        const p = cp.clone().add(V(-1.2, 0.3, 0)).lerp(aim[hi], u)
        p.y += Math.sin(u * Math.PI) * 8
        F.set(ball, p, 0.35, 1)
      }
      if (dt >= 1.6 && dt < 2.5) F.set(boom[hi], aim[hi], 1 + (dt - 1.6) * 6, 1 - (dt - 1.6) / 0.9)
    })
    if (!SHOTS.some((ts) => t - ts >= 0 && t - ts < 1.6)) F.set(ball, V(), 0, 0)
    boom.forEach((b, i) => {
      if (!SHOTS.some((ts, k) => S.shotTarget[k] === i && t - ts >= 1.6 && t - ts < 2.5)) F.set(b, V(), 0, 0)
    })
    F.set(flash, cp.clone().add(V(-1.8, 0.4, 0)), 0.8 * fl + 0.01, fl)
    ruin.update(t, (i) => S.hit[i])
    smoke.forEach((sm, k) => {
      const i = S.hit.findIndex((h) => t > h)
      if (i < 0) {
        F.set(sm, V(), 0, 0)
        return
      }
      const b = S.targets[i]
      const dt = ((t - S.hit[i]) * 0.6 + k * 0.25) % 1
      F.set(sm, V(middleOf(b).x + Math.sin(k * 2) * 0.5, b.h * 0.8 + dt * 6, middleOf(b).z), 0.7 + dt * 1.6, 0.55 * (1 - dt))
    })
  }

  // the camera: out to sea beside the jetty, looking in at the landing
  const cam = { pos: S.at(-6, 52, 22), target: S.at(2, 8, 2) }
  return {
    id: 'pirates',
    title: 'Pirate raid',
    loop: S.loop,
    update: (t) => update(clamp(t, 0, S.loop)),
    camera: cam,
    caption: (t) => (t < 12 ? 'A pirate ship sails in' : t < 20 ? 'Crew disembark and spread out' : t < 28 ? 'Cannon fire and raiding' : t < S.departs ? 'Gold, chests and rum carried back to the ship' : 'The ship sails off loaded with plunder'),
    inspect: (t) => ({
      shipZ: S.ship(t).pos.z,
      shipX: S.ship(t).pos.x,
      burning: S.hit.filter((h) => t > h).length,
      ashore: S.pirates.filter((p) => (p.st(t)?.pos.y ?? 9) < 0.5).length,
      looted: S.pirates.filter((p) => t >= p.lootFrom).length,
    }),
    hits: () => Object.fromEntries(S.targets.map((b, i) => [b.id, S.hit[i]])),
  }
}
