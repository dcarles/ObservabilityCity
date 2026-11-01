import { describe, expect, it } from 'vitest'
import { withView } from '../../src/address'
import { DEFAULT_LAYERS, parseLayers } from '../../src/layers'
import { parseIslands } from '../../src/islands'

describe('the view in the address', () => {
  it('leaves no trace when nothing is chosen', () => {
    expect(withView('', { islands: [], layers: DEFAULT_LAYERS })).toBe('')
    expect(withView('?env=prod', { islands: [], layers: DEFAULT_LAYERS })).toBe('?env=prod')
  })

  it('writes islands sorted, and layers that differ from the usual', () => {
    const layers = { ...DEFAULT_LAYERS, traffic: false, workers: false, dependencies: true }
    expect(withView('?env=prod', { islands: ['pay', 'cl'], layers })).toBe('?env=prod&islands=cl,pay&hide=traffic,workers&show=dependencies')
  })

  it('replaces an older choice and keeps everything else', () => {
    const next = withView('?test=1&islands=aa&hide=traffic&theme=harbour-town', { islands: ['bb'], layers: DEFAULT_LAYERS })
    expect(next).toBe('?test=1&theme=harbour-town&islands=bb')
  })

  it('round-trips through the parsers', () => {
    const layers = { ...DEFAULT_LAYERS, messaging: false, dependencies: true }
    const next = withView('', { islands: ['b', 'a'], layers })
    expect(parseIslands(next)).toEqual(['a', 'b'])
    expect(parseLayers(next)).toEqual(layers)
  })

  it('keeps the dependency focus in the address and drops it when there is none', () => {
    expect(withView('?env=prod', { islands: [], layers: DEFAULT_LAYERS, focus: 'cl' })).toBe('?env=prod&focus=cl')
    expect(withView('?focus=cl', { islands: [], layers: DEFAULT_LAYERS, focus: '' })).toBe('')
  })
})
