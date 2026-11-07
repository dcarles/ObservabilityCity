// Loading the event models and the few things an event draws that are not models: characters that play a clip, props fitted to a size, and
// the effects (fire, muzzle flashes, bullets, beams).

import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { V, type ActorState } from './rig'
import { EVENT_COLOURS as C } from './colours'

export type EventDir = 'pirates' | 'zombies' | 'aliens'

const cache = new Map<string, Promise<GLTF>>()

/** One model file of an event, loaded once. */
export function loadModel(dir: EventDir, name: string): Promise<GLTF> {
  const url = `/events/${dir}/${name}.glb`
  let p = cache.get(url)
  if (!p) {
    p = new GLTFLoader().loadAsync(url)
    cache.set(url, p)
  }
  return p
}

/** Several model files at once, by name. */
export async function loadModels<K extends string>(dir: EventDir, names: readonly K[]): Promise<Record<K, GLTF>> {
  const all = await Promise.all(names.map((n) => loadModel(dir, n)))
  return Object.fromEntries(names.map((n, i) => [n, all[i]])) as Record<K, GLTF>
}

/** Clip names come as `CharacterArmature|Run`; the part after the bar is the name an event uses. */
const clipKey = (n: string): string => n.split('|').filter((x) => x && !/Armature$/.test(x))[0] || n

/** The size of a skinned model from its bones. A skinned mesh's own box is the pose it was exported in, which is not the size it is drawn at. */
function boneBox(o: THREE.Object3D): THREE.Box3 {
  o.updateMatrixWorld(true)
  const bb = new THREE.Box3()
  let n = 0
  o.traverse((c) => {
    if ((c as THREE.Bone).isBone) {
      bb.expandByPoint(V().setFromMatrixPosition(c.matrixWorld))
      n++
    }
  })
  if (n > 2) {
    bb.expandByScalar(bb.getSize(V()).y * 0.06)
    return bb
  }
  return new THREE.Box3().setFromObject(o)
}

function shade(o: THREE.Object3D): void {
  o.traverse((m) => {
    if ((m as THREE.Mesh).isMesh) {
      m.castShadow = true
      m.frustumCulled = false
    }
  })
}

/** An animated character: feet at the origin, facing +z, scaled to a height. It plays whichever clip the timeline asks for, at the time it asks for. */
export class Actor {
  readonly root = new THREE.Group()
  /** Leans the character back (radians), for shooting upward. */
  pitch = 0
  private readonly inner: THREE.Object3D
  private readonly mixer: THREE.AnimationMixer
  private readonly actions = new Map<string, { a: THREE.AnimationAction; d: number }>()
  private readonly clips = new Map<string, THREE.AnimationClip>()
  private current: string | null = null
  private readonly offset: number
  /** How far the character is pushed back by a shot (set by whoever fires), decays on its own. */
  recoil = 0

  constructor(g: GLTF, opts: { h?: number; off?: number } = {}) {
    this.offset = opts.off ?? 0
    this.inner = cloneSkinned(g.scene)
    // the survivors carry a knife of their own; an event gives them a weapon of its choosing
    this.inner.traverse((c) => { if (/^knife$/i.test(c.name)) c.visible = false })
    shade(this.inner)
    const bb = boneBox(this.inner)
    const sz = bb.getSize(V())
    const c = bb.getCenter(V())
    const k = (opts.h ?? 1.8) / Math.max(sz.y, 1e-3)
    this.inner.scale.setScalar(k)
    this.inner.position.set(-c.x * k, -bb.min.y * k, -c.z * k)
    this.root.add(this.inner)
    // turn first, then lean: a lean is about the character's own sideways axis whichever way it faces
    this.root.rotation.order = 'YXZ'
    this.mixer = new THREE.AnimationMixer(this.inner)
    for (const cl of g.animations) this.clips.set(clipKey(cl.name), cl)
  }

  has(clip: string): boolean {
    return this.clips.has(clip)
  }

  private action(key: string): { a: THREE.AnimationAction; d: number } | null {
    let o = this.actions.get(key)
    if (!o) {
      const cl = this.clips.get(key)
      if (!cl) return null
      const a = this.mixer.clipAction(cl)
      a.play()
      a.setEffectiveWeight(0)
      o = { a, d: cl.duration }
      this.actions.set(key, o)
    }
    return o
  }

  /**
   * Puts a prop in a hand (or any bone), lined up with the character in the given pose: the prop's own axes follow the character's (its +z
   * points where the character faces), whatever way the bone happens to be turned. `offset` and `turn` then adjust it. Returns the holder.
   */
  attach(prop: THREE.Object3D, bone: RegExp, offset: THREE.Vector3, turn: THREE.Euler, pose?: { clip: string; time: number }): THREE.Object3D {
    let hand: THREE.Object3D | null = null
    this.inner.traverse((c) => {
      if (!hand && (c as THREE.Bone).isBone && bone.test(c.name)) hand = c
    })
    const holder = new THREE.Group()
    holder.add(prop)
    const parent = hand ?? this.root
    parent.add(holder)
    const home = this.root.position.clone()
    if (pose) this.apply({ pos: V(), yaw: 0, clip: pose.clip, ct: pose.time, rate: 1, hold: false, hide: false, carry: false })
    this.root.updateMatrixWorld(true)
    this.current = null
    // a bone sits inside the model's own scale (a rig is often drawn in centimetres): undo it, so the prop keeps its own size
    const sc = parent.getWorldScale(V())
    holder.scale.set(1 / sc.x, 1 / sc.y, 1 / sc.z)
    const rel = this.root.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(parent.getWorldQuaternion(new THREE.Quaternion()))
    holder.quaternion.copy(rel.invert()).multiply(new THREE.Quaternion().setFromEuler(turn))
    // the offset is in the character's own space (up, forward), not the bone's
    holder.updateMatrixWorld(true)
    const at = parent.getWorldPosition(V()).add(offset)
    holder.position.copy(parent.worldToLocal(at))
    this.root.position.copy(home)
    return holder
  }

  apply(st: ActorState | null): void {
    if (!st || st.hide) {
      this.root.visible = false
      return
    }
    this.root.visible = true
    this.root.position.copy(st.pos)
    this.root.rotation.y = st.yaw
    this.root.rotation.x = -this.pitch
    if (this.recoil > 0.001) {
      const back = V(0, 0, -this.recoil).applyAxisAngle(V(0, 1, 0), st.yaw)
      this.root.position.add(back)
      this.root.rotation.x -= this.recoil * 0.5
    }
    const key = this.clips.has(st.clip) ? st.clip : this.clips.has('Idle') ? 'Idle' : [...this.clips.keys()][0]
    const o = this.action(key)
    if (!o) return
    if (this.current !== key) {
      if (this.current) this.actions.get(this.current)?.a.setEffectiveWeight(0)
      o.a.setEffectiveWeight(1)
      this.current = key
    }
    const last = o.d - 0.03
    // a negative rate plays the clip backwards from its end: a fall played backwards is a body getting up
    o.a.time = st.hold ? (st.rate < 0 ? Math.max(0, last + st.ct * st.rate) : Math.min(st.ct * st.rate, last)) : (((st.ct * st.rate + this.offset) % o.d) + o.d) % o.d
    this.mixer.update(0)
  }
}

/** A prop fitted to a size, its base on y = 0 and its middle on the origin. `scale` keeps the model's own size. */
export function staticModel(g: GLTF, opts: { maxDim?: number; height?: number; scale?: number; yaw?: number }): THREE.Group {
  const o = g.scene.clone(true)
  shade(o)
  const bb = new THREE.Box3().setFromObject(o)
  const sz = bb.getSize(V())
  const c = bb.getCenter(V())
  const k = opts.scale ?? (opts.height ? opts.height / sz.y : (opts.maxDim ?? 1) / Math.max(sz.x, sz.y, sz.z))
  o.scale.setScalar(k)
  o.position.set(-c.x * k, -bb.min.y * k, -c.z * k)
  const w = new THREE.Group()
  w.add(o)
  w.rotation.y = opts.yaw ?? 0
  const r = new THREE.Group()
  r.add(w)
  return r
}

/** The rough size of a model's mesh (not its skeleton), for fitting a held prop. */
export function sizeOf(g: GLTF): THREE.Vector3 {
  return new THREE.Box3().setFromObject(g.scene).getSize(V())
}

export const lambert = (color: number | string, o: THREE.MeshLambertMaterialParameters = {}): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color, flatShading: true, ...o })
export const glowMat = (color: number | string, o: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, ...o })
const plainMat = (color: number | string, o: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, ...o })

const SPHERE = new THREE.SphereGeometry(1, 10, 8)

/** Pooled flashes and puffs: spheres that grow and fade. */
export class Puffs {
  constructor(private readonly parent: THREE.Object3D) {}
  make(color: number | string, additive = false): THREE.Mesh {
    const m = new THREE.Mesh(SPHERE, additive ? glowMat(color, { opacity: 0 }) : plainMat(color, { opacity: 0 }))
    m.visible = false
    this.parent.add(m)
    return m
  }
  set(m: THREE.Mesh, pos: THREE.Vector3, r: number, op: number): void {
    m.visible = op > 0.01
    m.position.copy(pos)
    m.scale.setScalar(Math.max(r, 0.001))
    ;(m.material as THREE.MeshBasicMaterial).opacity = Math.max(op, 0)
  }
  hide(m: THREE.Mesh): void {
    m.visible = false
  }
}

/** A glowing cylinder from A to B, for a laser or a tractor beam. */
export class Beam extends THREE.Mesh {
  constructor(parent: THREE.Object3D, color: number | string) {
    super(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), glowMat(color, { opacity: 0.9, side: THREE.DoubleSide }))
    this.visible = false
    parent.add(this)
  }
  aim(a: THREE.Vector3, b: THREE.Vector3, r: number, op: number): void {
    const d = b.clone().sub(a)
    const len = d.length()
    this.visible = op > 0.01 && len > 1e-3
    if (!this.visible) return
    this.position.copy(a).addScaledVector(d, 0.5)
    this.scale.set(r, len, r)
    this.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize())
    ;(this.material as THREE.MeshBasicMaterial).opacity = op
  }
}

/** A gun's muzzle flash: a hot cone along the barrel with a bright core, flickering for a few hundredths of a second. */
export class MuzzleFlash {
  readonly root = new THREE.Group()
  private readonly outer: THREE.Mesh
  private readonly core: THREE.Mesh
  constructor(parent: THREE.Object3D) {
    const cone = new THREE.ConeGeometry(0.2, 1, 7, 1, true)
    cone.rotateX(Math.PI / 2)
    cone.translate(0, 0, 0.5)
    this.outer = new THREE.Mesh(cone, glowMat(C.flashOuter, { opacity: 0, side: THREE.DoubleSide }))
    this.core = new THREE.Mesh(SPHERE, glowMat(C.flashCore, { opacity: 0 }))
    this.root.add(this.outer, this.core)
    this.root.visible = false
    parent.add(this.root)
  }
  /** Shows the flash at `at`, pointing at `toward`; `k` is 1 at the shot and 0 when it is over. */
  show(at: THREE.Vector3, toward: THREE.Vector3, k: number, size = 1): void {
    this.root.visible = k > 0.02
    if (!this.root.visible) return
    this.root.position.copy(at)
    this.root.lookAt(toward)
    this.root.rotation.z = k * 9
    const f = 0.6 + k * 0.7
    this.outer.scale.set(size * f, size * f, size * (0.7 + k * 0.9))
    this.core.scale.setScalar(0.16 * size * f)
    ;(this.outer.material as THREE.MeshBasicMaterial).opacity = Math.min(1, k * 1.4)
    ;(this.core.material as THREE.MeshBasicMaterial).opacity = Math.min(1, k * 1.6)
  }
  hide(): void {
    this.root.visible = false
  }
}

/** A tracer: a short bright streak that crosses from the muzzle to the target. */
export class Tracer {
  private readonly mesh: THREE.Mesh
  constructor(parent: THREE.Object3D, color: number | string = C.tracer) {
    const g = new THREE.CylinderGeometry(0.035, 0.035, 1, 5)
    this.mesh = new THREE.Mesh(g, glowMat(color, { opacity: 0.95 }))
    this.mesh.visible = false
    parent.add(this.mesh)
  }
  /** `u` is how far along the line it has got, 0..1. */
  show(a: THREE.Vector3, b: THREE.Vector3, u: number, streak = 1.6): void {
    const d = b.clone().sub(a)
    const len = d.length()
    this.mesh.visible = u >= 0 && u <= 1 && len > 0.01
    if (!this.mesh.visible) return
    const head = Math.min(len, u * len)
    const tail = Math.max(0, head - streak)
    const dir = d.clone().normalize()
    this.mesh.position.copy(a).addScaledVector(dir, (head + tail) / 2)
    this.mesh.scale.set(1, Math.max(0.05, head - tail), 1)
    this.mesh.quaternion.setFromUnitVectors(V(0, 1, 0), dir)
  }
  hide(): void {
    this.mesh.visible = false
  }
}

/**
 * A fire that looks alive: three tongues of flame (red, orange, white-hot) that lean and flicker out of step, embers that rise and go out,
 * and smoke above. Everything is a function of the time it is given.
 */
export class Fire {
  readonly root = new THREE.Group()
  private readonly tongues: { m: THREE.Mesh; ph: number; base: number }[] = []
  private readonly embers: THREE.Mesh[] = []
  private readonly smoke: THREE.Mesh[] = []
  private readonly light: THREE.PointLight | null
  constructor(private readonly size = 1, private readonly seed = 0, withLight = false) {
    const defs: [number, number, number, number][] = [
      [C.fireOuter, 0.62, 1.7, 0.7],
      [C.fireMid, 0.46, 1.45, 0.82],
      [C.fireCore, 0.26, 1.05, 0.95],
    ]
    defs.forEach(([col, r, h, op], i) => {
      for (let j = 0; j < (i === 0 ? 3 : 2); j++) {
        const geo = new THREE.ConeGeometry(r * (j ? 0.7 : 1), h * (j ? 0.8 : 1), 7, 1, true)
        geo.translate(0, h * (j ? 0.4 : 0.5), 0)
        const m = new THREE.Mesh(geo, glowMat(col, { opacity: op, side: THREE.DoubleSide }))
        m.position.set(j ? Math.cos(j * 2.4 + seed) * 0.22 : 0, 0, j ? Math.sin(j * 2.4 + seed) * 0.22 : 0)
        this.root.add(m)
        this.tongues.push({ m, ph: seed * 1.7 + i * 0.9 + j * 2.1, base: 1 })
      }
    })
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(SPHERE, glowMat(C.ember, { opacity: 0 }))
      this.embers.push(m)
      this.root.add(m)
    }
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(SPHERE, plainMat(C.smoke, { opacity: 0 }))
      this.smoke.push(m)
      this.root.add(m)
    }
    this.light = withLight ? new THREE.PointLight(C.fireMid, 0, 9 * size, 1.6) : null
    if (this.light) {
      this.light.position.y = 1.2
      this.root.add(this.light)
    }
    this.root.scale.setScalar(size)
  }
  update(t: number): void {
    for (const { m, ph } of this.tongues) {
      const f = 1 + 0.2 * Math.sin(t * 17 + ph) + 0.12 * Math.sin(t * 29 + ph * 2.3) + 0.06 * Math.sin(t * 43 + ph)
      m.scale.set(1 + 0.1 * Math.sin(t * 11 + ph), f, 1 + 0.1 * Math.cos(t * 13 + ph))
      m.rotation.z = 0.12 * Math.sin(t * 5.3 + ph)
      m.rotation.x = 0.12 * Math.cos(t * 4.7 + ph)
      m.rotation.y = t * 1.5 + ph
    }
    this.embers.forEach((m, i) => {
      const life = (t * 0.9 + i * 0.137 + this.seed * 0.31) % 1
      m.position.set(Math.sin(i * 12.9 + life * 3) * 0.5 * (0.4 + life), 0.6 + life * 3, Math.cos(i * 7.3 + life * 2) * 0.5 * (0.4 + life))
      m.scale.setScalar(0.05 + 0.04 * (1 - life))
      m.visible = true
      ;(m.material as THREE.MeshBasicMaterial).opacity = (1 - life) * 0.95
    })
    this.smoke.forEach((m, i) => {
      const life = (t * 0.35 + i * 0.25 + this.seed * 0.17) % 1
      m.position.set(Math.sin(i * 5 + life * 2) * 0.4, 1.6 + life * 4.5, Math.cos(i * 3 + life) * 0.4)
      m.scale.setScalar(0.5 + life * 1.5)
      ;(m.material as THREE.MeshBasicMaterial).opacity = 0.32 * Math.sin(life * Math.PI)
    })
    if (this.light) this.light.intensity = (5 + 2.5 * Math.sin(t * 19 + this.seed) + Math.sin(t * 31)) * this.size
  }
}
