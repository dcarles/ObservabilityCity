// The small pure pieces every scripted event is made of: easing, a seeded generator, and the timeline a character follows.
// Nothing here draws anything, so the rules can be tested without a renderer. An event is a pure function of time: the same
// time always gives the same picture, which is what lets a test (or a scrub bar) jump to any moment.

import * as THREE from 'three'

export const V = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z)
export const clamp = (x: number, a = 0, b = 1): number => Math.min(b, Math.max(a, x))
export const ease = (x: number): number => x * x * (3 - 2 * x)
export const lerp = (a: number, b: number, k: number): number => a + (b - a) * k

/** A small seeded generator, so an event looks the same every time it plays. */
export function rng(seed: number): () => number {
  let s = (Math.imul(seed, 2654435761) >>> 0) || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** What a character is doing at one moment. `hide` removes it from view (a body that has been cleared away). */
export interface ActorState {
  pos: THREE.Vector3
  yaw: number
  clip: string
  /** Seconds into this segment, which is where the clip is played from. */
  ct: number
  rate: number
  /** Holds the last frame of the clip (a fall that stays down). */
  hold: boolean
  hide: boolean
  carry: boolean
}

/** One stretch of a character's day: walk from A to B, or stand at A facing something, doing one clip. */
export interface Seg {
  /** How long it lasts, in seconds. */
  d: number
  clip: string
  from?: THREE.Vector3
  to?: THREE.Vector3
  /** Stands at `from`, turned to look at this point. */
  faceTo?: THREE.Vector3
  yaw?: number
  rate?: number
  hold?: boolean
  hide?: boolean
  carry?: boolean
  /** Moves by a function of time instead of straight from A to B (riding a ship). */
  fn?: (t: number) => THREE.Vector3
  yawFn?: (t: number) => number
}

/** The timeline of one character: segments one after the other from `start`. Before `start` it returns null (not there yet). */
export function seq(start: number, segs: Seg[], yaw0 = 0): (t: number) => ActorState | null {
  let t = start
  let y = yaw0
  const list: (Seg & { t0: number; t1: number; yawAt: number })[] = []
  for (const s of segs) {
    if (s.to && s.from) {
      const dx = s.to.x - s.from.x
      const dz = s.to.z - s.from.z
      if (Math.hypot(dx, dz) > 1e-3) y = Math.atan2(dx, dz)
    } else if (s.faceTo && s.from) y = Math.atan2(s.faceTo.x - s.from.x, s.faceTo.z - s.from.z)
    else if (s.yaw !== undefined) y = s.yaw
    list.push({ ...s, t0: t, t1: t + s.d, yawAt: y })
    t += s.d
  }
  return (tt) => {
    if (tt < start || list.length === 0) return null
    let s = list[list.length - 1]
    for (const x of list) {
      if (tt < x.t1) {
        s = x
        break
      }
    }
    const k = clamp((tt - s.t0) / s.d)
    const pos = s.fn ? s.fn(tt) : s.to && s.from ? s.from.clone().lerp(s.to, k) : (s.from ?? V()).clone()
    return { pos, yaw: s.yawFn ? s.yawFn(tt) : s.yawAt, clip: s.clip, ct: tt - s.t0, rate: s.rate ?? 1, carry: !!s.carry, hold: !!s.hold, hide: !!s.hide }
  }
}

/** A point on a square ring of half-width `half` around (cx, cz): `u` runs 0..1 once round. */
export function ringPos(cx: number, cz: number, half: number, u: number): THREE.Vector3 {
  const p = (((u % 1) + 1) % 1) * 4
  const s = Math.floor(p)
  const f = p - s
  const pts = [
    [cx - half + 2 * half * f, cz + half],
    [cx + half, cz + half - 2 * half * f],
    [cx + half - 2 * half * f, cz - half],
    [cx - half, cz - half + 2 * half * f],
  ][s]
  return V(pts[0], 0, pts[1])
}

/** A round footprint on the ground. Everything solid in an event (a car, a barrel, a person) is a few of these. */
export interface Disc {
  x: number
  z: number
  r: number
}

/** The footprint of something long, as a row of discs along its length (a car, a container). `yaw` turns it like a model's yaw. */
export function capsule(x: number, z: number, length: number, width: number, yaw: number): Disc[] {
  const r = width / 2
  const n = Math.max(1, Math.ceil(length / r) - 1)
  const out: Disc[] = []
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 0 : (i / (n - 1) - 0.5) * (length - width)
    out.push({ x: x + Math.sin(yaw) * k, z: z + Math.cos(yaw) * k, r })
  }
  return out
}

/** The smallest gap between two sets of discs (negative when they overlap). */
export function clearance(a: readonly Disc[], b: readonly Disc[]): number {
  let m = Infinity
  for (const p of a) for (const q of b) m = Math.min(m, Math.hypot(p.x - q.x, p.z - q.z) - p.r - q.r)
  return m
}
