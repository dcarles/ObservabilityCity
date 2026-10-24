import './style.css'
import * as THREE from 'three'
import { Stage } from './scene/stage'
import { Town } from './scene/town'
import { loadKit } from './assets/kit'
import { Connection } from './connection'
import { PreviewPanel, showTooltip, TopBar } from './ui'
import type { Snapshot } from './types'
import { Building } from './buildings/building'

void start()

async function start(): Promise<void> {
  await loadKit()
  const canvas = document.getElementById('town') as HTMLCanvasElement
  const stage = new Stage(canvas)
  const town = new Town()
  stage.scene.add(town.root)

  const topbar = new TopBar(() => stage.home())
  const preview = new PreviewPanel(() =>
    [...town.buildings.values()].map((b) => ({ id: b.id, name: b.node?.name ?? b.id, group: b.id.split('.')[0] })))

  function onSnapshot(s: Snapshot): void {
    if (!town.matches(s)) {
      town.root.remove(...town.root.children.filter((c) => c !== town.cars.object))
      town.buildings.clear()
      town.islands.length = 0
      town.build(s)
      const box = town.bounds
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const fov = THREE.MathUtils.degToRad(stage.camera.fov)
      const fit = Math.max(size.z / 2 / Math.tan(fov / 2), size.x / 2 / (Math.tan(fov / 2) * stage.camera.aspect))
      stage.setHome(new THREE.Vector3(center.x, 0, center.z + 5), Math.min(260, fit * 0.68 + 10))
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
  canvas.addEventListener('pointerdown', () => stage.cancelGlide())

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
  ;(window as unknown as { city: unknown }).city = { stage, town }

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
