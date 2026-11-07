// The alien invasion (space): saucers arrive over the town and open fire, tractor beams drop aliens that walk the streets punching buildings,
// and astronauts and survivors on the road below shoot up at the saucers and at the aliens. One saucer is hit and limps away.
// The story is worked out in alienScript.ts; this file draws it.

import * as THREE from 'three'
import { Actor, Beam, glowMat, loadModel, loadModels, Puffs, staticModel } from './models'
import { Gunfire } from './gunfire'
import { alienScript, ALOOP, standing } from './alienScript'
import { clamp, V } from './rig'
import { EVENT_COLOURS as C } from './colours'
import { Ruin } from './ruin'
import type { BuildContext, EventScene } from './types'

const SPACE = ['EnemyLarge', 'EnemyFlying', 'EnemySmall', 'MechBee', 'Spaceship1', 'Spaceship2', 'Spaceship3', 'AstroA', 'AstroC'] as const
const MUZZLE = { Rifle: 1.0, Smg: 0.8 }

export async function buildAliens({ root, arena }: BuildContext): Promise<EventScene> {
  const S = alienScript(arena)
  const ruin = new Ruin(root, S.targets, 0.7)
  const m = await loadModels('aliens', SPACE)
  const human = await loadModels('zombies', ['Matt', 'Sam', 'Rifle', 'Smg'] as const)
  void loadModel
  const models: Record<string, import('three/examples/jsm/loaders/GLTFLoader.js').GLTF> = { ...m, ...human }
  const P = new Puffs(root)

  const ships = S.saucers.map((s, i) => {
    const g = staticModel([m.Spaceship1, m.Spaceship2, m.Spaceship3][i], { maxDim: 8 })
    root.add(g)
    const laser = new Beam(root, i === 1 ? C.laserRed : C.laserGreen)
    const tractor = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 2.6, 1, 16, 1, true), glowMat(C.tractor, { opacity: 0, side: THREE.DoubleSide }))
    tractor.visible = false
    root.add(tractor)
    const smoke = [0, 1, 2, 3, 4].map(() => P.make(0x333333))
    return { s, g, laser, tractor, flash: P.make(C.cannonFlash), smoke }
  })

  const actors = S.walkers.map((w, i) => {
    const a = new Actor(models[w.model], { h: w.h, off: (i * 0.41) % 2 })
    root.add(a.root)
    let muzzle: THREE.Object3D | null = null
    if (w.weapon) {
      const gun = staticModel(models[w.weapon], { scale: 1 })
      a.attach(gun, /^Index1\.?R$/, V(0, 0.22, 0.22), new THREE.Euler(0, 0, 0), { clip: 'Idle_Gun', time: 0.3 })
      muzzle = new THREE.Object3D()
      muzzle.position.set(0, 0, MUZZLE[w.weapon])
      gun.add(muzzle)
    }
    return { w, a, muzzle }
  })
  const byShooter = S.armoury.shooters.map((_, i) => actors.find((x) => x.w.shooters.includes(i))!)
  const fire = new Gunfire(root, S.armoury, (i, to) => {
    const o = byShooter[i]
    o.a.root.updateMatrixWorld(true)
    return o.muzzle ? o.muzzle.getWorldPosition(V()) : o.a.root.position.clone().add(V(0, 1.45, to.y > 4 ? 0 : 0))
  }, () => 1, (target) => (target.startsWith('saucer') ? C.impact : C.laserGreen))

  // flying aliens circle their saucers
  const fliers = S.fliers.map((f, k) => {
    const a = new Actor(models[f.model], { h: 2.6, off: k * 0.3 })
    root.add(a.root)
    return { f, a }
  })

  // the mech stands on the road to the north and fires at the saucers
  const mech = new Actor(m.MechBee, { h: 4.8 })
  root.add(mech.root)
  const mp = S.mech
  const mechBeam = new Beam(root, C.laserGreen)

  // stars
  const sp: number[] = []
  for (let i = 0; i < 160; i++) sp.push(arena.centre.x + Math.sin(i * 12.9) * 120, 40 + ((i * 37) % 60), arena.centre.z + Math.cos(i * 7.3) * 120)
  const sg = new THREE.BufferGeometry()
  sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3))

  const update = (t: number): void => {
    ruin.update(t, (i) => S.hit[i])
    ships.forEach(({ s, g, laser, tractor, flash, smoke }, i) => {
      const p = s.pos(t)
      g.position.copy(p)
      g.rotation.y = t * 0.35 + i
      g.rotation.z = s.roll(t)
      const on = t > 4 + i * 0.6 && t < s.leaves
      const per = 1.6
      const n = Math.floor((t + i * 0.5) / per)
      const fr = (t + i * 0.5) / per - n
      const tg = V(arena.centre.x + Math.sin(n * 7 + i * 13) * arena.reach * 0.5, 0.4, arena.centre.z + Math.cos(n * 5 + i * 3) * arena.reach * 0.4)
      if (on && fr < 0.3) {
        laser.aim(p.clone().add(V(0, -0.6, 0)), tg, 0.09, 0.95)
        P.set(flash, tg, 0.4 + fr * 5, 1 - fr / 0.3)
      } else {
        laser.visible = false
        P.hide(flash)
      }
      const dr = s.drop - 0.6
      if (t > dr && t < dr + 3.4) {
        tractor.visible = true
        tractor.position.set(s.spot.x, p.y / 2, s.spot.z)
        tractor.scale.set(1, p.y, 1)
        ;(tractor.material as THREE.MeshBasicMaterial).opacity = 0.35 * Math.sin(clamp((t - dr) / 3.4) * Math.PI)
      } else tractor.visible = false
      // the hit saucer smokes
      smoke.forEach((sm, k) => {
        if (!s.hit || t < 30 || t > s.leaves + 6) {
          P.hide(sm)
          return
        }
        const u = ((t - 30) * 0.8 + k * 0.2) % 1
        P.set(sm, p.clone().add(V(Math.sin(k * 3) * 0.6, -1 - u * 2.5, Math.cos(k * 2) * 0.6)), 0.5 + u * 1.4, 0.55 * (1 - u))
      })
    })
    S.walkers.forEach((w, i) => {
      const { a } = actors[i]
      const st = w.st(t)
      if (st && w.role === 'defender' && st.clip === 'Idle_Gun') {
        const to = fire.aim(w.shooters, t)
        if (to) {
          st.yaw = Math.atan2(to.x - st.pos.x, to.z - st.pos.z)
          const horiz = Math.hypot(to.x - st.pos.x, to.z - st.pos.z)
          a.pitch = clamp(Math.atan2(to.y - 1.4, horiz), 0, 1) * 0.32
        } else a.pitch = 0
      } else a.pitch = 0
      a.recoil = fire.recoil(w.shooters, t)
      a.apply(st)
    })
    fire.update(t)
    fliers.forEach(({ f, a }, k) => {
      const sh = S.saucers[f.saucer]
      const c = sh.pos(t)
      const an = t * 1.3 + f.phase
      a.apply({ pos: c.clone().add(V(Math.cos(an) * 4.5, -1.2 + Math.sin(t * 2 + k) * 0.6, Math.sin(an) * 4.5)), yaw: -an + Math.PI, clip: 'Fast_Flying', ct: t, rate: 1, hold: false, hide: false, carry: false })
    })
    mech.apply({ pos: mp, yaw: Math.atan2(S.saucers[0].hover.x - mp.x, S.saucers[0].hover.z - mp.z), clip: 'Shoot_Big', ct: t, rate: 1, hold: false, hide: false, carry: false })
    const per = 1.5
    const fr = (t % per) / per
    if (fr < 0.25 && t > 5 && t < S.saucers[0].leaves) mechBeam.aim(V(mp.x, 2.6, mp.z), S.saucers[0].pos(t).add(V(0, -0.5, 0)), 0.07, 0.9)
    else mechBeam.visible = false
  }

  root.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.6, fog: false })))

  return {
    id: 'aliens',
    title: 'Alien invasion',
    loop: ALOOP,
    update: (t) => update(clamp(t, 0, ALOOP)),
    camera: { pos: V(arena.centre.x + Math.sin(arena.src.seaward) * arena.reach * 1.5, 26, arena.centre.z + Math.cos(arena.src.seaward) * arena.reach * 1.5), target: V(arena.centre.x, 6, arena.centre.z) },
    caption: (t) => (t < 6 ? 'Saucers arrive and open fire' : t < 16 ? 'Tractor beams drop the invaders' : t < 36 ? 'Astronauts and survivors fire back' : t < 50 ? 'One saucer is hit and limps away' : 'The invaders retreat'),
    inspect: (t) => ({
      aliens: S.walkers.filter((w) => w.role === 'alien' && standing(w, t)).length,
      defenders: S.walkers.filter((w) => w.role === 'defender' && standing(w, t)).length,
      saucers: S.saucers.filter((s) => s.pos(t).y < 30).length,
      shotsFired: S.armoury.shots.filter((s) => s.t <= t).length,
      damaged: S.hit.filter((h) => t > h).length,
    }),
    hits: () => Object.fromEntries(S.targets.map((b, i) => [b.id, S.hit[i]])),
  }
}
