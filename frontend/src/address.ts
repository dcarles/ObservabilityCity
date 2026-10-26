// The view in the address bar: which islands, which layers. Everything else in the address (env, test flags, theme) is left as it is.

import { layerParams, type LayerState } from './layers'
import { islandsParam } from './islands'

/** The query string with the island and layer choices set to the given ones. Anything else in it is kept; a choice that is the usual one leaves no trace. */
export function withView(search: string, view: { islands: readonly string[]; layers: LayerState }): string {
  const q = new URLSearchParams(search)
  for (const key of ['islands', 'hide', 'show']) q.delete(key)
  const islands = islandsParam(view.islands)
  const { hide, show } = layerParams(view.layers)
  if (islands) q.set('islands', islands)
  if (hide) q.set('hide', hide)
  if (show) q.set('show', show)
  const text = q.toString().replace(/%2C/g, ',')
  return text ? `?${text}` : ''
}
