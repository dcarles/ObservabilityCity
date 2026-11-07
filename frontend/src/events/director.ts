// Plays an event on one of the town's own islands: the camera glides over to a random island, the scene plays out on its real buildings with the
// rest of the town still there, and when it is over everything the event added is taken away and the camera returns. The event lays effects over
// the buildings (fire, scorch) in a group of its own; nothing of the town is changed, so removing that group puts the town back exactly.

import * as THREE from 'three'
import type { Stage } from '../scene/stage'
import type { EventSite } from '../scene/town'
import { Arena } from './arena'
import { buildEvent, eventForTheme, type EventId } from './index'
import type { EventScene } from './types'

export interface EventOptions {
  /** The islands an event can play on. */
  sites: () => EventSite[]
  /** A number from 0 up to 1 that picks the island; random by default, fixed in tests. */
  pick?: () => number
}

export class EventDirector {
  private scene: EventScene | null = null
  private root: THREE.Group | null = null
  private t = 0
  private on = false
  private starting = false
  /** Escape pressed while the models were still loading: do not start. */
  private cancelled = false
  private saved: { pos: THREE.Vector3; target: THREE.Vector3; pan: number } | null = null
  private readonly caption: HTMLElement
  /** Which island the event is playing on, for tests. */
  lastPlacement: { island: string; x: number; z: number } | null = null

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
    const sites = this.opts.sites().filter((s) => s.source.blocks.length > 0)
    if (!id || this.playing || sites.length === 0) return false
    this.starting = true
    this.cancelled = false
    try {
      const site = sites[Math.min(sites.length - 1, Math.floor((this.opts.pick ?? Math.random)() * sites.length))]
      const arena = new Arena(site.source)
      const root = new THREE.Group()
      const scene = await buildEvent(id, { root, arena })
      if (this.cancelled) return false
      this.scene = scene
      this.root = root
      this.lastPlacement = { island: site.source.id, x: site.origin.x, z: site.origin.z }
      root.position.copy(site.origin)
      root.rotation.y = site.yaw
      root.updateMatrixWorld(true)
      this.stage.scene.add(root)
      document.body.classList.add('event-playing')
      const centre = this.stage.homeAt
      this.saved = { pos: this.stage.camera.position.clone(), target: this.stage.controls.target.clone(), pan: this.stage.widenPan(Math.hypot(site.origin.x - centre.x, site.origin.z - centre.z) + arena.reach + 40) }
      const to = (v: THREE.Vector3): THREE.Vector3 => root.localToWorld(v.clone())
      this.stage.glideTo(to(scene.camera.target).setY(0), to(scene.camera.pos))
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

  /** Ends the event: everything it added goes and the camera returns to where it was. */
  stop(): void {
    if (this.starting) this.cancelled = true
    if (!this.on) return
    this.on = false
    if (this.root) this.stage.scene.remove(this.root)
    this.root = null
    document.body.classList.remove('event-playing')
    this.caption.hidden = true
    if (this.saved) {
      this.stage.glideTo(this.saved.target, this.saved.pos)
      this.stage.setPanLimit(this.saved.pan)
    }
    this.saved = null
  }
}
