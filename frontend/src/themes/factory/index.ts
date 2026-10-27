import * as THREE from 'three'
import { box, cyl, flat, group } from '../../buildings/mk'
import { factoryAirport } from './airport'
import type { ThemeKit } from '../types'
import { factoryLighting, factoryPalette } from './palette'
import { factoryModel } from './models'
import { factoryVehicles } from './vehicles'
import { factoryBridge, factoryPier } from './links'

/** Oil drums stand in for the bush; the kit's dumpsters, crates and bins already belong in a works. */
function factoryProp(name: string): THREE.Object3D | null {
  if (name !== 'bush') return null
  const drum = (x: number, z: number, c: string) => group(cyl(0.34, 0.34, 0.9, flat(c, { metalness: 0.3 }), { x, z }, 12), cyl(0.36, 0.36, 0.06, flat('#23272d'), { x, y: 0.5, z }, 12))
  const o = group(drum(0, 0, '#3f7fc9'), drum(0.75, 0.2, '#d9573f'), drum(0.3, 0.8, '#f2c230'), box(1.6, 0.06, 1.6, flat('#8b8f94'), { x: 0.35, y: -0.02, z: 0.35 }))
  o.userData.themed = true
  return o
}

/** Works: concrete yards and brick halls beside a coolant canal, steel truss bridges, delivery vans and container barges. */
export const factoryWorks: ThemeKit = {
  id: 'factory',
  palette: factoryPalette,
  lighting: factoryLighting,
  buildModel: factoryModel,
  vehicles: factoryVehicles,
  bridge: factoryBridge,
  pier: factoryPier,
  airport: factoryAirport,
  roadTint: null,
  stars: false,
  prop: factoryProp,
}
