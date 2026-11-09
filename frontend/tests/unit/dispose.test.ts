import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { disposeTree } from '../../src/scene/dispose'

describe('freeing the graphics memory of a removed part of the town', () => {
  it('disposes every geometry, material and texture under the objects once, shared ones too', () => {
    const geometry = new THREE.BoxGeometry()
    const shared = new THREE.MeshStandardMaterial()
    const texture = new THREE.Texture()
    const board = new THREE.MeshBasicMaterial({ map: texture })
    const a = new THREE.Group()
    a.add(new THREE.Mesh(geometry, shared), new THREE.Mesh(new THREE.BoxGeometry(), [shared, board]))
    const b = new THREE.Mesh(geometry, shared)
    const disposed: string[] = []
    geometry.addEventListener('dispose', () => disposed.push('geometry'))
    shared.addEventListener('dispose', () => disposed.push('shared'))
    texture.addEventListener('dispose', () => disposed.push('texture'))
    board.addEventListener('dispose', () => disposed.push('board'))

    const freed = disposeTree([a, b])

    expect(disposed.sort()).toEqual(['board', 'geometry', 'shared', 'texture']) // each once, though used by several meshes
    expect(freed).toBe(5) // two geometries, two materials, one texture
  })

  it('handles a line, a sprite and an object with nothing to free', () => {
    const root = new THREE.Group()
    root.add(new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial()), new THREE.Object3D())
    expect(disposeTree([root])).toBe(2)
  })
})
