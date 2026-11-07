// The zombie defence (factory): an armoured car races to a barricade, a horde charges it, fighters outside the barrier cut zombies down
// and some of them fall and get up as zombies, the gunners behind the barricade hold the line, and when it is all quiet a giant comes.
// The story is worked out in zombieScript.ts; this file draws it.

import * as THREE from 'three'
import { Actor, Fire, loadModels, lambert, staticModel } from './models'
import { Gunfire } from './gunfire'
import { clamp, V } from './rig'
import { upright, zombieScript, ZLOOP, type Person, type Weapon } from './zombieScript'
import { Ruin } from './ruin'
import type { BuildContext, EventScene } from './types'

const NAMES = ['ZombieGreen', 'BigArm', 'Matt', 'Sam', 'Shaun', 'Lis', 'ContainerRed', 'ContainerGreen', 'TBarrier', 'Barrier', 'Wheels', 'Couch', 'Barrel', 'Rifle', 'Smg', 'Shotgun', 'Pistol', 'Axe', 'Spear'] as const

/** Where each gun's muzzle is, along the gun's own length. */
const MUZZLE: Record<Weapon, number> = { Rifle: 1.0, Smg: 0.8, Shotgun: 0.97, Pistol: 0.88, Axe: 0, Spear: 0 }

/** An armoured car built from boxes (the packs have none): a hull, a cab, a sloped bonnet, side armour, four wheels and a turret with a gun. */
function armouredCar(): THREE.Group & { turret: THREE.Group } {
  const g = new THREE.Group() as THREE.Group & { turret: THREE.Group }
  const body = new THREE.Group()
  g.add(body)
  const add = (geo: THREE.BufferGeometry, c: number, x: number, y: number, z: number, rx = 0): void => {
    const m = new THREE.Mesh(geo, lambert(c))
    m.position.set(x, y, z)
    m.rotation.x = rx
    m.castShadow = true
    body.add(m)
  }
  add(new THREE.BoxGeometry(2.5, 1.1, 5), 0x4a5a3a, 0, 1.15, 0)
  add(new THREE.BoxGeometry(2.3, 0.6, 2.2), 0x56683f, 0, 1.95, -0.5)
  add(new THREE.BoxGeometry(2.6, 0.7, 1.5), 0x3f4d31, 0, 1.0, 2.7, -0.25)
  add(new THREE.BoxGeometry(2.0, 0.25, 0.12), 0x111418, 0, 2.0, 0.62)
  for (const sx of [-1.28, 1.28]) add(new THREE.BoxGeometry(0.12, 0.9, 3.6), 0x6a6f5a, sx, 1.2, -0.2)
  for (const [x, z] of [[-1.3, 1.6], [1.3, 1.6], [-1.3, -1.6], [1.3, -1.6]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.5, 12), lambert(0x1d1f24))
    w.rotation.z = Math.PI / 2
    w.position.set(x, 0.62, z)
    w.castShadow = true
    g.add(w)
  }
  const turret = new THREE.Group()
  turret.position.set(0, 2.5, -0.4)
  g.add(turret)
  const th = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, 0.5, 10), lambert(0x3f4d31))
  th.castShadow = true
  turret.add(th)
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 1.6), lambert(0x22262c))
  gun.position.set(0, 0.1, 1.0)
  gun.castShadow = true
  turret.add(gun)
  g.turret = turret
  return g
}

export async function buildZombies({ root, arena }: BuildContext): Promise<EventScene> {
  const S = zombieScript(arena)
  const ruin = new Ruin(root, S.targets, 0.6)
  const m = await loadModels('zombies', NAMES)

  // the props
  const fires: Fire[] = []
  for (const p of S.props) {
    const model = m[p.kind]
    const o = staticModel(model, p.height ? { height: p.height, yaw: p.yaw } : { scale: p.scale, yaw: p.yaw })
    o.position.set(p.x, 0, p.z)
    root.add(o)
    if (p.fire) {
      const f = new Fire(0.85, fires.length * 3.1)
      f.root.position.set(p.x, 1.35, p.z)
      root.add(f.root)
      fires.push(f)
    }
  }

  const cars = S.cars.map(() => {
    const c = armouredCar()
    root.add(c)
    return c
  })

  // the people
  const actors = S.people.map((p, i) => {
    const a = new Actor(m[p.model], { h: p.h, off: (i * 0.37) % 2 })
    root.add(a.root)
    let muzzle: THREE.Object3D | null = null
    if (p.weapon) {
      const gun = staticModel(m[p.weapon], { scale: 1 })
      // held at the shoulder with its butt against the body, lined up with the way the character faces
      const holder = a.attach(gun, /^Index1\.?R$/, V(0, p.weapon === 'Axe' || p.weapon === 'Spear' ? 0.1 : 0.22, 0.22), new THREE.Euler(0, 0, 0), { clip: 'Idle_Gun', time: 0.3 })
      void holder
      if (MUZZLE[p.weapon] > 0) {
        muzzle = new THREE.Object3D()
        muzzle.position.set(0, 0, MUZZLE[p.weapon])
        gun.add(muzzle)
      }
    }
    return { p, a, muzzle }
  })
  const byId = new Map(actors.map((x) => [x.p.id, x]))

  const owner = S.armoury.shooters.map((_, i) => actors.find((x) => x.p.shooters.includes(i))?.p.id ?? null)

  const muzzleOf = (i: number, to: THREE.Vector3): THREE.Vector3 => {
    const id = owner[i]
    if (id) {
      const o = byId.get(id)!
      if (o.muzzle) {
        o.a.root.updateMatrixWorld(true)
        return o.muzzle.getWorldPosition(V())
      }
      return o.a.root.position.clone().add(V(0, 1.45, 0))
    }
    const car = cars[S.armoury.shooters[i].id === 'car-a' ? 0 : 1]
    const dir = V(to.x - car.position.x, 0, to.z - car.position.z).normalize()
    return car.position.clone().add(V(0, 2.65, 0)).addScaledVector(dir, 1.7)
  }

  const fire = new Gunfire(root, S.armoury, (i, to) => muzzleOf(i, to), (i) => (S.armoury.shooters[i].id.startsWith('car') ? 1.3 : 1))

  const update = (t: number): void => {
    cars.forEach((c, i) => {
      const car = S.cars[i]
      c.visible = t >= car.since
      c.position.copy(car.pos(t))
      c.rotation.y = car.yaw(t)
    })
    for (const { p, a } of actors) {
      const st = p.st(t)
      if (st && p.shooters.length && st.clip === 'Idle_Gun') {
        const to = fire.aim(p.shooters, t)
        if (to) st.yaw = Math.atan2(to.x - st.pos.x, to.z - st.pos.z)
      }
      const recoil = fire.recoil(p.shooters, t)
      a.recoil = recoil
      a.apply(st)
    }
    fire.update(t)
    // a car's turret follows what it shoots at
    S.armoury.shooters.forEach((sh, i) => {
      if (!sh.id.startsWith('car')) return
      let aim: THREE.Vector3 | null = null
      for (const s of S.armoury.of(i)) if (s.t <= t + 0.2) aim = s.to
      const k = sh.id === 'car-a' ? 0 : 1
      if (aim) cars[k].turret.rotation.y = Math.atan2(aim.x - cars[k].position.x, aim.z - cars[k].position.z) - S.cars[k].yaw(t)
    })
    fires.forEach((f) => f.update(t))
    ruin.update(t, (i) => S.hit[i])
  }

  return {
    id: 'zombies',
    title: 'Zombie defence',
    loop: ZLOOP,
    update: (t) => update(clamp(t, 0, ZLOOP)),
    camera: { pos: V(S.barricade.x + Math.sin(S.seaward) * 34 + Math.cos(S.seaward) * 12, 17, S.barricade.z + Math.cos(S.seaward) * 34 - Math.sin(S.seaward) * 12), target: V(S.barricade.x, 1.5, S.barricade.z) },
    caption: (t) =>
      t < 8 ? 'An armoured car races to the barricade' :
      t < 32 ? 'The horde hits the line. Fighters hold it outside the barrier' :
      t < 42 ? 'The fallen get up again as zombies' :
      t < S.bossStart ? 'Quiet. They think it is over' :
      t < S.bossStart + 6 ? 'Something much bigger is coming' :
      t < S.bossFall ? 'Everyone opens fire on the giant' : 'The giant falls',
    inspect: (t) => {
      const up = (r: Person['role']): number => S.people.filter((p) => p.role === r && upright(p, t)).length
      return {
        horde: up('horde'),
        turned: up('turned'),
        boss: up('boss'),
        fighters: up('fighter'),
        defenders: up('defender'),
        shotsFired: S.armoury.shots.filter((s) => s.t <= t).length,
        damaged: S.hit.filter((h) => t > h).length,
      }
    },
    hits: () => Object.fromEntries(S.targets.map((b, i) => [b.id, S.hit[i]])),
  }
}
