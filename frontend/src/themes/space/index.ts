import * as THREE from 'three'
import { box, cyl, flat, group, sphere } from '../../buildings/mk'
import type { ThemeKit } from '../types'
import { glow } from '../common'
import { spaceLighting, spacePalette } from './palette'
import { spaceModel } from './models'
import { spaceVehicles } from './vehicles'
import { spaceBridge, spacePier } from './links'

/** Little things for the platform's streets: a cargo pod for a dumpster, a light post for a hydrant, a crystal cluster for a bush. */
function spaceProp(name: string): THREE.Object3D | null {
  const metal = flat('#59618f', { metalness: 0.4 })
  let o: THREE.Object3D
  switch (name) {
    case 'bush': o = group(sphere(0.5, flat('#6fdcff', { roughness: 0.3 }), { y: 0.5 }, 6), sphere(0.34, flat('#a98bff', { roughness: 0.3 }), { x: 0.5, y: 0.34, z: 0.2 }, 6), sphere(0.3, flat('#5eefc3', { roughness: 0.3 }), { x: -0.4, y: 0.3, z: -0.3 }, 6)); break
    case 'firehydrant': o = group(cyl(0.12, 0.16, 1.0, metal, {}, 8), sphere(0.16, glow('#6fe7ff'), { y: 1.05 }, 8)); break
    case 'dumpster': o = group(box(1.5, 0.9, 1.0, flat('#7684d8', { metalness: 0.3 })), box(1.54, 0.08, 1.04, glow('#6fe7ff'), { y: 0.9 })); break
    case 'trash_A': case 'trash_B': o = group(cyl(0.32, 0.32, 0.8, metal, {}, 10), cyl(0.34, 0.34, 0.05, glow('#a98bff'), { y: 0.8 }, 10)); break
    default: o = group(box(0.9, 0.7, 0.9, flat('#ffb347', { metalness: 0.2 })), box(0.94, 0.06, 0.94, glow('#6fe7ff'), { y: 0.7 })); break
  }
  o.userData.themed = true
  return o
}

/** Orbital colony: platforms in a violet void, habitat modules and reactors, light bridges, hover pods and cargo shuttles. */
export const spaceColony: ThemeKit = {
  id: 'space',
  palette: spacePalette,
  lighting: spaceLighting,
  buildModel: spaceModel,
  vehicles: spaceVehicles,
  bridge: spaceBridge,
  pier: spacePier,
  roadTint: '#9ea9d6',
  stars: true,
  prop: spaceProp,
}
