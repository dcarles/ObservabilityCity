import './style.css'
import * as THREE from 'three'
import { Stage } from './scene/stage'
import { Town } from './scene/town'
import { loadKit } from './assets/kit'
import { Connection } from './connection'
import { NoticesPanel, PreviewPanel, Search, showTooltip, StateList, TopBar, type SearchItem } from './ui'
import type { PickItem } from './picker'
import type { Snapshot } from './types'
import { checkSnapshot } from './snapshotGuard'
import { Building } from './buildings/building'

void start()

async function start(): Promise<void> {
  await loadKit()
  const canvas = document.getElementById('town') as HTMLCanvasElement
  const stage = new Stage(canvas)
  const town = new Town()
  stage.scene.add(town.root)

  stage.onQualityStep = (to) => {
    const banner = document.getElementById('banner')
    if (!banner) return
    banner.textContent = to === 'medium'
      ? 'Running slowly, so shadows now update a few times a second. Add ?quality=high to the address to keep full detail.'
      : 'Still slow: shadows are off. Add ?quality=high to the address to keep full detail.'
    banner.hidden = false
    window.setTimeout(() => { banner.hidden = true }, 9000)
  }

  /** Glides the camera to an island or a building and keeps its name board up. */
  function goTo(item: PickItem): void {
    const focus = item.kind === 'island' ? town.islandFocusOf(item.id) : town.focusOf(item.id)
    town.select(item.kind === 'building' ? item.id : null)
    if (focus) stage.focus(focus.target, focus.distance)
  }

  const stateList = new StateList(
    (state) => {
      const groups = seen.last?.groups ?? []
      if (state === 'Incidents')
        return groups.filter((g) => g.incidents.length > 0).map<PickItem>((g) => ({ kind: 'island', id: g.id, name: g.displayName, where: `sev ${g.incidents[0].severity}, ${g.incidents.length} open` }))
      const inGroups = groups.flatMap((g) => g.nodes.filter((n) => n.state === state).map<PickItem>((n) => ({ kind: 'building', id: n.id, name: n.name, where: g.displayName, state: n.state })))
      const vendors = (seen.last?.vendors ?? []).filter((v) => v.node.state === state).map<PickItem>((v) => ({ kind: 'building', id: v.node.id, name: v.node.name, where: 'Third party', state: v.node.state }))
      return [...inGroups, ...vendors]
    },
    goTo,
  )
  const topbar = new TopBar(() => stage.home(), (state, anchor) => stateList.toggle(state, anchor), (on) => { town.overlay.visible = on })
  const notices = new NoticesPanel()
  const buildingItems = (): SearchItem[] => {
    const items: SearchItem[] = []
    for (const isl of town.islands)
      for (const [id, b] of isl.buildings) items.push({ kind: 'building', id, name: b.node?.name ?? id, where: isl.group.displayName })
    for (const [id, b] of town.buildings) if (id.startsWith('hub.')) items.push({ kind: 'building', id, name: b.node?.name ?? id, where: 'Platform hub' })
    for (const [id, v] of town.vendors) items.push({ kind: 'building', id, name: v.building.node?.name ?? id, where: 'Third party' })
    return items
  }
  const islandItems = (): SearchItem[] => town.islands.map((i) => ({ kind: 'island', id: i.group.id, name: i.group.displayName, where: i.group.displayName }))
  const airportItem = (): SearchItem[] => (town.airport ? [{ kind: 'island', id: 'airport', name: 'Airport', where: 'Outside callers' }] : [])
  const preview = new PreviewPanel(() => [
    { kind: 'town', id: '*', name: 'Whole town', where: '' },
    { kind: 'island', id: 'hub', name: 'Island: Platform hub', where: 'Platform hub' },
    ...islandItems().map((i) => ({ ...i, name: `Island: ${i.name}` })),
    ...buildingItems(),
  ])

  const search = new Search(() => [...islandItems(), ...airportItem(), ...buildingItems()], goTo)
  void search

  // What the page has shown so far, for tests and for poking from the console.
  const seen = { snapshots: 0, rejected: 0, buildErrors: 0, buildMs: 0, last: null as Snapshot | null }
  const reportedProblems = new Set<string>()

  function onSnapshot(raw: unknown): void {
    // A snapshot that cannot be drawn is dropped and the town keeps showing the last good one.
    const { snapshot: s, problems } = checkSnapshot(raw)
    for (const p of problems) {
      if (reportedProblems.has(p)) continue
      reportedProblems.add(p)
      console.warn(`Snapshot problem: ${p}`)
    }
    if (!s) {
      seen.rejected++
      topbar.setStatus('badData')
      return
    }
    try {
      if (!town.matches(s)) {
        const started = performance.now()
        town.root.remove(...town.root.children.filter((c) => c !== town.cars.object && c !== town.boats.object && c !== town.overlay.object))
        town.buildings.clear()
        town.islands.length = 0
        town.extent.length = 0
        town.bounds.makeEmpty()
        town.build(s)
        seen.buildMs = performance.now() - started
        stage.frame(town.extent)
        stage.home(true)
        void preview.refresh()
      }
      town.apply(s)
    } catch (e) {
      // the layout could not be built: try again with the next snapshot instead of leaving a half-built town for good
      seen.buildErrors++
      town.invalidate()
      console.error('Could not draw the town from this snapshot:', e)
      topbar.setStatus('badData')
      return
    }
    seen.snapshots++
    seen.last = s
    topbar.setStatus('live') // a good snapshot just arrived, whatever the last bad one said
    topbar.setSnapshot(s)
    stateList.refresh()
    notices.show(s.notices)
  }

  const connection = new Connection(onSnapshot, (st) => topbar.setStatus(st))
  connection.start()

  // Hover: name and numbers for the building under the pointer.
  const ray = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let pointerPx = { x: 0, y: 0 }
  let dirty = false
  canvas.addEventListener('pointermove', (e) => {
    pointerPx = { x: e.clientX, y: e.clientY }
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1)
    dirty = true
  })
  canvas.addEventListener('pointerleave', () => showTooltip(null, 0, 0))
  // A click (not a drag) on a building glides the camera to it and keeps its name board visible; a click on the sea lets go.
  let down: { x: number; y: number } | null = null
  canvas.addEventListener('pointerdown', (e) => { stage.cancelGlide(); down = { x: e.clientX, y: e.clientY } })
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return
    down = null
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1)
    ray.setFromCamera(pointer, stage.camera)
    const hit = ray.intersectObjects([...town.buildings.values()].map((b) => b.hit), false)[0]
    const b = hit?.object.userData.building as Building | undefined
    town.select(b?.id ?? null)
    const focus = b ? town.focusOf(b.id) : null
    if (focus) stage.focus(focus.target, focus.distance)
  })

  function hover(): void {
    if (!dirty) return
    dirty = false
    ray.setFromCamera(pointer, stage.camera)
    const hits = ray.intersectObjects([...town.buildings.values()].map((b) => b.hit), false)
    const b = hits[0]?.object.userData.building as Building | undefined
    showTooltip(b?.node ?? null, pointerPx.x, pointerPx.y)
    canvas.style.cursor = b ? 'pointer' : 'grab'
  }

  // ?test=1 is for automated tests: nothing is drawn on its own, and time moves only when the test calls city.step(seconds).
  // Software rendering draws a frame in seconds, so tests read the scene's state instead of waiting for frames.
  const testMode = new URLSearchParams(window.location.search).has('test')
  let simTime = 0
  function step(seconds: number, dt = 0.1): void {
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      simTime += dt
      stage.tick(dt, simTime)
      town.update(dt, simTime, stage.camera)
    }
  }

  // Debug handle for automated tests, screenshots and poking from the console.
  ;(window as unknown as { city: unknown }).city = {
    stage, town, THREE, seen, step,
    /** Hand the page a snapshot as if the server had sent it. */
    feed: (raw: unknown) => onSnapshot(raw),
    inspect: (id: string) => town.inspect(id),
    inspectIsland: (id: string) => town.inspectIsland(id),
    inspectAirport: () => town.inspectAirport(),
    inspectVendors: () => town.inspectVendors(),
    overlay: () => town.overlay.status(),
    /** Draw once and say how much that took: draw calls, triangles and milliseconds. */
    measureFrame: () => {
      const t0 = performance.now()
      stage.render()
      const ms = performance.now() - t0
      const info = stage.renderer.info.render
      return { ms, calls: info.calls, triangles: info.triangles }
    },
  }

  const clock = new THREE.Clock()
  const failed = new Set<string>()
  function frame(): void {
    // schedule the next frame first, so an error below can never stop the loop
    requestAnimationFrame(frame)
    const dt = Math.min(clock.getDelta(), 0.1)
    const time = clock.elapsedTime
    try {
      stage.tick(dt, time)
      town.update(dt, time, stage.camera)
      hover()
      stage.render()
    } catch (e) {
      const key = String(e)
      if (!failed.has(key)) {
        failed.add(key)
        console.error('Frame failed, carrying on:', e)
      }
    }
  }
  if (!testMode) frame()
}
