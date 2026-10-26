import * as THREE from 'three'
import { canvasTexture, roundRect } from '../buildings/mk'
import { palette } from '../themes/active'
import { GROUND } from './island'

/** One thick post with a board on it, standing on the ground. */
export function islandSign(name: string, color: string, x: number, z: number): THREE.Group {
  const tex = canvasTexture(512, 128, (ctx) => {
    ctx.fillStyle = '#f7f0df'; roundRect(ctx, 4, 4, 504, 120, 22); ctx.fill()
    ctx.fillStyle = color; ctx.fillRect(4, 4, 504, 22)
    ctx.fillStyle = '#26364f'; ctx.font = '800 68px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(name.toUpperCase(), 256, 74, 480)
  })
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.22, 4.4, 7), new THREE.MeshStandardMaterial({ color: palette.woodDark, flatShading: true }))
  post.position.y = 2.2
  post.castShadow = true
  const board = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.4, 0.12), new THREE.MeshStandardMaterial({ color: '#f7f0df', roughness: 0.9 }))
  board.position.set(0, 3.6, 0.17)
  board.castShadow = true
  const face = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 1.35), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }))
  face.position.set(0, 3.6, 0.24)
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 6), new THREE.MeshStandardMaterial({ color: palette.woodDark, flatShading: true }))
  cap.position.y = 4.45
  const sign = new THREE.Group()
  sign.add(post, board, face, cap)
  sign.position.set(x, GROUND, z)
  sign.rotation.y = 0.25
  sign.scale.setScalar(1.9) // big enough to read from the usual camera distance
  return sign
}
