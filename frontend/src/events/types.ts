import type * as THREE from 'three'
import type { Arena } from './arena'

/** One scripted event, built and ready to play on a real island. It draws itself from the time it is given, so any moment can be jumped to. */
export interface EventScene {
  id: 'pirates' | 'zombies' | 'aliens'
  title: string
  /** How long the event lasts, in seconds. */
  loop: number
  /** Puts everything where it is `t` seconds in. */
  update(t: number): void
  /** Where the camera starts, island-local. */
  camera: { pos: THREE.Vector3; target: THREE.Vector3 }
  /** A line for the bottom of the screen at this moment. */
  caption(t: number): string
  /** What is going on at this moment, for tests. */
  inspect(t: number): Record<string, number>
  /** The buildings the event hits and when, for tests: building id to the time it is first hit. */
  hits(): Record<string, number>
}

export interface BuildContext {
  /** A group that stands on the island with the island's own coordinates; its y = 0 is the ground. Everything the event adds goes in here. */
  root: THREE.Group
  /** The island: its coast, its buildings and the map of where a person can walk. */
  arena: Arena
}
