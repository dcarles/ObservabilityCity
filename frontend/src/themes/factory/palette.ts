import type { Palette } from '../types'
import { harbourPalette } from '../harbour-town/palette'
import type { Lighting, LightingPreset } from '../../lighting'

// Works: concrete yards, brick halls and steel, beside a dark coolant canal. The signal colours (beacons) are the harbour town's, unchanged.

export const factoryPalette: Palette = {
  sky: { top: '#8fa9bf', horizon: '#ece6d8' },
  fog: '#cfd2d0',
  sea: { deep: '#36565e', shallow: '#5c8a8c', mid: '#7faaa8', foam: '#e4e8e2', sparkle: 0.08 },
  island: {
    grass: '#aaa89d',
    grassDark: '#9a988b',
    lawn: '#bab8ac',
    sand: '#d7d1bd',
    cliff: '#716b61',
    cliffDark: '#57524a',
    road: '#41454a',
    roadLine: '#f2c230',
    pavement: '#c1bdae',
    plot: '#d0ccbd',
    hill: '#9d9c8d',
    rock: '#6e6c66',
  },
  hedge: '#8a8f78',
  tree: { park: '#7b8e84', trunk: '#5b5a55', leaves: ['#7b8e84', '#6c8175', '#899a8e', '#72857b'], pine: ['#5a7064', '#66806f'] },
  beacon: harbourPalette.beacon,
  window: { glass: '#3e5870', lit: '#ffd98a', dead: '#262a31' },
  wood: '#8b8f94',
  woodDark: '#5c6168',
  stone: '#cdc8ba',
  building: {
    apiBody: '#cfd6dc',
    apiPodium: '#bdb8a8',
    workerBody: '#b5573d',
    workerRoof: '#5c6168',
    dbTank: '#5f8fb0',
    dbBand: '#3f6a8a',
    cacheTank: '#e8b230',
    cacheLegs: '#5c6168',
    functionStone: '#c9c0aa',
    functionRoof: '#b5573d',
    gatewayStone: '#c8c2b0',
    gatewayAccent: '#f2c230',
    brokerWall: '#46607a',
    brokerRoof: '#e07a3f',
    egressBody: '#c3ccd4',
    egressDish: '#f5f5f5',
  },
  flagFallback: '#8ab4ff',
  walker: { skin: '#f2c9a0', failed: '#ff3d3d' },
}

export const factoryLighting: Record<Lighting, LightingPreset> = {
  day: {
    name: 'Day',
    sky: { top: '#8fa9bf', horizon: '#ece6d8' },
    fog: '#cfd2d0',
    sea: { deep: '#36565e', shallow: '#5c8a8c' },
    hemisphere: { sky: '#dfe8ee', ground: '#b5ad98', intensity: 1.15 },
    sun: { color: '#fff1d8', intensity: 2.5 },
    exposure: 1.05,
    windowGlow: 1,
    sunOffset: { x: -70, y: 110, z: 60 },
    page: '#d4dde4',
  },
  dusk: {
    name: 'Dusk',
    sky: { top: '#2a2f45', horizon: '#e8864a' },
    fog: '#7d6a62',
    sea: { deep: '#1f3a42', shallow: '#3f6670' },
    hemisphere: { sky: '#a49cc8', ground: '#7a645a', intensity: 1.3 },
    sun: { color: '#ffa860', intensity: 2.4 },
    exposure: 1,
    windowGlow: 2.6,
    sunOffset: { x: -125, y: 46, z: 45 },
    page: '#2a2f45',
  },
}
