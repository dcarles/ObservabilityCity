import './style.css'
import { isUnmonitored } from './signals'
import * as THREE from 'three'
import { Stage } from './scene/stage'
import { Town } from './scene/town'
import { rng } from './scene/random'
import { loadKit } from './assets/kit'
import { Connection } from './connection'
import { addressForTown, fetchTowns, requestedScope, type TownChoice } from './scope'
import { saveQuality, startQuality, type Quality } from './quality'
import { parseWall } from './wall/params'
import { WallMode } from './wall/wall'
import { NoticesPanel, Search, ServicePanel, showTooltip, StateList, TopBar, type SearchItem } from './ui'
import { ALL_TENANTS, pruneTenants, type TenantView } from './tenants'
import { ViewBar } from './viewbar'
import { BreakPanel } from './breakPanel'
import { FxClient } from './fxClient'
import { StoryBar } from './storyBar'
import { Inspector } from './inspector'
import { LegendCard } from './legendCard'
import { LEGEND_SEEN_KEY } from './legend'
import { browserStore, otherLighting, saveLighting, startLighting } from './lighting'
import { saveTheme, startTheme, themeById } from './themes'
import { kitById } from './themes/kits'
import { activateTheme, palette as livePalette } from './themes/active'
import { parseLayers, toggleLayer, type Layer } from './layers'
import { islandChoices, parseIslands, pruneIslands } from './islands'
import { withView } from './address'
import { viewTotals } from './viewTotals'
import type { PickItem } from './picker'
import type { Snapshot, TenantInfo } from './types'
import { checkSnapshot } from './snapshotGuard'
import { Building } from './buildings/building'
import { WINDOW_GLOW } from './buildings/windowMaterial'

void start()

async function start(): Promise<void> {
  // the theme is chosen before anything is drawn: the stage, the town and its traffic are all made from it
  const themeAsked = startTheme(window.location.search, browserStore())
  activateTheme(kitById(themeAsked.theme.id))
  await loadKit()
  const canvas = document.getElementById('town') as HTMLCanvasElement
  const stage = new Stage(canvas)
  const town = new Town()
  stage.scene.add(town.root)

  // what the address and this browser say about how to look at the town
  const query = window.location.search
  const params = new URLSearchParams(query)
  const testMode = params.has('test')
  // a test run repeats: which requests fail and when cars leave come from a seeded generator, not from Math.random
  if (testMode) town.cars.random = rng(1)
  const store = browserStore()
  const wallParams = parseWall(query)
  let islands: readonly string[] = parseIslands(query)
  let layers = parseLayers(query)
  // a wall opens on Dusk whatever this browser last chose, unless the address says otherwise
  let lighting = wallParams.on ? startLighting(query, null, 'dusk') : startLighting(query, store)
  const theme = themeAsked.theme
  town.setLayers(layers)
  stage.setLighting(lighting, true)
  document.documentElement.dataset.theme = theme.id

  /** The space under the top bar, which wraps to more rows on a narrow window: panels start below it. */
  const bar = document.getElementById('topbar')!
  const measureBar = (): void => document.documentElement.style.setProperty('--bar-h', `${bar.offsetHeight}px`)
  measureBar()
  new ResizeObserver(measureBar).observe(bar)

  const banner = document.getElementById('banner')!
  let bannerTimer: number | undefined
  /** A line at the bottom of the page that goes away by itself. */
  function say(text: string, ms = 9000): void {
    banner.textContent = text
    banner.hidden = false
    window.clearTimeout(bannerTimer)
    bannerTimer = window.setTimeout(() => { banner.hidden = true }, ms)
  }
  if (themeAsked.unknown) say(`There is no theme "${themeAsked.unknown}". Showing ${theme.name}.`)

  /** Keeps the islands and layers in the address, so the view can be bookmarked and shared. */
  function syncAddress(): void {
    const next = withView(window.location.search, { islands, layers })
    if (next !== window.location.search) window.history.replaceState(null, '', `${window.location.pathname}${next}${window.location.hash}`)
  }

  stage.onQualityStep = (to) => say(to === 'medium'
    ? 'Running slowly, so shadows now update a few times a second. Add ?quality=high to the address to keep full detail.'
    : 'Still slow: shadows are off. Add ?quality=high to the address to keep full detail.')

  /** Glides the camera to an island or a building and keeps its name board up. */
  function goTo(item: PickItem): void {
    const focus = item.kind === 'island' ? town.islandFocusOf(item.id) : town.focusOf(item.id)
    town.select(item.kind === 'building' ? item.id : null)
    if (focus) stage.focus(focus.target, focus.distance)
    if (item.kind === 'building') { servicePanel.close(); inspector.open(item.id) } else inspector.close()
  }

  const stateList = new StateList(
    (state) => {
      const groups = seen.last?.groups ?? []
      if (state === 'Incidents')
        return groups.filter((g) => g.incidents.length > 0).map<PickItem>((g) => ({ kind: 'island', id: g.id, name: g.displayName, where: `sev ${g.incidents[0].severity}, ${g.incidents.length} open` }))
      const inGroups = groups.flatMap((g) => g.nodes.filter((n) => n.state === state && !isUnmonitored(n)).map<PickItem>((n) => ({ kind: 'building', id: n.id, name: n.name, where: g.displayName, state: n.state })))
      const vendors = (seen.last?.vendors ?? []).filter((v) => v.node.state === state && !isUnmonitored(v.node)).map<PickItem>((v) => ({ kind: 'building', id: v.node.id, name: v.node.name, where: 'Third party', state: v.node.state }))
      return [...inGroups, ...vendors]
    },
    goTo,
  )
  let tenantView: TenantView = ALL_TENANTS
  const topbar = new TopBar((state, anchor) => stateList.toggle(state, anchor), () => tenantView)
  document.getElementById('home')!.addEventListener('click', () => stage.home())
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
  const scope = requestedScope()
  let towns: TownChoice[] = []
  let quality: Quality = 'high'
  const setTenantView = (v: TenantView): void => {
    tenantView = v
    town.setTenantView(v)
    topbar.refresh()
    viewBar.refresh()
  }
  const setIslands = (ids: readonly string[]): void => {
    islands = ids
    connection.setIslands(ids)
    syncAddress()
    viewBar.refresh()
  }
  const viewBar = new ViewBar({
    towns: () => towns,
    // a different town is a different page: load it again, so nothing of the old one is left behind
    switchTown: (town) => { window.location.href = `${window.location.pathname}${addressForTown(window.location.search, town)}${window.location.hash}` },
    quality: () => quality,
    setQuality: (q) => {
      saveQuality(store, q)
      stage.setQuality(q, true)
    },
    view: () => tenantView,
    setView: (v) => setTenantView(v),
    // a different environment is a different town: load the page again for it, so nothing of the old one is left behind
    switchEnv: (id) => {
      const u = new URL(window.location.href)
      u.searchParams.set('env', id)
      window.location.href = u.toString()
    },
    islands: () => islands,
    setIslands: (ids) => setIslands(ids),
    layers: () => layers,
    toggleLayer: (layer: Layer) => {
      layers = toggleLayer(layers, layer)
      town.setLayers(layers)
      syncAddress()
      viewBar.refresh()
    },
    theme: () => theme,
    // a different theme is a different page, like a different town: load it again, so nothing of the old one is left behind
    setTheme: (id) => {
      const next = themeById(id)
      if (!next || next.id === theme.id) return
      saveTheme(next.id, store)
      const u = new URL(window.location.href)
      u.searchParams.set('theme', next.id)
      window.location.href = u.toString()
    },
  })
  const inspector = new Inspector({
    scope,
    onScreen: (id) => town.buildings.has(id),
    go: (id) => goTo({ kind: 'building', id, name: id, where: '' }),
    view: () => tenantView,
    regionChoice: (id) => town.regionChoice(id),
    setRegion: (id, choice) => town.setRegion(id, choice),
    closed: () => town.select(null),
  })
  const legend = new LegendCard((open) => {
    document.getElementById('legend-button')?.classList.toggle('on', open)
    if (open) try { store?.setItem(LEGEND_SEEN_KEY, '1') } catch { /* storage blocked */ }
  }, theme.id)
  document.getElementById('legend-button')!.addEventListener('click', () => legend.toggle())
  const lightingButton = document.getElementById('lighting')!
  const showLighting = (): void => { lightingButton.textContent = lighting === 'day' ? 'Day' : 'Dusk'; lightingButton.classList.toggle('on', lighting === 'dusk') }
  showLighting()
  lightingButton.addEventListener('click', () => {
    lighting = otherLighting(lighting)
    stage.setLighting(lighting)
    saveLighting(store, lighting)
    showLighting()
  })
  // the first visit from this browser opens the legend by itself; automated runs skip that unless they ask (?legend=first)
  const firstVisit = (() => { try { return !!store && store.getItem(LEGEND_SEEN_KEY) === null } catch { return false } })()
  if (!wallParams.on && ((firstVisit && (!testMode || params.get('legend') === 'first')) || params.get('legend') === '1')) legend.open()
  const servicePanel = new ServicePanel((id) => goTo({ kind: 'building', id, name: id, where: '' }))
  // The tools for breaking things exist only in a demo town; a live town never gets them, and the server has no /api/fake for them to call.
  let breakPanel: BreakPanel | null = null
  function startDemoTools(): void {
    if (breakPanel) return
    const fx = new FxClient(scope)
    breakPanel = new BreakPanel(fx, {
      targets: () => [
        { kind: 'town', id: '*', name: 'Whole town', where: '' },
        { kind: 'island', id: 'hub', name: 'Island: Platform hub', where: 'Platform hub' },
        ...islandItems().map((i) => ({ ...i, name: `Island: ${i.name}` })),
        ...buildingItems(),
      ],
      tenants: () => (seen.last?.tenants ?? []) as TenantInfo[],
      view: () => tenantView,
      armedChanged: (armed) => { canvas.style.cursor = armed ? 'crosshair' : 'grab' },
    })
    /** The story bar's camera: glides to a system, a vendor or an island without opening anything. */
    void new StoryBar(fx, (id) => {
      const focus = town.focusOf(id) ?? town.islandFocusOf(id)
      if (focus) stage.focus(focus.target, focus.distance)
    })
    breakPanel.refresh()
    fx.start()
  }

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
      wall?.setConnection('badData')
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
        breakPanel?.refresh()
        servicePanel.close()
      }
      town.apply(s)
      if (s.mode === 'demo') startDemoTools()
      // a followed tenant that left the environment can no longer be followed
      const pruned = pruneTenants(tenantView, s.tenants ?? [])
      if (pruned !== tenantView) setTenantView(pruned)
      // islands asked for that the town does not have are let go, and the viewer is told
      const kept = pruneIslands(islands, islandChoices(s))
      if (kept !== islands) setIslands(kept)
      if ((s.view?.unknown.length ?? 0) > 0) say(`Not an island of this town, so left out: ${s.view!.unknown.join(', ')}.`)
      viewBar.update(s)
      topbar.refresh()
      inspector.update(s)
      const open = servicePanel.key
      if (open?.startsWith('asset:')) {
        const av = town.assetSummary(open.slice('asset:'.length), s)
        if (av) servicePanel.showAsset(av)
        else servicePanel.close()
      } else if (open) {
        const sv = town.serviceSummary(open, s)
        if (sv) servicePanel.show(sv)
        else servicePanel.close()
      }
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
    wall?.setConnection('live')
    wall?.onSnapshot(s, nowSeconds())
    topbar.setSnapshot(s)
    stateList.refresh()
    notices.show(s.notices)
  }

  const connection = new Connection(onSnapshot, (st) => { topbar.setStatus(st); wall?.setConnection(st) }, scope, (e) => {
    banner.textContent = e.environments.length === 0 && e.towns
      ? `There is no town "${e.requestedTown ?? ''}". Available: ${e.towns.join(', ') || 'none'}.`
      : `There is no environment "${e.requested ?? ''}". Available: ${e.environments.join(', ') || 'none'}.`
    banner.hidden = false
  }, islands, { persistent: wallParams.on, retryMs: wallParams.retry * 1000 })
  connection.start()
  void fetchTowns().then((list) => { towns = list; viewBar.refresh() })

  // Wall mode: a tour, a status strip and change cues, over the same town.
  const nowSeconds = (): number => (testMode ? simTime : clock.elapsedTime)
  const wall = wallParams.on
    ? new WallMode(wallParams.hold, {
        focusOf: (f) => (f.kind === 'building' ? town.focusOf(f.id) : town.islandFocusOf(f.id)),
        go: (target, distance, cut) => stage.focus(target, distance, cut),
        home: (cut) => stage.home(cut),
        select: (id) => town.select(id),
      })
    : null

  // Quality: the preset the page opens with, and what depends on it. A level chosen on purpose is never stepped down from.
  const qualityStart = startQuality(query, store, wallParams.on ? 'medium' : 'high')
  stage.onQualityChange = (preset) => {
    quality = preset.id
    town.cars.density = preset.traffic
    town.boats.density = preset.traffic
    viewBar.refresh()
  }
  stage.setQuality(qualityStart.quality, qualityStart.chosen)

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
    const hit = ray.intersectObjects(town.hitMeshes(), false)[0]
    const b = hit?.object.userData.building as Building | undefined
    // nothing but a service's sign or hedge under the pointer: open that service
    const svc = b ? undefined : ray.intersectObjects(town.serviceHits(), false)[0]?.object.userData.serviceKey as string | undefined
    const sv = svc && seen.last ? town.serviceSummary(svc, seen.last) : null
    // a resource building (a vault, a storage account) opens its own small card
    const asset = b || svc ? undefined : ray.intersectObjects(town.assetHits(), false)[0]?.object.userData.assetId as string | undefined
    const av = asset && seen.last ? town.assetSummary(asset, seen.last) : null
    // a scenario waiting for its target takes the click instead of opening the building
    if (breakPanel?.armed) {
      if (b) breakPanel.aimAt(b.id)
      return
    }
    if (b) { servicePanel.close(); inspector.open(b.id) }
    else if (sv) { inspector.close(); servicePanel.show(sv) }
    else if (av) { inspector.close(); servicePanel.showAsset(av) }
    else { servicePanel.close(); inspector.close() }
    town.select(b?.id ?? null)
    const focus = b ? town.focusOf(b.id) : null
    if (focus) stage.focus(focus.target, focus.distance)
  })

  function hover(): void {
    if (!dirty) return
    dirty = false
    ray.setFromCamera(pointer, stage.camera)
    const hits = ray.intersectObjects(town.hitMeshes(), false)
    const b = hits[0]?.object.userData.building as Building | undefined
    showTooltip(b?.node ?? null, pointerPx.x, pointerPx.y, tenantView)
    const overService = !b && (ray.intersectObjects(town.serviceHits(), false).length > 0 || ray.intersectObjects(town.assetHits(), false).length > 0)
    canvas.style.cursor = breakPanel?.armed ? 'crosshair' : b || overService ? 'pointer' : 'grab'
  }

  // ?test=1 is for automated tests: nothing is drawn on its own, and time moves only when the test calls city.step(seconds).
  // Software rendering draws a frame in seconds, so tests read the scene's state instead of waiting for frames.
  let simTime = 0
  function step(seconds: number, dt = 0.1): void {
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      simTime += dt
      stage.tick(dt, simTime)
      town.update(dt, simTime, stage.camera)
      wall?.tick(simTime)
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
    inspectRoads: () => town.inspectRoads(),
    inspectServices: (id: string) => town.inspectServices(id),
    inspectAssets: (id: string) => town.inspectAssets(id),
    /** Open a service's panel as a click on its sign would. */
    openService: (key: string) => { const sv = seen.last ? town.serviceSummary(key, seen.last) : null; if (sv) { inspector.close(); servicePanel.show(sv) } return sv },
    /** Open a resource building's card as a click on it would. */
    openAsset: (id: string) => { const av = seen.last ? town.assetSummary(id, seen.last) : null; if (av) { inspector.close(); servicePanel.showAsset(av) } return av },
    tenantView: () => tenantView,
    breakArmed: () => breakPanel?.armed ?? false,
    mode: () => seen.last?.mode ?? null,
    /** Where a building is on the screen, in page pixels, so a test can click it. */
    screenOf: (id: string) => {
      const f = town.focusOf(id)
      if (!f) return null
      stage.camera.updateMatrixWorld()
      const v = f.target.clone().setY(3).project(stage.camera)
      return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight }
    },
    layers: () => layers,
    /** The headline numbers as the top bar shows them for the tenants chosen. */
    totals: () => (seen.last ? viewTotals(seen.last, tenantView) : null),
    lighting: () => lighting,
    /** What the wall is doing (mode, stop, caption, note, the strip's words); null when wall mode is off. */
    wall: () => wall?.status() ?? null,
    quality: () => quality,
    /** Opens the live socket again counts: how many times it was opened. */
    connectionOpened: () => connection.opened,
    dropConnection: () => connection.drop(),
    /** How strongly lit windows glow right now (Dusk makes them glow more). */
    windowGlow: () => WINDOW_GLOW.value,
    towns: () => towns,
    themeId: () => theme.id,
    /** The colours the scene was built with: the theme's own. */
    palette: () => livePalette,
    /** True when the sky has stars (a theme set in space). */
    hasStars: () => !!stage.scene.getObjectByName('stars'),
    islands: () => islands,
    /** Every island of the town, on screen or not. */
    islandChoices: () => viewBar.islandList,
    setIslands,
    inspectLayers: () => town.inspectLayers(),
    inspectEdge: () => town.inspectEdge(),
    inspector: () => ({ id: inspector.openId, tab: inspector.activeTab }),
    openSystem: (id: string, tab?: 'overview' | 'links' | 'logs' | 'config') => { servicePanel.close(); inspector.open(id, tab) },
    legendOpen: () => legend.isOpen,
    /** The tenants the top bar's list shows, grouped as it groups them. */
    tenantList: () => viewBar.listed,
    setTenantView,
    drawnCars: () => ({ drawn: town.cars.drawn, sent: town.cars.sent, byTenant: town.cars.tenantCounts() }),
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
      wall?.tick(time)
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
