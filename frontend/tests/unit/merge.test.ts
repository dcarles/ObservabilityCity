import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { mergeStatic } from '../../src/scene/merge'
import { animated } from '../../src/buildings/mk'

const mesh = (color: string, x: number): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color }))
  m.position.x = x
  return m
}
const meshes = (root: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = []
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh) })
  return out
}

describe('merging the fixed parts of a building', () => {
  it('makes one mesh for each look, and keeps what a model moves, and what is under it, as it was', () => {
    const smoke = animated(mesh('#ffffff', 5))
    const crane = animated(new THREE.Group())
    const arm = mesh('#ff0000', 1)
    crane.add(arm)
    const root = new THREE.Group()
    root.add(mesh('#ff0000', 0), mesh('#ff0000', 2), mesh('#00ff00', 3), mesh('#00ff00', 4), smoke, crane)

    mergeStatic(root)

    const left = meshes(root)
    expect(left).toContain(smoke)
    expect(left).toContain(arm)
    expect(arm.parent).toBe(crane) // the crane still turns with its arm
    expect(left).toHaveLength(4) // red, green, the smoke and the arm
  })

  it('leaves a mesh alone when a part above it is hidden, as it can be shown later', () => {
    const hidden = new THREE.Group()
    hidden.visible = false
    const a = mesh('#ff0000', 0), b = mesh('#ff0000', 1)
    hidden.add(a, b)
    const root = new THREE.Group()
    root.add(hidden, mesh('#ff0000', 2), mesh('#ff0000', 3))

    mergeStatic(root)

    expect(a.parent).toBe(hidden)
    expect(b.parent).toBe(hidden)
    expect(meshes(root)).toHaveLength(3) // the two hidden ones and one merged
  })

  it('keeps every part where it was drawn', () => {
    const root = new THREE.Group()
    root.add(mesh('#ff0000', 0), mesh('#ff0000', 4))
    mergeStatic(root)
    const box = new THREE.Box3().setFromObject(root)
    expect(box.min.x).toBeCloseTo(-0.5)
    expect(box.max.x).toBeCloseTo(4.5)
  })
})
