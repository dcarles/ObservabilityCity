// Keeps the people of an event from walking through each other. Every person who is free to start a little later (a zombie from the sea, an
// alien from a saucer, a pirate from the ship) is given the earliest start at which they never touch anyone already placed. People whose
// timing matters (a fighter waiting for an opponent) are placed first and not moved. Pure, so a test can run it on any town.

import type { ActorState } from './rig'

export type Timeline = (t: number) => ActorState | null

export interface Body {
  id: string
  /** How wide the person stands (a radius). */
  r: number
  /** Placed first, at delay 0, and never moved. */
  fixed?: boolean
  /** The person's timeline when it starts `delay` seconds later. */
  make: (delay: number) => Timeline
  /** True while the person is in anyone's way. The default is on their feet, on the ground. */
  solid?: (s: ActorState) => boolean
}

const onFeet = (s: ActorState): boolean => !s.hide && s.clip !== 'Death' && s.pos.y > -0.3 && s.pos.y < 1.2

/** The start delay of every body, in the order given. */
export function settle(bodies: readonly Body[], until: number, o: { step?: number; tries?: number; dt?: number } = {}): number[] {
  const step = o.step ?? 0.5
  const tries = o.tries ?? 30
  const dt = o.dt ?? 0.2
  const n = Math.floor(until / dt) + 1
  const placed: { r: number; at: ({ x: number; z: number } | null)[] }[] = []
  const sample = (b: Body, tl: Timeline): ({ x: number; z: number } | null)[] => {
    const solid = b.solid ?? onFeet
    const out: ({ x: number; z: number } | null)[] = []
    for (let i = 0; i < n; i++) {
      const s = tl(i * dt)
      out.push(s && solid(s) ? { x: s.pos.x, z: s.pos.z } : null)
    }
    return out
  }
  const hits = (r: number, at: ({ x: number; z: number } | null)[]): boolean => {
    for (const p of placed)
      for (let i = 0; i < n; i++) {
        const a = at[i]
        const b = p.at[i]
        if (a && b && Math.hypot(a.x - b.x, a.z - b.z) < r + p.r + 0.05) return true
      }
    return false
  }
  const delays: number[] = new Array(bodies.length).fill(0)
  const order = bodies.map((_, i) => i).sort((a, b) => Number(!!bodies[b].fixed) - Number(!!bodies[a].fixed) || a - b)
  for (const i of order) {
    const b = bodies[i]
    let chosen = 0
    let at = sample(b, b.make(0))
    if (!b.fixed) {
      for (let k = 1; k <= tries && hits(b.r, at); k++) {
        chosen = k * step
        at = sample(b, b.make(chosen))
      }
    }
    delays[i] = chosen
    placed.push({ r: b.r, at })
  }
  return delays
}
