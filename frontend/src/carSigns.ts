// Where a car came from and where it is going. Cars are small and there are many, so a sign over every car would only be a wall of text:
// from the air nothing shows; point at a car for a card with both ends (and its route drawn); click it to keep the card on it; and when the
// camera is close, the few cars nearest the middle of the view carry a small "from → to" sign. Plain DOM over the canvas, so the text stays sharp.

import * as THREE from 'three'
import type { CarSystem, CarView } from './scene/cars'
import { buildingName, carEnds, carSignText, OUTSIDE } from './scene/carLabel'

/** The camera's distance from what it looks at, below which cars near the middle of the view get a sign. */
export const SIGNS_BELOW = 70
/** How many signs at most, and how far from the middle of the view (metres on the ground) a car may be to get one. */
export const SIGNS_MAX = 8
export const SIGNS_RADIUS = 45
/** How close a pointer must be to a car to pick it: the metres grow with the camera's distance, so a small car is as easy to hit from far as from close. */
export function pickReach(distance: number): number {
  return Math.max(1.1, distance * 0.022)
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

export class CarSigns {
  private readonly layer: HTMLElement
  private readonly card: HTMLElement
  private readonly tags: HTMLElement[] = []
  private readonly v = new THREE.Vector3()
  /** The car whose card is kept (clicked), -1 for none. */
  pinned = -1
  /** The car under the pointer, -1 for none. */
  hovered = -1

  constructor(private readonly cars: CarSystem, host: HTMLElement = document.body) {
    this.layer = document.createElement('div')
    this.layer.id = 'car-signs'
    this.layer.setAttribute('aria-hidden', 'true')
    this.card = document.createElement('div')
    this.card.id = 'car-card'
    this.card.hidden = true
    this.layer.appendChild(this.card)
    host.appendChild(this.layer)
  }

  /** The car under this ray, if any: what a pointer move or a click asks. */
  pick(ray: THREE.Ray, distance: number): CarView | null {
    return this.cars.pick(ray, pickReach(distance))
  }

  /** Points at a car (or at none); a click on a car keeps its card until the next click. */
  point(car: CarView | null): void {
    this.hovered = car ? car.id : -1
  }

  /** A click: on a car keeps its card (a second click on the same car lets go), anywhere else lets go. */
  click(car: CarView | null): void {
    this.pinned = car && car.id !== this.pinned ? car.id : -1
  }

  /** Draws the signs and the card for this frame. `target` is the point on the ground the camera looks at. */
  update(camera: THREE.Camera, distance: number, target: THREE.Vector3, width: number, height: number, hidden = false): void {
    const keep = hidden ? null : this.cars.find(this.pinned)
    if (this.pinned >= 0 && !keep) this.pinned = -1
    const hover = hidden || keep ? null : this.cars.find(this.hovered)
    const shown = keep ?? hover
    this.cars.highlight(shown, distance)
    this.drawCard(shown, camera, width, height, !!keep)
    const near = !hidden && distance < SIGNS_BELOW ? this.cars.nearest(target.x, target.z, SIGNS_RADIUS, SIGNS_MAX) : []
    const signs = near.filter((c) => c.id !== shown?.id)
    for (let i = 0; i < signs.length; i++) {
      const tag = this.tags[i] ?? this.makeTag()
      const c = signs[i]
      this.v.set(c.x, c.y + 1.6, c.z).project(camera)
      const on = this.v.z < 1 && Math.abs(this.v.x) < 1.05 && Math.abs(this.v.y) < 1.05
      tag.style.display = on ? '' : 'none'
      if (!on) continue
      const text = carSignText(c)
      if (tag.textContent !== text) tag.textContent = text
      tag.classList.toggle('bad', c.failed)
      tag.style.transform = `translate(-50%, -100%) translate(${((this.v.x + 1) / 2) * width}px, ${((1 - this.v.y) / 2) * height}px)`
    }
    for (let i = signs.length; i < this.tags.length; i++) this.tags[i].style.display = 'none'
  }

  private makeTag(): HTMLElement {
    const tag = document.createElement('div')
    tag.className = 'car-sign'
    this.layer.appendChild(tag)
    this.tags.push(tag)
    return tag
  }

  private drawCard(car: CarView | null, camera: THREE.Camera, width: number, height: number, pinned: boolean): void {
    if (!car) { this.card.hidden = true; return }
    const e = carEnds(car)
    const fromName = car.from ? buildingName(car.from) : 'Outside the town'
    const toName = buildingName(car.to)
    const kind = car.origin === 'external' ? 'From outside' : 'Internal call'
    this.card.innerHTML =
      `<div class="car-ends"><span class="from">${esc(e.from)}</span> → <span class="to">${esc(e.to)}</span></div>` +
      `<div class="row"><span>From</span><span>${esc(fromName)}${e.from === OUTSIDE ? '' : ` · ${esc(e.from)}`}</span></div>` +
      `<div class="row"><span>To</span><span>${esc(toName)} · ${esc(e.to)}</span></div>` +
      `<div class="row"><span>Request</span><span>${kind} · <b class="${car.failed ? 'bad' : 'ok'}">${car.failed ? 'failing' : 'ok'}</b></span></div>` +
      (pinned ? '<div class="hint">click again to let go</div>' : '')
    this.card.hidden = false
    this.v.set(car.x, car.y + 2.4, car.z).project(camera)
    const x = ((this.v.x + 1) / 2) * width, y = ((1 - this.v.y) / 2) * height
    const w = this.card.offsetWidth, h = this.card.offsetHeight
    this.card.style.left = `${Math.max(8, Math.min(x - w / 2, width - w - 8))}px`
    this.card.style.top = `${Math.max(8, Math.min(y - h - 10, height - h - 8))}px`
  }

  /** The text of the signs now on screen, and of the card. For tests. */
  shown(): { signs: string[]; card: string | null; pinned: boolean } {
    return {
      signs: this.tags.filter((t) => t.style.display !== 'none').map((t) => t.textContent ?? ''),
      card: this.card.hidden ? null : (this.card.querySelector('.car-ends')?.textContent ?? ''),
      pinned: this.pinned >= 0,
    }
  }
}
