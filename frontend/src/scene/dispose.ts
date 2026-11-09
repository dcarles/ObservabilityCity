import * as THREE from 'three'

const TEXTURE_SLOTS = ['map', 'alphaMap', 'aoMap', 'bumpMap', 'emissiveMap', 'envMap', 'lightMap', 'metalnessMap', 'normalMap', 'roughnessMap'] as const

/**
 * Frees the graphics memory of everything under `objects`: geometries, materials and the textures they use (the canvas-drawn name boards among them).
 * Removing an object from the scene frees none of it, so a town rebuilt again and again would grow until the browser gave up.
 * A geometry or material that is still wanted afterwards is simply uploaded again the next time it is drawn, so an object shared with the new town is safe.
 */
export function disposeTree(objects: readonly THREE.Object3D[]): number {
  const seen = new Set<unknown>()
  let freed = 0
  const free = (thing: { dispose(): void }): void => {
    if (seen.has(thing)) return
    seen.add(thing)
    thing.dispose()
    freed++
  }
  for (const root of objects) {
    root.traverse((o) => {
      const drawn = o as THREE.Mesh
      if (drawn.geometry) free(drawn.geometry)
      const material = drawn.material as THREE.Material | THREE.Material[] | undefined
      for (const m of Array.isArray(material) ? material : material ? [material] : []) {
        for (const slot of TEXTURE_SLOTS) {
          const t = (m as unknown as Record<string, unknown>)[slot]
          if (t instanceof THREE.Texture) free(t)
        }
        free(m)
      }
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose()
    })
  }
  return freed
}
