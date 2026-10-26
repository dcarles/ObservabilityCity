import * as THREE from 'three'
import { canvasTexture, cyl, flat, roundRect } from '../buildings/mk'
import { palette } from '../themes/active'
import { clamp, formatRate } from '../visuals'
import { GROUND } from './island'
import { halo } from './harbour'

/**
 * The hub's lighthouse, beside the Service Bus port. Its red light sweeps while any consumer in the town has a dead letter, and its
 * board reads out the town-wide total (the same number as the top-bar total). Calm, it is dark and its board fades unless the camera is near.
 */
export class Lighthouse {
  readonly group = new THREE.Group()
  private readonly bulb: THREE.Mesh
  private readonly glow: THREE.Sprite
  private readonly beam: THREE.Mesh
  private readonly label: THREE.Sprite
  private readonly phase = Math.random() * 6
  private total = 0
  private key = ''

  constructor(x: number, z: number) {
    const white = flat('#f4efe2'), red = flat('#c8372d'), iron = flat('#3b4551')
    // tower: a white taper with red bands, a gallery, a lantern and a roof
    this.group.add(cyl(1.15, 1.7, 8.4, white, { y: GROUND + 4.2 }, 12))
    for (const y of [1.6, 4.4, 7.0]) this.group.add(cyl(1.0 + (8.4 - y) * 0.065, 1.0 + (8.4 - y) * 0.065 + 0.12, 0.9, red, { y: GROUND + y }, 12))
    this.group.add(cyl(1.7, 1.7, 0.22, iron, { y: GROUND + 8.5 }, 12))
    this.bulb = new THREE.Mesh(new THREE.SphereGeometry(0.62, 12, 10), new THREE.MeshBasicMaterial({ color: palette.beacon.off, toneMapped: false }))
    this.bulb.position.y = GROUND + 9.3
    this.group.add(this.bulb, cyl(1.0, 1.0, 0.16, iron, { y: GROUND + 10.05 }, 12), cyl(0.0, 1.15, 0.9, red, { y: GROUND + 10.5 }, 12))
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo(), color: '#ff3d3d', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }))
    this.glow.position.copy(this.bulb.position)
    this.glow.scale.set(6, 6, 1)
    this.glow.visible = false
    const sweep = new THREE.Shape()
    sweep.moveTo(0, 0); sweep.lineTo(22, -3.6); sweep.lineTo(22, 3.6); sweep.closePath()
    const beamGeo = new THREE.ShapeGeometry(sweep)
    beamGeo.rotateX(-Math.PI / 2)
    this.beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: '#ff3d3d', transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }))
    this.beam.position.copy(this.bulb.position)
    this.beam.visible = false
    this.group.add(this.glow, this.beam)

    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTexture(320, 96, () => {}), transparent: true, depthTest: false, toneMapped: false }))
    this.label.renderOrder = 10
    this.label.scale.set(3.6, 1.08, 1)
    this.label.position.set(0, GROUND + 12.6, 0)
    this.group.add(this.label)
    this.group.position.set(x, 0, z)
  }

  /** The town-wide dead-letter total. */
  set(total: number): void {
    this.total = Math.max(0, Math.round(total))
  }

  update(time: number, camera: THREE.Camera): void {
    const alarm = this.total > 0
    this.glow.visible = alarm
    this.beam.visible = alarm
    ;(this.bulb.material as THREE.MeshBasicMaterial).color.set(alarm ? '#ff3d3d' : palette.beacon.off)
    if (alarm) {
      this.beam.rotation.y = time * 1.4 + this.phase
      ;(this.glow.material as THREE.SpriteMaterial).opacity = 0.55 + 0.4 * Math.sin(time * 5 + this.phase)
    }
    const d = camera.position.distanceTo(this.label.getWorldPosition(new THREE.Vector3()))
    const opacity = alarm ? 1 : 1 - clamp((d - 70) / 40, 0, 1)
    ;(this.label.material as THREE.SpriteMaterial).opacity = opacity
    this.label.visible = opacity > 0.02
    const key = String(this.total)
    if (key === this.key) return
    this.key = key
    const tex = (this.label.material as THREE.SpriteMaterial).map as THREE.CanvasTexture
    const ctx = (tex.image as HTMLCanvasElement).getContext('2d')!
    ctx.clearRect(0, 0, 320, 96)
    ctx.fillStyle = 'rgba(20,28,40,0.92)'; roundRect(ctx, 4, 8, 312, 80, 24); ctx.fill()
    ctx.strokeStyle = alarm ? '#ff5a4d' : '#9fb4cc'; ctx.lineWidth = 6; ctx.stroke()
    ctx.fillStyle = alarm ? '#ff5a4d' : '#b8c7da'; ctx.font = '800 34px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(`DLQ total ${formatRate(this.total)}`, 160, 50, 290)
    tex.needsUpdate = true
  }

  /** What the lighthouse shows, for tests. */
  status(): { total: number; alarm: boolean } {
    return { total: this.total, alarm: this.total > 0 }
  }
}
