import { fitHeads } from './sticky'
import '../style.css'
import '../dashboard.css'
import { Connection, markFeed, SILENT_WORDS, type ConnectionState } from '../connection'
import { checkSnapshot } from '../snapshotGuard'
import { Inspector } from '../inspector'
import { dismissEvent } from '../healthEvents'
import { requestedScope } from '../scope'
import { ViewBar } from '../viewbar'
import { NoticesPanel } from '../noticesPanel'
import { UnknownHostsPanel } from '../unknownHosts'
import { browserStore, isLighting, LIGHTING_KEY, startLighting, saveLighting, type Lighting } from '../lighting'
import { pruneTenants, type TenantView } from '../tenants'
import { islandsParam, parseIslands, pruneIslands, islandChoices } from '../islands'
import { loadTenantView, saveTenantView, viewSwitchAddress } from '../viewMode'
import type { Snapshot } from '../types'
import { buildDashboard, pillarSelection, type Dashboard } from './model'
import { freshnessHtml, hiddenHtml, pillarMenuHtml, pillarsHtml, sectionsHtml, summaryHtml, type UiState } from './render'
import { dashLegendHtml } from './legend'
import { feedLateAfter, marker, popupLeft, sourceLines } from './freshness'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/** The plain dashboard: the same snapshot and the same live feed as the town, as numbers and tables. It never loads three.js. */
export function startDashboard(): void {
  const store = browserStore()
  const scope = requestedScope()
  document.body.classList.add('dash')
  $('dash-root').hidden = false
  // the drawer and the lists the town floats over its scene sit in the page here
  const filters = $('dash-filters')
  filters.appendChild($('view-bar'))
  $('dash-more').append($('unknown-hosts'), $('notices'))

  // light or dark: the same choice the town calls Day and Dusk, so the browser remembers one thing
  let mode: Lighting = (() => {
    const asked = startLighting(window.location.search, store, 'day')
    try { if (!store?.getItem(LIGHTING_KEY) && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dusk' } catch { /* no storage */ }
    return asked
  })()
  const showMode = (): void => {
    document.body.dataset.mode = mode === 'dusk' ? 'dark' : 'light'
    $('dash-theme').textContent = mode === 'dusk' ? 'Light' : 'Dark'
  }
  showMode()
  $('dash-theme').addEventListener('click', () => {
    mode = mode === 'dusk' ? 'day' : 'dusk'
    if (isLighting(mode)) saveLighting(store, mode)
    showMode()
  })

  // panels start below the menu, which wraps to more rows on a narrow screen
  const menuBar = $('dash-menu')
  const measureMenu = (): void => {
    document.documentElement.style.setProperty('--bar-h', `${menuBar.offsetHeight - 12}px`)
    document.documentElement.style.setProperty('--menu-h', `${menuBar.offsetHeight}px`)
    fit()
  }
  // the column titles of each table stay under the menu and leave with the table's last service row
  let frame = 0
  function fit(): void {
    if (frame) return
    frame = requestAnimationFrame(() => { frame = 0; fitHeads(document.getElementById('dash-pillars') ?? document, menuBar.offsetHeight) })
  }
  window.addEventListener('scroll', fit, { passive: true })
  measureMenu()
  new ResizeObserver(measureMenu).observe(menuBar)

  $('vs-town').addEventListener('click', () => { window.location.href = viewSwitchAddress(window.location, 'town', store) })

  const ui = { openPillars: new Set<string>(), groups: new Map<string, boolean>(), databases: new Map<string, boolean>(), connections: new Set<string>(), sections: new Set<string>() }
  let tenantView: TenantView = loadTenantView(store)
  let islands: readonly string[] = parseIslands(window.location.search)
  let last: Snapshot | null = null
  let model: Dashboard | null = null
  const seen = { snapshots: 0, rejected: 0 }
  const shown = { sum: '', pillars: '', hidden: '', menu: '', brand: '', sections: '' }
  const regionChoices = new Map<string, string>()

  const inspector = new Inspector({
    scope,
    onScreen: (id) => !!last?.groups.some((g) => g.nodes.some((n) => n.id === id)),
    go: (id) => inspector.open(id),
    view: () => tenantView,
    regionChoice: (id) => (regionChoices.get(id) ?? 'worst') as ReturnType<ConstructorParameters<typeof Inspector>[0]['regionChoice']>,
    setRegion: (id, choice) => { regionChoices.set(id, choice as string); if (last) inspector.update(last) },
    closed: () => {},
  })
  const notices = new NoticesPanel()
  const unknownHosts = new UnknownHostsPanel(scope, () => (last?.groups ?? []).flatMap((g) => g.nodes).filter((n) => n.kind === 'Api').map((n) => n.id).sort())
  unknownHosts.start()

  const setTenantView = (v: TenantView): void => {
    tenantView = v
    saveTenantView(store, v)
    viewBar.refresh()
    draw()
  }
  const setIslands = (ids: readonly string[]): void => {
    islands = ids
    connection.setIslands(ids)
    const q = new URLSearchParams(window.location.search)
    const p = islandsParam(ids)
    if (p) q.set('islands', p)
    else q.delete('islands')
    const text = q.toString().replace(/%2C/g, ',')
    window.history.replaceState(null, '', `${window.location.pathname}${text ? `?${text}` : ''}${window.location.hash}`)
  }
  const viewBar = new ViewBar({
    towns: () => [],
    switchTown: () => {},
    quality: () => 'high',
    setQuality: () => {},
    view: () => tenantView,
    setView: setTenantView,
    switchEnv: (id) => { const u = new URL(window.location.href); u.searchParams.set('env', id); window.location.href = u.toString() },
    islands: () => islands,
    setIslands: (ids) => setIslands(ids),
    layers: () => ({ roads: true, dependencies: false }) as never,
    toggleLayer: () => {},
    focus: () => '',
    setFocus: () => {},
    theme: () => ({ id: 'harbour-town', name: '', blurb: '' }) as never,
    setTheme: () => {},
  }, ['env', 'tenant'])

  /** Draws what changed. Open and closed things live in `ui`, so a new snapshot never undoes them, and the page keeps its scroll place. */
  function draw(): void {
    if (!last) return
    model = buildDashboard(last, tenantView)
    const y = window.scrollY
    const active = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-toggle],[data-hide],[data-show],[data-db],[data-group],[data-conn]')
    const key = active ? (['toggle', 'hide', 'show', 'db', 'group'] as const).map((k) => (active.dataset[k] !== undefined ? `[data-${k}="${CSS.escape(active.dataset[k]!)}"]` : '')).join('') : ''
    const put = (id: string, html: string, k: keyof typeof shown): void => { if (shown[k] !== html) { shown[k] = html; $(id).innerHTML = html } }
    if (shown.brand !== model.townName) { shown.brand = model.townName; $('dash-brand').textContent = model.townName }
    put('dash-sum', summaryHtml(model), 'sum')
    put('dash-pillars', pillarsHtml(model, ui as UiState), 'pillars')
    put('hidden-pillars', hiddenHtml(model), 'hidden')
    put('pillar-menu', pillarMenuHtml(model), 'menu')
    put('dash-sections', sectionsHtml(model, ui as UiState), 'sections')
    if (window.scrollY !== y) window.scrollTo(0, y)
    fit()
    if (key) document.querySelector<HTMLElement>(key)?.focus({ preventScroll: true })
  }

  function onSnapshot(raw: unknown): void {
    const { snapshot: s, problems } = checkSnapshot(raw)
    for (const p of problems) console.warn(`Snapshot problem: ${p}`)
    if (!s) { seen.rejected++; setStatus('badData'); return }
    const now = Date.now()
    if (arrivedAt !== null) { gaps.push((now - arrivedAt) / 1000); if (gaps.length > 10) gaps.shift() }
    arrivedAt = now
    last = s
    seen.snapshots++
    const pruned = pruneTenants(tenantView, s.tenants ?? [])
    if (pruned !== tenantView) { tenantView = pruned; saveTenantView(store, pruned) }
    const kept = pruneIslands(islands, islandChoices(s))
    if (kept !== islands) setIslands(kept)
    viewBar.update(s)
    inspector.update(s)
    notices.show(s.notices, s.notes ?? [])
    draw()
    if (!freshPop.hidden) drawFreshness()
    setStatus('live')
  }

  // how fresh the feed is: seconds since the last snapshot arrived, and the lines of the popup
  let connected = false
  let arrivedAt: number | null = null
  const gaps: number[] = []
  const freshButton = $('fresh-button')
  const freshPop = $('fresh-pop')
  function drawMarker(): void {
    const since = arrivedAt === null ? null : (Date.now() - arrivedAt) / 1000
    const m = marker(connected, since, feedLateAfter(gaps))
    freshButton.textContent = `${m.text} ${freshPop.hidden ? '▾' : '▴'}`
    freshButton.classList.toggle('late', m.late)
  }
  function drawFreshness(): void {
    freshPop.innerHTML = freshnessHtml(sourceLines(last?.sources, Date.now()))
    const r = freshButton.getBoundingClientRect()
    freshPop.style.top = `${r.bottom + 6}px`
    freshPop.style.left = `${popupLeft(r.left, freshPop.offsetWidth, window.innerWidth)}px`
  }
  freshButton.addEventListener('click', () => {
    freshPop.hidden = !freshPop.hidden
    freshButton.setAttribute('aria-expanded', String(!freshPop.hidden))
    if (!freshPop.hidden) drawFreshness()
    drawMarker()
  })
  document.addEventListener('pointerdown', (e) => {
    if (!freshPop.hidden && !(e.target as HTMLElement).closest('.fresh')) { freshPop.hidden = true; freshButton.setAttribute('aria-expanded', 'false'); drawMarker() }
  })
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !freshPop.hidden) { freshPop.hidden = true; freshButton.setAttribute('aria-expanded', 'false'); drawMarker() } })
  window.addEventListener('resize', () => { if (!freshPop.hidden) drawFreshness() })
  window.setInterval(drawMarker, 1000)
  drawMarker()

  // the small legend: a "?" in the menu that opens a short list of what the colours mean
  const legendButton = $('dash-legend-button')
  const legendPop = $('dash-legend')
  legendPop.innerHTML = dashLegendHtml()
  const closeLegend = (): void => { legendPop.hidden = true; legendButton.setAttribute('aria-expanded', 'false') }
  legendButton.addEventListener('click', () => {
    legendPop.hidden = !legendPop.hidden
    legendButton.setAttribute('aria-expanded', String(!legendPop.hidden))
    if (!legendPop.hidden) {
      const r = legendButton.getBoundingClientRect()
      legendPop.style.top = `${r.bottom + 6}px`
      legendPop.style.left = `${popupLeft(r.left, legendPop.offsetWidth, window.innerWidth)}px`
    }
  })
  document.addEventListener('pointerdown', (e) => { if (!legendPop.hidden && !(e.target as HTMLElement).closest('.dl')) closeLegend() })
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !legendPop.hidden) closeLegend() })
  window.addEventListener('resize', closeLegend)

  function setStatus(st: ConnectionState): void {
    connected = st === 'live' || st === 'badData' // silent counts as not connected
    drawMarker()
    const label = { connecting: 'Connecting…', live: last?.mode === 'demo' ? 'Live (demo data)' : 'Live', reconnecting: 'Reconnecting…', offline: 'Backend offline', badData: 'Bad data, showing the last good data', silent: SILENT_WORDS }[st]
    markFeed(st)
    const el = $('dash-status')
    el.className = `livepill ${st === 'live' ? '' : st === 'offline' || st === 'badData' || st === 'silent' ? 'off' : 'wait'}`
    el.lastElementChild!.textContent = label
  }

  let held = false // for tests: while true, the snapshots from the server are ignored, so one fed by hand stays on screen
  const connection = new Connection((raw) => { if (!held) onSnapshot(raw) }, setStatus, scope, (e) => {
    const b = $('banner')
    b.textContent = `There is no environment "${e.requested ?? ''}". Available: ${e.environments.join(', ') || 'none'}.`
    b.hidden = false
    b.style.display = 'block'
  }, islands)
  connection.start()

  // one listener for the whole page: the markup is redrawn with every snapshot
  const root = $('dash-root')
  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const attr = (name: string): string | undefined => t.closest<HTMLElement>(`[${name}]`)?.getAttribute(name) ?? undefined
    const toggle = attr('data-toggle')
    const hide = attr('data-hide')
    const show = attr('data-show')
    const db = attr('data-db')
    const details = attr('data-details')
    const conn = attr('data-conn')
    const group = attr('data-group')
    const dismiss = attr('data-dismiss')
    if (dismiss !== undefined) { void dismissEvent(dismiss); return }
    const system = t.closest<HTMLElement>('[data-system]')?.dataset.system
    if (toggle !== undefined) { if (ui.openPillars.has(toggle)) ui.openPillars.delete(toggle); else ui.openPillars.add(toggle); draw(); return }
    if (hide !== undefined && last) { setIslands(pillarSelection(last, hide, false)); return }
    if (show !== undefined && last) { setIslands(pillarSelection(last, show, true)); return }
    if (db !== undefined && model) {
      const row = model.pillars.flatMap((p) => p.groups.flatMap((g) => g.rows)).find((r) => r.id === db)
      if (row) { ui.databases.set(db, !(ui.databases.get(db) ?? row.tenantsOpenByDefault)); draw() }
      return
    }
    if (conn !== undefined) { if (ui.connections.has(conn)) ui.connections.delete(conn); else ui.connections.add(conn); draw(); return }
    if (details !== undefined) { inspector.open(details, 'overview'); return }
    if (group !== undefined && model) {
      const g = model.pillars.flatMap((p) => p.groups).find((x) => x.key === group)
      if (g) { ui.groups.set(group, !(ui.groups.get(group) ?? (g.level === 'warn' || g.level === 'bad'))); draw() }
      return
    }
    if (system) inspector.open(system)
  })
  $('dash-sections').addEventListener('toggle', (e) => {
    const d = e.target as HTMLDetailsElement
    const id = d.dataset.section
    if (id) { if (d.open) ui.sections.add(id); else ui.sections.delete(id) }
  }, true)
  const menu = $('pillar-menu')
  const button = $('pillars-button')
  button.addEventListener('click', () => { menu.hidden = !menu.hidden; button.setAttribute('aria-expanded', String(!menu.hidden)) })
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !(e.target as HTMLElement).closest('.vb')) { menu.hidden = true; button.setAttribute('aria-expanded', 'false') } })
  menu.addEventListener('change', (e) => {
    const box = e.target as HTMLInputElement
    const id = box.dataset.pillarBox
    if (id && last) setIslands(pillarSelection(last, id, box.checked))
  })

  ;(window as unknown as { dash: unknown }).dash = {
    seen,
    muteFeed: (muted: boolean, silentAfterMs?: number) => connection.mute(muted, silentAfterMs),
    feed: (raw: unknown) => onSnapshot(raw),
    /** For tests: stop (or resume) showing the server's snapshots; `feed` still works. */
    hold: (on: boolean) => { held = on },
    freshnessOpen: () => !freshPop.hidden,
    /** For tests: make the last snapshot look this many seconds older. */
    ageFeed: (seconds: number) => { if (arrivedAt !== null) arrivedAt -= seconds * 1000; drawMarker() },
    model: () => model,
    ui,
    tenantView: () => tenantView,
    islands: () => islands,
    threeLoaded: () => !!document.querySelector('script[src*="three"]') || 'THREE' in window,
  }
}
