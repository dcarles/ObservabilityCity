// Puts time travel on a page: the controller, the button and popup, and the moment an address asks for (?at=). Always starts live otherwise.

import { HistoryController, type HistoryHost } from './controller'
import { addressLive, requestedAt } from './model'
import { mountHistory, type HistoryMount } from './ui'

export function startHistory(host: HistoryHost, mount: HistoryMount, search: string = window.location.search): HistoryController {
  const controller = new HistoryController(host)
  mountHistory(controller, mount)
  void controller.loadRange().then((enabled) => {
    const at = requestedAt(search)
    // a link to a moment opens paused on it: a link points at a moment, it does not start a replay
    if (enabled && at !== null) void controller.goTo(at, { paused: true })
  })
  // leaving the past takes the moment out of the address, so a reload does not jump back to it
  let wasActive = false
  controller.subscribe(() => {
    const active = controller.state.active
    if (wasActive && !active && new URLSearchParams(window.location.search).has('at')) {
      window.history.replaceState(null, '', addressLive(window.location))
    }
    wasActive = active
  })
  return controller
}
