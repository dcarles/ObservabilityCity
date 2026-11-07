import type * as THREE from 'three'

/** One scripted event, built and ready to play. It draws itself from the time it is given, so any moment can be jumped to. */
export interface EventScene {
  id: 'pirates' | 'zombies' | 'aliens'
  title: string
  /** How far its ground reaches from the middle, so the town can leave room. */
  radius: number
  /** How long the event lasts, in seconds. */
  loop: number
  /** Puts everything where it is `t` seconds in. */
  update(t: number): void
  /** Where the camera starts, relative to the event's ground. */
  camera: { pos: THREE.Vector3; target: THREE.Vector3 }
  /** A line for the bottom of the screen at this moment. */
  caption(t: number): string
  /** What is going on at this moment, for tests. */
  inspect(t: number): Record<string, number>
}

export interface BuildContext {
  /** A group standing on the event's ground; its top is at y = 0. */
  root: THREE.Group
}
