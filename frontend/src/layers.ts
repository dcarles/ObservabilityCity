// The layer toggles in the top bar, as pure functions. A layer is a family of things the town draws; turning one off hides it and stops
// its traffic, so a busy town can be read one family at a time. The state lives in the address (?hide=traffic,workers and ?show=dependencies).

import type { NodeKind } from './types'

export type Layer = 'traffic' | 'messaging' | 'databases' | 'workers' | 'dependencies'

export interface LayerInfo {
  id: Layer
  label: string
  /** One line saying what the layer is. */
  hint: string
  /** Shown unless the address says otherwise. */
  on: boolean
}

export const LAYERS: readonly LayerInfo[] = [
  { id: 'traffic', label: 'Traffic', hint: 'The cars: requests on the roads', on: true },
  { id: 'messaging', label: 'Messaging', hint: 'Boats, crates, the dead-letter pen and the port board', on: true },
  { id: 'databases', label: 'Databases', hint: 'Data stores and caches, with their tenant yards', on: true },
  { id: 'workers', label: 'Workers', hint: 'Workers and scheduled jobs', on: true },
  { id: 'dependencies', label: 'Dependencies', hint: 'An arc between islands that call each other, thicker for more traffic', on: false },
]

export type LayerState = Record<Layer, boolean>

export const DEFAULT_LAYERS: LayerState = Object.fromEntries(LAYERS.map((l) => [l.id, l.on])) as LayerState

const isLayer = (name: string): name is Layer => LAYERS.some((l) => l.id === name)

/** The names in a comma list that are layers, in the order written. Others are ignored. */
const names = (values: readonly string[]): Layer[] =>
  values.flatMap((v) => v.split(',')).map((v) => v.trim().toLowerCase()).filter(isLayer)

/** The layer state an address asks for: ?hide=a,b turns layers off, ?show=a turns one on (dependencies are off until shown). */
export function parseLayers(search: string): LayerState {
  const q = new URLSearchParams(search)
  const state = { ...DEFAULT_LAYERS }
  for (const l of names(q.getAll('hide'))) state[l] = false
  for (const l of names(q.getAll('show'))) state[l] = true
  return state
}

/** The address parameters that give this state back: what is hidden that is normally shown, and what is shown that is normally hidden. */
export function layerParams(state: LayerState): { hide: string; show: string } {
  const pick = (want: boolean) => LAYERS.filter((l) => l.on === want && state[l.id] !== want).map((l) => l.id).join(',')
  return { hide: pick(true), show: pick(false) }
}

export function toggleLayer(state: LayerState, layer: Layer): LayerState {
  return { ...state, [layer]: !state[layer] }
}

/** The layer a kind of building belongs to, or null for the buildings no toggle hides (APIs, the gateway, the broker, egress). */
export function layerOfKind(kind: NodeKind): 'databases' | 'workers' | null {
  switch (kind) {
    case 'Database':
    case 'Cache':
      return 'databases'
    case 'Worker':
    case 'Cron':
      return 'workers'
    default:
      return null
  }
}

/** Whether a building of this kind is drawn. */
export function buildingShown(kind: NodeKind, state: LayerState): boolean {
  const layer = layerOfKind(kind)
  return layer === null || state[layer]
}

/** The button's label: "Layers" when all is as usual, else how many are off. */
export function layersLabel(state: LayerState): string {
  const off = LAYERS.filter((l) => l.on && !state[l.id]).length
  return off === 0 ? 'Layers' : `Layers · ${off} off`
}
