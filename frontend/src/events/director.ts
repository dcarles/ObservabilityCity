// Plays an event beside the town: a patch of ground rises from the sea next to a random island, the camera glides over to it, the scene plays
// out with the town still there behind it, and when it is over the patch goes and the camera returns.

import * as THREE from 'three'
import type { Stage } from '../scene/stage'
import { buildEvent, eventForTheme, type EventId } from './index'
import { placeBeside } from './placement'
import type { Disc } from './rig'
import type { EventScene } from './types'

export interface EventOptions {
  /** The round footprints of the islands, so the patch can be set clear of them. */
  footprints: () => Disc[]
  /** A number from 0 up to 1 that picks the island; random by default, fixed in tests. */
  pick?: () => number
}

export class EventDirector {
  private scene: EventScene | null = null
  private root: THREE.Group | null = null
  private readonly built = new Map<EventId, { scene: EventScene; root: THREE.Group }>()
  private t = 0
  private on = false
  private starting = false
  /** Escape pressed while the models were still loading: do not start. */
  private cancelled = false
  private saved: { pos: THREE.Vector3; target: THREE.Vector3; pan: number } | null = null
  private readonly caption: HTMLElement
  /** Where the patch stood the last time, for tests. */
  lastPlacement: { x: number; z: number; yaw: number; beside: number } | null = null

  constructor(private readonly stage: Stage, private readonly themeId: string, private readonly opts: EventOptions, host: HTMLElement = document.body) {
    this.caption = document.createElement('div')
    this.caption.id = 'event-caption'
    this.caption.hidden = true
    this.caption.setAttribute('role', 'status')
    host.appendChild(this.caption)
  }

  get playing(): boolean {
    return this.on || this.starting
  }
  get time(): number {
    return this.t
  }
  /** The event this theme plays, or null when the theme has none. */
  get eventId(): EventId | null {
    return eventForTheme(this.themeId)
  }
  get current(): EventScene | null {
    return this.on ? this.scene : null
  }

  /** Starts the theme's event from the beginning. Does nothing while one is already playing. */
  async play(): Promise<boolean> {
    const id = this.eventId
    if (!id || this.playing) return false
    this.starting = true
    this.cancelled = false
    try {
      let b = this.built.get(id)
      if (!b) {
        const root = new THREE.Group()
        const scene = await buildEvent(id, { root })
        b = { scene, root }
        this.built.set(id, b)
      }
      if (this.cancelled) return false
      this.scene = b.scene
      this.root = b.root
      const centre = this.stage.homeAt
      const spot = placeBeside(this.opts.footprints(), { x: centre.x, z: centre.z }, b.scene.radius, (this.opts.pick ?? Math.random)())
      this.lastPlacement = spot
      this.root.position.set(spot.x, 0.5, spot.z)
      this.root.rotation.y = spot.yaw
      this.root.updateMatrixWorld(true)
      this.stage.scene.add(this.root)
      document.body.classList.add('event-playing')
      this.saved = { pos: this.stage.camera.position.clone(), target: this.stage.controls.target.clone(), pan: this.stage.widenPan(Math.hypot(spot.x - centre.x, spot.z - centre.z) + b.scene.radius) }
      const to = (v: THREE.Vector3): THREE.Vector3 => this.root!.localToWorld(v.clone())
      this.stage.glideTo(to(b.scene.camera.target).setY(0), to(b.scene.camera.pos))
      this.t = 0
      this.on = true
      this.setTime(0)
      return true
    } finally {
      this.starting = false
    }
  }

  /** Jumps to a moment of the playing event. */
  setTime(t: number): void {
    if (!this.scene) return
    this.t = Math.max(0, Math.min(t, this.scene.loop))
    this.scene.update(this.t)
    this.caption.textContent = this.scene.caption(this.t)
    this.caption.hidden = false
  }

  update(dt: number): void {
    if (!this.on || !this.scene) return
    this.setTime(this.t + dt)
    if (this.t >= this.scene.loop - 1e-6) this.stop()
  }

  /** Ends the event: the patch goes and the camera returns to where it was. */
  stop(): void {
    if (this.starting) this.cancelled = true
    if (!this.on) return
    this.on = false
    if (this.root) this.stage.scene.remove(this.root)
    document.body.classList.remove('event-playing')
    this.caption.hidden = true
    if (this.saved) {
      this.stage.glideTo(this.saved.target, this.saved.pos)
      this.stage.setPanLimit(this.saved.pan)
    }
    this.saved = null
  }
}
