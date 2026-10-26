import { describe, expect, it } from 'vitest'
import { buildingShown, DEFAULT_LAYERS, layerOfKind, layerParams, LAYERS, layersLabel, parseLayers, toggleLayer } from '../../src/layers'
import type { NodeKind } from '../../src/types'

describe('layers from the address', () => {
  it('shows every layer but the dependencies when the address says nothing', () => {
    expect(parseLayers('')).toEqual({ traffic: true, messaging: true, databases: true, workers: true, dependencies: false })
    expect(parseLayers('?env=prod&islands=aa')).toEqual(DEFAULT_LAYERS)
  })

  it('hides what ?hide= names', () => {
    expect(parseLayers('?hide=traffic,workers')).toMatchObject({ traffic: false, workers: false, messaging: true, databases: true })
    expect(parseLayers('?hide=traffic&hide=messaging')).toMatchObject({ traffic: false, messaging: false })
  })

  it('shows the dependencies when ?show= names them', () => {
    expect(parseLayers('?show=dependencies').dependencies).toBe(true)
  })

  it('ignores names that are not layers, and does not mind case or spaces', () => {
    expect(parseLayers('?hide=cars,%20Traffic%20,')).toMatchObject({ traffic: false, workers: true })
    expect(parseLayers('?hide=')).toEqual(DEFAULT_LAYERS)
  })

  it('gives the address parameters back, so the view can be shared', () => {
    expect(layerParams(DEFAULT_LAYERS)).toEqual({ hide: '', show: '' })
    const state = toggleLayer(toggleLayer(DEFAULT_LAYERS, 'workers'), 'dependencies')
    expect(layerParams(state)).toEqual({ hide: 'workers', show: 'dependencies' })
    expect(parseLayers(`?hide=${layerParams(state).hide}&show=${layerParams(state).show}`)).toEqual(state)
  })
})

describe('what a layer covers', () => {
  it.each([
    ['Database', 'databases'],
    ['Cache', 'databases'],
    ['Worker', 'workers'],
    ['Cron', 'workers'],
    ['Api', null],
    ['Gateway', null],
    ['Broker', null],
    ['Egress', null],
  ] as const)('%s belongs to %s', (kind, layer) => {
    expect(layerOfKind(kind as NodeKind)).toBe(layer)
  })

  it('hides the buildings of a layer that is off and no others', () => {
    const noDb = toggleLayer(DEFAULT_LAYERS, 'databases')
    expect(buildingShown('Database', noDb)).toBe(false)
    expect(buildingShown('Cache', noDb)).toBe(false)
    expect(buildingShown('Worker', noDb)).toBe(true)
    expect(buildingShown('Api', noDb)).toBe(true)
    const noWorkers = toggleLayer(DEFAULT_LAYERS, 'workers')
    expect(buildingShown('Worker', noWorkers)).toBe(false)
    expect(buildingShown('Cron', noWorkers)).toBe(false)
    expect(buildingShown('Database', noWorkers)).toBe(true)
  })

  it('has a label and a hint for every layer', () => {
    expect(LAYERS.map((l) => l.id)).toEqual(['traffic', 'messaging', 'databases', 'workers', 'dependencies'])
    for (const l of LAYERS) { expect(l.label).not.toBe(''); expect(l.hint).not.toBe('') }
  })

  it('says how many layers are off on the button, not counting the dependencies that are off to begin with', () => {
    expect(layersLabel(DEFAULT_LAYERS)).toBe('Layers')
    expect(layersLabel(toggleLayer(DEFAULT_LAYERS, 'traffic'))).toBe('Layers · 1 off')
    expect(layersLabel(toggleLayer(toggleLayer(DEFAULT_LAYERS, 'traffic'), 'workers'))).toBe('Layers · 2 off')
    expect(layersLabel(toggleLayer(DEFAULT_LAYERS, 'dependencies'))).toBe('Layers')
  })
})
