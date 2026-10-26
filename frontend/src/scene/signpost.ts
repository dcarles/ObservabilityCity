import * as THREE from 'three'
import { canvasTexture, roundRect } from '../buildings/mk'
import { palette } from '../themes/harbour-town/palette'
import { GROUND } from './island'
import { signBoard, signText, type SignLine } from '../edgeTraffic'

const W = 640
const H = 330

/**
 * A signpost at an island's gate, for a town whose islands call each other directly: it says which hidden islands this island's systems send
 * traffic to and receive it from. There is no hub plaza for such traffic to end at, so the sign is where it leaves the picture.
 */
export class Signpost {
  readonly object = new THREE.Group()
  private readonly face: THREE.Mesh
  private readonly tex: THREE.CanvasTexture
  private key = ''
  /** What the board says, one entry for each line. For tests. */
  text: string[] = []

  constructor(x: number, z: number) {
    this.tex = canvasTexture(W, H, () => {})
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.22, 4.0, 7), new THREE.MeshStandardMaterial({ color: palette.woodDark, flatShading: true }))
    post.position.y = 2.0
    post.castShadow = true
    const w = 6.2, h = (w * H) / W
    const back = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, h + 0.2, 0.12), new THREE.MeshStandardMaterial({ color: '#f7f0df', roughness: 0.9 }))
    back.position.set(0, 4.3, 0.1)
    back.castShadow = true
    this.face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }))
    this.face.position.set(0, 4.3, 0.18)
    this.object.add(post, back, this.face)
    this.object.position.set(x, GROUND, z)
    this.object.rotation.y = -0.25
    this.object.userData.signpost = true
  }

  set(lines: readonly SignLine[]): void {
    const { shown, more } = signBoard(lines)
    const text = shown.map(signText)
    if (more > 0) text.push(`+${more} more`)
    const key = text.join('|')
    if (key === this.key) return
    this.key = key
    this.text = text
    const ctx = (this.tex.image as HTMLCanvasElement).getContext('2d')!
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#f7f0df'; roundRect(ctx, 4, 4, W - 8, H - 8, 26); ctx.fill()
    ctx.fillStyle = '#8d949e'; ctx.fillRect(4, 4, W - 8, 44)
    ctx.fillStyle = '#fff'; ctx.font = '800 30px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('HIDDEN ISLANDS', W / 2, 27)
    ctx.fillStyle = '#26364f'; ctx.font = '700 40px system-ui, sans-serif'; ctx.textAlign = 'left'
    text.forEach((t, i) => ctx.fillText(t, 28, 90 + i * 56, W - 56))
    this.tex.needsUpdate = true
  }
}
