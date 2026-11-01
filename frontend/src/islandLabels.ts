// Name signs for the islands, seen from the air. From far away the buildings are too small to tell which island is which, so each island gets its name
// floating over it. Close up the signs fade out, so they never cover the buildings. Plain DOM over the canvas, so the text stays sharp at any size.

import * as THREE from 'three'
import type { IslandLabel } from './scene/town'

/** The camera's distance from what it looks at, up to which no sign shows, and the distance from which every sign is fully shown. */
export const LABELS_FROM = 110
export const LABELS_FULL = 190

/** How visible the signs are from this far away: 0 when close, 1 from the air, in between a fade. */
export function labelOpacity(distance: number): number {
  return Math.min(1, Math.max(0, (distance - LABELS_FROM) / (LABELS_FULL - LABELS_FROM)))
}

export class IslandLabels {
  private readonly el: HTMLElement
  private readonly tags = new Map<string, HTMLElement>()
  private readonly v = new THREE.Vector3()

  constructor(host: HTMLElement = document.body) {
    this.el = document.createElement('div')
    this.el.id = 'island-labels'
    this.el.setAttribute('aria-hidden', 'true')
    host.appendChild(this.el)
  }

  /** Puts each sign over its island for this frame. `distance` is how far the camera is from its target. */
  update(labels: readonly IslandLabel[], camera: THREE.Camera, distance: number, width: number, height: number): void {
    const opacity = labelOpacity(distance)
    this.el.style.opacity = String(opacity)
    this.el.hidden = opacity === 0
    if (opacity === 0) return
    const ids = new Set(labels.map((l) => l.id))
    for (const [id, tag] of this.tags) if (!ids.has(id)) { tag.remove(); this.tags.delete(id) }
    for (const l of labels) {
      let tag = this.tags.get(l.id)
      if (!tag) {
        tag = document.createElement('div')
        tag.className = `island-label${l.vendor ? ' vendor' : ''}`
        tag.dataset.id = l.id
        tag.textContent = l.name
        tag.style.borderColor = l.color
        this.el.appendChild(tag)
        this.tags.set(l.id, tag)
      }
      this.v.set(l.x, 8, l.z).project(camera)
      const on = this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1
      tag.style.display = on ? '' : 'none'
      if (on) tag.style.transform = `translate(-50%, -50%) translate(${((this.v.x + 1) / 2) * width}px, ${((1 - this.v.y) / 2) * height}px)`
    }
  }

  /** The names on screen right now. For tests. */
  names(): { id: string; name: string; shown: boolean }[] {
    return [...this.tags].map(([id, t]) => ({ id, name: t.textContent ?? '', shown: t.style.display !== 'none' && !this.el.hidden }))
  }
}
