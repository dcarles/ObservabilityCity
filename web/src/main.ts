import './style.css'
import * as THREE from 'three'
import { Stage } from './scene/stage'
import { Town } from './scene/town'
import { loadKit } from './assets/kit'
import { Connection } from './connection'
import { PreviewPanel, Search, showTooltip, TopBar, type SearchItem } from './ui'
import type { Snapshot } from './types'
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

  const topbar = new TopBar(() => stage.home())
  const preview = new PreviewPanel(() =>
    [...town.buildings.values()].map((b) => ({ id: b.id, name: b.node?.name ?? b.id, group: b.id.split('.')[0] })))

  const search = new Search(
    () => {
      const items: SearchItem[] = town.islands.map((i) => ({ kind: 'island', id: i.group.id, name: i.group.displayName, where: i.group.displayName }))
      for (const isl of town.islands)
        for (const [id, b] of isl.buildings) items.push({ kind: 'building', id, name: b.node?.name ?? id, where: isl.group.displayName })
      for (const [id, b] of town.buildings) if (id.startsWith('hub.')) items.push({ kind: 'building', id, name: b.node?.name ?? id, where: 'Platform hub' })
      return items
    },
    (item) => {
      const focus = item.kind === 'island' ? town.islandFocusOf(item.id) : town.focusOf(item.id)
      town.select(item.kind === 'building' ? item.id : null)
      if (focus) stage.focus(focus.target, focus.distance)
    },
  )
  void search

  function onSnapshot(s: Snapshot): void {
    if (!town.matches(s)) {
      town.root.remove(...town.root.children.filter((c) => c !== town.cars.object && c !== town.boats.object))
      town.buildings.clear()
      town.islands.length = 0
      town.extent.length = 0
      town.bounds.makeEmpty()
      town.build(s)
      stage.frame(town.extent)
      stage.home(true)
      void preview.refresh()
    }
    town.apply(s)
    topbar.setSnapshot(s)
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

  // Debug handle for automated screenshots and poking from the console.
  ;(window as unknown as { city: unknown }).city = { stage, town, THREE }

  const clock = new THREE.Clock()
  function frame(): void {
    const dt = Math.min(clock.getDelta(), 0.1)
    const time = clock.elapsedTime
    stage.tick(dt, time)
    town.update(dt, time, stage.camera)
    hover()
    stage.render()
    requestAnimationFrame(frame)
  }
  frame()
}
