import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/** Same look means same key: materials made separately with equal settings share one merged mesh. */
function materialKey(m: THREE.Material): string {
  const any = m as THREE.MeshStandardMaterial & THREE.MeshBasicMaterial
  if (any.map || any.vertexColors || any.alphaMap) return m.uuid
  const hex = (c?: THREE.Color) => (c ? c.getHexString() : '-')
  return [m.type, hex(any.color), hex(any.emissive), any.emissiveIntensity, any.roughness, any.metalness, any.flatShading, m.transparent, m.opacity, m.side, m.depthWrite, m.toneMapped].join('|')
}

/**
 * Collapses a group of scenery that never changes into a handful of meshes, one for each look. A town of 15 islands has
 * thousands of road tiles, lamps and bushes, and each separate mesh is a draw call. Anything that must keep its own
 * object (animated, picked, instanced or carrying a texture of its own) is left where it is.
 */
export function mergeStatic(root: THREE.Object3D): THREE.Object3D {
  root.updateWorldMatrix(true, true)
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const groups = new Map<string, { material: THREE.Material; shadow: boolean; receive: boolean; geometries: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>()

  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return
    if (Array.isArray(mesh.material) || !mesh.visible || mesh.userData.keep) return
    const geo = mesh.geometry
    if (!geo.attributes.position || geo.attributes.color || geo.morphAttributes.position) return
    const key = `${materialKey(mesh.material)}|${mesh.castShadow}|${mesh.receiveShadow}`
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { material: mesh.material, shadow: mesh.castShadow, receive: mesh.receiveShadow, geometries: [], meshes: [] }))
    const baked = geo.clone()
    baked.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld))
    g.geometries.push(baked)
    g.meshes.push(mesh)
  })

  for (const g of groups.values()) {
    if (g.meshes.length < 2) { g.geometries.forEach((x) => x.dispose()); continue }
    const needUv = g.geometries.some((x) => x.attributes.uv)
    const mixedIndex = g.geometries.some((x) => x.index) && g.geometries.some((x) => !x.index)
    const parts = g.geometries.map((x) => {
      let p = mixedIndex ? x.toNonIndexed() : x
      if (!p.attributes.normal) p.computeVertexNormals()
      if (needUv && !p.attributes.uv) p.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(p.attributes.position.count * 2), 2))
      if (!needUv && p.attributes.uv) p.deleteAttribute('uv')
      for (const name of Object.keys(p.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') p.deleteAttribute(name)
      return p
    })
    const merged = mergeGeometries(parts, false)
    if (!merged) continue
    const out = new THREE.Mesh(merged, g.material)
    out.castShadow = g.shadow
    out.receiveShadow = g.receive
    out.matrixAutoUpdate = false
    root.add(out)
    for (const m of g.meshes) m.parent?.remove(m)
  }
  return root
}
