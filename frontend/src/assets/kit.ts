import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { activeKit } from '../themes/active'

/** Model files from the CC0 KayKit "City Builder Bits" pack, shipped under /themes/harbour-town/kaykit. */
const FILES = [
  'road_straight', 'road_corner', 'road_junction', 'road_tsplit',
  'car_hatchback', 'car_sedan', 'car_taxi', 'car_stationwagon', 'car_police',
  'streetlight', 'bench', 'bush', 'watertower', 'firehydrant', 'dumpster', 'trash_A', 'trash_B', 'box_A', 'box_B', 'trafficlight_A',
] as const

export type KitName = (typeof FILES)[number]

const loaded = new Map<KitName, THREE.Object3D>()
let loading: Promise<void> | null = null

/** Loads every kit model once. Call and await before building the town. */
export function loadKit(): Promise<void> {
  loading ??= (async () => {
    const loader = new GLTFLoader()
    await Promise.all(
      FILES.map(async (name) => {
        const gltf = await loader.loadAsync(`/themes/harbour-town/kaykit/${name}.gltf`)
        gltf.scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true
            o.receiveShadow = true
            const m = o.material as THREE.MeshStandardMaterial
            m.roughness = Math.max(m.roughness, 0.8)
            m.metalness = 0
            if (m.map) m.map.anisotropy = 8
          }
        })
        loaded.set(name, gltf.scene)
      }),
    )
  })()
  return loading
}

const tinted = new Map<string, THREE.Material>()

/** The same material in the theme's road colour: shared by every copy, so tinting adds a handful of materials, not one per tile. */
function tintOf(material: THREE.Material, tint: string): THREE.Material {
  const key = `${material.uuid}|${tint}`
  let t = tinted.get(key)
  if (!t) {
    t = material.clone()
    ;(t as THREE.MeshStandardMaterial).color.multiply(new THREE.Color(tint))
    tinted.set(key, t)
  }
  return t
}

/** A fresh copy of a kit model. Geometry and material are shared, so copies are cheap. Roads and lamps take the theme's tint. */
export function kit(name: KitName): THREE.Object3D {
  const o = loaded.get(name)
  if (!o) throw new Error(`Kit model ${name} is not loaded yet`)
  const copy = o.clone(true)
  const tint = activeKit().roadTint
  if (tint && (name.startsWith('road_') || name === 'streetlight' || name === 'trafficlight_A')) {
    copy.traverse((c) => { if (c instanceof THREE.Mesh) c.material = tintOf(c.material as THREE.Material, tint) })
  }
  return copy
}

/** The geometry and material of a kit model, for instancing. Transforms of its node are baked in. */
export function kitParts(name: KitName): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  const o = loaded.get(name)
  if (!o) throw new Error(`Kit model ${name} is not loaded yet`)
  o.updateMatrixWorld(true)
  let found: THREE.Mesh | null = null
  o.traverse((c) => { if (!found && c instanceof THREE.Mesh) found = c })
  const mesh = found as THREE.Mesh | null
  if (!mesh) throw new Error(`Kit model ${name} has no mesh`)
  const geometry = mesh.geometry.clone()
  geometry.applyMatrix4(mesh.matrixWorld)
  return { geometry, material: mesh.material as THREE.Material }
}
