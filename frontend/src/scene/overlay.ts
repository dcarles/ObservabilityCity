import * as THREE from 'three'
import type { DependencySnapshot } from '../types'
import { clamp } from '../visuals'

/** One arc the overlay draws, as plain values for tests. */
export interface ArcStatus {
  from: string
  to: string
  requestsPerSecond: number
  /** Tube radius: how thick the arc is drawn. */
  width: number
}

const LIFT = 10 // how far above the islands the arcs start
const DASH = 5 // dash length in metres

/** Thickness of an arc for a traffic volume: a trickle is a pencil line and the busiest links are about three times as thick. */
export function arcWidth(requestsPerSecond: number): number {
  return 0.45 + 0.75 * clamp(Math.log10(1 + Math.max(0, requestsPerSecond)), 0, 2.6)
}

/**
 * The dependency overlay: a dashed arc from each group (or the hub) to each group or third party it calls into, sized by how much traffic
 * flows, in the caller's colour, with the dashes marching from caller to callee. Hidden until switched on. Arcs are rebuilt only when
 * the set of links or a link's size class changes, not with every snapshot.
 */
export class DependencyOverlay {
  readonly object = new THREE.Group()
  private anchors = new Map<string, { at: THREE.Vector3; color: string }>()
  private arcs: { status: ArcStatus; mesh: THREE.Mesh; map: THREE.Texture }[] = []
  private key = ''
  private readonly dash: THREE.CanvasTexture
  private on = false

  constructor() {
    this.object.visible = false
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 4
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 36, 4)
    this.dash = new THREE.CanvasTexture(c)
    this.dash.wrapS = THREE.RepeatWrapping
    this.dash.wrapT = THREE.RepeatWrapping
    this.dash.colorSpace = THREE.SRGBColorSpace
  }

  /** Where each group and vendor stands, in world coordinates, and the colour its arcs get. Call once the town is built. */
  setAnchors(anchors: Map<string, { at: THREE.Vector3; color: string }>): void {
    this.anchors = anchors
    this.key = ''
  }

  get visible(): boolean {
    return this.on
  }

  set visible(v: boolean) {
    this.on = v
    this.object.visible = v
  }

  /** Feeds the links from a snapshot. Cheap when nothing a viewer could see has changed. */
  set(links: readonly DependencySnapshot[]): void {
    const wanted = links.filter((l) => this.anchors.has(l.from) && this.anchors.has(l.to) && l.requestsPerSecond > 0.05)
    const key = wanted.map((l) => `${l.from}>${l.to}:${arcWidth(l.requestsPerSecond).toFixed(2)}`).join('|')
    if (key === this.key) {
      wanted.forEach((l) => { const a = this.arcs.find((x) => x.status.from === l.from && x.status.to === l.to); if (a) a.status.requestsPerSecond = l.requestsPerSecond })
      return
    }
    this.key = key
    this.clear()
    for (const l of wanted) this.add(l)
  }

  status(): { visible: boolean; arcs: ArcStatus[] } {
    return { visible: this.on, arcs: this.arcs.map((a) => ({ ...a.status })) }
  }

  update(dt: number): void {
    if (!this.on) return
    // the dashes march from the caller toward what it calls, at the same pace on every arc whatever its length
    for (const a of this.arcs) a.map.offset.x -= (dt * 3) / (DASH * 2) // 3 m/s: one dash period is 2 x DASH metres
  }

  private add(l: DependencySnapshot): void {
    const a = this.anchors.get(l.from)!, b = this.anchors.get(l.to)!
    const from = a.at.clone().setY(LIFT), to = b.at.clone().setY(LIFT)
    const dist = from.distanceTo(to)
    const mid = from.clone().add(to).multiplyScalar(0.5)
    mid.y += 8 + dist * 0.14
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to)
    const width = arcWidth(l.requestsPerSecond)
    const geometry = new THREE.TubeGeometry(curve, Math.max(12, Math.round(dist / 3)), width, 6, false)
    const map = this.dash.clone()
    map.needsUpdate = true
    map.repeat.set(Math.max(1, dist / (DASH * 2)), 1)
    map.wrapS = THREE.RepeatWrapping
    const material = new THREE.MeshBasicMaterial({ color: a.color, alphaMap: map, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.renderOrder = 6
    mesh.frustumCulled = false
    this.object.add(mesh)
    this.arcs.push({ status: { from: l.from, to: l.to, requestsPerSecond: l.requestsPerSecond, width }, mesh, map })
  }

  private clear(): void {
    for (const a of this.arcs) {
      this.object.remove(a.mesh)
      a.mesh.geometry.dispose()
      const m = a.mesh.material as THREE.MeshBasicMaterial
      m.alphaMap?.dispose()
      m.dispose()
    }
    this.arcs = []
  }
}
