import type { Palette } from '../types'
import { harbourPalette } from '../harbour-town/palette'
import type { Lighting, LightingPreset } from '../../lighting'

// Orbital colony: platforms of regolith and plating drifting in a deep-violet void. The signal colours (beacons) are the harbour town's, unchanged.

export const spacePalette: Palette = {
  sky: { top: '#0a1240', horizon: '#4b3fa8' },
  fog: '#232063',
  sea: { deep: '#0d1033', shallow: '#26308a', mid: '#3a5fbf', foam: '#8ff0ff', sparkle: 0.025 },
  island: {
    grass: '#8590b8',
    grassDark: '#727ea8',
    lawn: '#97a2c8',
    sand: '#c9d0ec',
    cliff: '#4d5379',
    cliffDark: '#383d5e',
    road: '#343a52',
    roadLine: '#7be3ff',
    pavement: '#a4acd0',
    plot: '#b4bcdc',
    hill: '#7783b0',
    rock: '#5d658c',
  },
  hedge: '#2aa59b',
  tree: { park: '#7be3ff', trunk: '#4a5078', leaves: ['#6fdcff', '#a98bff', '#5eefc3', '#d78bff'], pine: ['#4ac9f2', '#8f7bff'] },
  beacon: harbourPalette.beacon,
  window: { glass: '#1a2650', lit: '#b9f6ff', dead: '#12162b' },
  wood: '#8c96bd',
  woodDark: '#59618a',
  stone: '#c7cde6',
  building: {
    apiBody: '#dfe6fa',
    apiPodium: '#c5cdea',
    workerBody: '#5c6fd6',
    workerRoof: '#39406b',
    dbTank: '#6fb5e8',
    dbBand: '#3f78b0',
    cacheTank: '#ffb347',
    cacheLegs: '#7a7fa8',
    cronStone: '#cfd4ee',
    cronRoof: '#a46bff',
    gatewayStone: '#d9def5',
    gatewayAccent: '#59e0ff',
    brokerWall: '#2c3a78',
    brokerRoof: '#8f6bff',
    egressBody: '#c6cdee',
    egressDish: '#f2f4ff',
  },
  flagFallback: '#8ab4ff',
  walker: { skin: '#d9e2ff', failed: '#ff3d3d' },
}

export const spaceLighting: Record<Lighting, LightingPreset> = {
  day: {
    name: 'Day',
    sky: { top: '#0a1240', horizon: '#4b3fa8' },
    fog: '#232063',
    sea: { deep: '#0d1033', shallow: '#26308a' },
    hemisphere: { sky: '#b9c6ff', ground: '#4a4f86', intensity: 1.25 },
    sun: { color: '#fff4e0', intensity: 2.8 },
    exposure: 1.1,
    windowGlow: 1.3,
    sunOffset: { x: -80, y: 100, z: 50 },
    page: '#0a1240',
  },
  dusk: {
    name: 'Dusk',
    sky: { top: '#02030d', horizon: '#241a5c' },
    fog: '#0e0c2e',
    sea: { deep: '#05061a', shallow: '#12185a' },
    hemisphere: { sky: '#8a94ee', ground: '#4a4486', intensity: 1.35 },
    sun: { color: '#d3b0ff', intensity: 2.1 },
    exposure: 1,
    windowGlow: 2.8,
    sunOffset: { x: -125, y: 40, z: 45 },
    page: '#02030d',
  },
}
