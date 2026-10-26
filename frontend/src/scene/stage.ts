import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { palette } from '../themes/harbour-town/palette'
import { LIGHTING, type Lighting } from '../lighting'
import { WINDOW_GLOW } from '../buildings/windowMaterial'
import { QUALITY_PRESETS, pixelRatioFor, stepDown, type Quality, type QualityPreset } from '../quality'

export type { Quality }

/** Average frame time (ms) over the sample window above which quality steps down one level. About 30 frames a second. */
const SLOW_FRAME_MS = 33
const SAMPLE_FRAMES = 90

/** Renderer, camera, sky, sea and light: everything that is the same whatever town is shown. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls
  readonly sun: THREE.DirectionalLight
  quality: Quality = 'high'
  /** Called when quality steps down on its own, so the page can say so. */
  onQualityStep: ((to: Quality) => void) | null = null
  /** Called whenever the quality changes, by hand or by itself, so the parts of the town that depend on it can follow. */
  onQualityChange: ((preset: QualityPreset) => void) | null = null
  private autoQuality = true
  private frameTimes: number[] = []
  private lastFrame = 0
  private warmup = 150
  private sinceShadow = 0
  private readonly seaUniforms = { uTime: { value: 0 } }
  /** The colours the sky, haze and sea are drawn with. Lighting changes move these toward the preset, so Day and Dusk fade into each other. */
  private readonly skyTop = new THREE.Color(palette.sky.top)
  private readonly skyHorizon = new THREE.Color(palette.sky.horizon)
  private readonly seaDeep = new THREE.Color(palette.sea.deep)
  private readonly seaShallow = new THREE.Color(palette.sea.shallow)
  private hemisphere!: THREE.HemisphereLight
  /** The lighting the town is moving toward (Day or Dusk), and how far along the fade is. */
  lighting: Lighting = 'day'
  private lightingFade = 1
  /** Where the sun stands relative to the middle of the town; moves toward the preset's with the rest of the lighting. */
  private readonly sunOffset = new THREE.Vector3(-70, 110, 60)
  private homeTarget = new THREE.Vector3(0, 0, -30)
  private homeDistance = 105
  private homeAzimuth = 0
  /** How far the view may be panned from the town's centre. Grows with the town, so the outermost island stays reachable. */
  private panLimit = 120
  private homePolar = THREE.MathUtils.degToRad(52)

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    this.scene.fog = new THREE.Fog(palette.fog, 160, 520)
    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 4000)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    // Free orbit, but never under the water or flat on top, and never lost far away.
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(25)
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(75)
    this.controls.minDistance = 12
    this.controls.maxDistance = 900
    this.controls.screenSpacePanning = false
    this.controls.addEventListener('change', () => this.clampPan())

    this.sky()
    this.sea()
    const hemi = new THREE.HemisphereLight('#d6ecff', '#c9b88f', 1.15)
    this.hemisphere = hemi
    this.scene.add(hemi)
    this.sun = new THREE.DirectionalLight('#fff0d6', 2.6)
    this.sun.position.set(-70, 110, 60)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(4096, 4096)
    const s = this.sun.shadow.camera
    s.left = -110; s.right = 110; s.top = 110; s.bottom = -110; s.near = 10; s.far = 400
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.05
    this.sun.target.position.set(0, 0, -30)
    this.scene.add(this.sun, this.sun.target)

    this.home(true)
    window.addEventListener('resize', () => this.resize())
    this.resize()
  }

  /**
   * Day or Dusk. The town fades to the new light over about a second (at once when `instant`). The models and the data are the same; only the
   * sky, haze, sea and the two lights change.
   */
  setLighting(l: Lighting, instant = false): void {
    this.lighting = l
    this.lightingFade = instant ? 1 : 0
    if (instant) this.blendLighting(1)
    const preset = LIGHTING[l]
    document.documentElement.style.setProperty('--page', preset.page)
    document.documentElement.dataset.lighting = l
  }

  /** Moves every lit value a step toward the preset. */
  private blendLighting(k: number): void {
    const p = LIGHTING[this.lighting]
    this.skyTop.lerp(new THREE.Color(p.sky.top), k)
    this.skyHorizon.lerp(new THREE.Color(p.sky.horizon), k)
    this.seaDeep.lerp(new THREE.Color(p.sea.deep), k)
    this.seaShallow.lerp(new THREE.Color(p.sea.shallow), k)
    if (this.scene.fog) this.scene.fog.color.lerp(new THREE.Color(p.fog), k)
    this.hemisphere.color.lerp(new THREE.Color(p.hemisphere.sky), k)
    this.hemisphere.groundColor.lerp(new THREE.Color(p.hemisphere.ground), k)
    this.hemisphere.intensity += (p.hemisphere.intensity - this.hemisphere.intensity) * k
    this.sun.color.lerp(new THREE.Color(p.sun.color), k)
    this.sun.intensity += (p.sun.intensity - this.sun.intensity) * k
    this.renderer.toneMappingExposure += (p.exposure - this.renderer.toneMappingExposure) * k
    WINDOW_GLOW.value += (p.windowGlow - WINDOW_GLOW.value) * k
    this.sunOffset.lerp(new THREE.Vector3(p.sunOffset.x, p.sunOffset.y, p.sunOffset.z), k)
    this.sun.position.copy(this.sun.target.position).add(this.sunOffset)
  }

  /** How far the fade to the chosen lighting has got, from 0 to 1. For tests. */
  get lightingProgress(): number {
    return this.lightingFade
  }

  /** Where Home frames the town. Centre it on the islands and pull back to fit. */
  setHome(target: THREE.Vector3, distance: number): void {
    this.homeTarget.copy(target)
    this.homeDistance = distance
    this.panLimit = Math.max(120, distance * 0.7)
    // never zoom out further than a comfortable view of the whole town, but always far enough to reach Home
    this.controls.maxDistance = Math.max(300, distance * 1.35)
    if (this.scene.fog instanceof THREE.Fog) {
      // the haze starts beyond the town however big it is
      this.scene.fog.near = Math.max(160, distance * 1.15)
      this.scene.fog.far = Math.max(520, distance * 3.4)
    }
    this.sun.target.position.copy(target)
    this.sun.position.copy(target).add(this.sunOffset)
    // shadows cover the whole town, however big it is
    const ext = Math.max(110, distance * 0.62)
    const sc = this.sun.shadow.camera
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext
    sc.updateProjectionMatrix()
  }

  /**
   * Sets Home to show every point, standing as close as the view allows. The top bar and the panel on the left take
   * a share of the screen, so points are kept clear of them.
   */
  frame(points: THREE.Vector3[], reserve = { top: 0.16, side: 0.06 }): void {
    if (points.length === 0) return
    const box = new THREE.Box3().setFromPoints(points)
    const target = box.getCenter(new THREE.Vector3()).setY(0)
    const probe = this.camera.clone()
    const fits = (distance: number) => {
      probe.position.copy(target).add(new THREE.Vector3().setFromSphericalCoords(distance, this.homePolar, this.homeAzimuth))
      probe.up.set(0, 1, 0)
      probe.lookAt(target)
      probe.updateMatrixWorld(true)
      probe.updateProjectionMatrix()
      return points.every((p) => {
        const v = p.clone().project(probe)
        return v.z < 1 && Math.abs(v.x) <= 1 - reserve.side && v.y <= 1 - reserve.top && v.y >= -(1 - reserve.side)
      })
    }
    let lo = 40, hi = 2000
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      if (fits(mid)) hi = mid
      else lo = mid
    }
    this.setHome(target, hi)
  }

  home(instant = false): void {
    const offset = new THREE.Vector3().setFromSphericalCoords(this.homeDistance, this.homePolar, this.homeAzimuth)
    const pos = this.homeTarget.clone().add(offset)
    if (instant) {
      this.camera.position.copy(pos)
      this.controls.target.copy(this.homeTarget)
      this.controls.update()
    } else {
      this.glideTo(this.homeTarget, pos)
    }
  }

  /** Glides to look at a point from the current side, standing `distance` away at a comfortable angle. */
  focus(target: THREE.Vector3, distance: number, instant = false): void {
    const offset = this.camera.position.clone().sub(this.controls.target)
    const sph = new THREE.Spherical().setFromVector3(offset)
    sph.radius = THREE.MathUtils.clamp(distance, this.controls.minDistance, this.controls.maxDistance)
    sph.phi = THREE.MathUtils.clamp(sph.phi, THREE.MathUtils.degToRad(40), THREE.MathUtils.degToRad(62))
    const position = target.clone().add(new THREE.Vector3().setFromSpherical(sph))
    if (!instant) { this.glideTo(target, position); return }
    // a cut: no glide, the camera is there at once
    this.glide = null
    this.camera.position.copy(position)
    this.controls.target.copy(target)
    this.controls.update()
  }

  private glide: { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t: number } | null = null

  glideTo(target: THREE.Vector3, position: THREE.Vector3): void {
    this.glide = { fromPos: this.camera.position.clone(), toPos: position, fromT: this.controls.target.clone(), toT: target.clone(), t: 0 }
  }

  tick(dt: number, time: number): void {
    this.seaUniforms.uTime.value = time
    if (this.lightingFade < 1) {
      this.lightingFade = Math.min(1, this.lightingFade + dt / 1.0)
      this.blendLighting(this.lightingFade >= 1 ? 1 : 1 - Math.exp(-dt * 5))
    }
    // keep depth precision good when far out, or the sea-foam layers fight the grass
    const near = THREE.MathUtils.clamp(this.camera.position.distanceTo(this.controls.target) * 0.04, 0.5, 12)
    if (Math.abs(near - this.camera.near) > 0.1) {
      this.camera.near = near
      this.camera.updateProjectionMatrix()
    }
    if (this.glide) {
      const g = this.glide
      g.t = Math.min(1, g.t + dt / 1.2)
      const e = g.t * g.t * (3 - 2 * g.t)
      this.camera.position.lerpVectors(g.fromPos, g.toPos, e)
      this.controls.target.lerpVectors(g.fromT, g.toT, e)
      if (g.t >= 1) this.glide = null
    }
    this.controls.update()
  }

  /** Any drag cancels a glide. */
  cancelGlide(): void {
    this.glide = null
  }

  private clampPan(): void {
    const t = this.controls.target
    const limit = this.panLimit
    t.x = THREE.MathUtils.clamp(t.x, this.homeTarget.x - limit, this.homeTarget.x + limit)
    t.z = THREE.MathUtils.clamp(t.z, this.homeTarget.z - limit, this.homeTarget.z + limit)
    t.y = 0
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /**
   * Applies a quality preset (see quality.ts): resolution, how often shadows are redrawn (or none) and how big their map is. The traffic share is
   * the town's to apply, through onQualityChange. A level chosen on purpose is `pinned`: the stage then never steps down by itself.
   */
  setQuality(q: Quality, pinned = false): void {
    if (pinned) this.autoQuality = false
    const preset = QUALITY_PRESETS[q]
    this.quality = q
    this.renderer.setPixelRatio(pixelRatioFor(q, window.devicePixelRatio))
    this.renderer.shadowMap.autoUpdate = preset.shadows === 'every-frame'
    this.renderer.shadowMap.needsUpdate = true
    this.sun.castShadow = preset.shadows !== 'off'
    if (this.sun.shadow.mapSize.x !== preset.shadowMapSize) {
      this.sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize)
      // the old map has the old size: let the renderer make a new one
      this.sun.shadow.map?.dispose()
      this.sun.shadow.map = null
    }
    this.resize()
    this.onQualityChange?.(preset)
  }

  render(): void {
    this.watchFrameTime()
    this.renderer.render(this.scene, this.camera)
  }

  /** Steps quality down once when the town cannot keep up, and never back up on its own, so it cannot flicker. */
  private watchFrameTime(): void {
    const now = performance.now()
    const dt = now - this.lastFrame
    this.lastFrame = now
    if (QUALITY_PRESETS[this.quality].shadows === 'few-per-second') {
      this.sinceShadow += dt
      if (this.sinceShadow > 160) { this.renderer.shadowMap.needsUpdate = true; this.sinceShadow = 0 }
    }
    if (!this.autoQuality || this.quality === 'low') return
    if (this.warmup > 0) { this.warmup--; return } // the first frames compile shaders and always run long
    if (dt > 400) return // a hidden tab or a pause, not slowness
    this.frameTimes.push(dt)
    if (this.frameTimes.length < SAMPLE_FRAMES) return
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
    this.frameTimes = []
    if (avg > SLOW_FRAME_MS) {
      const next = stepDown(this.quality)
      if (!next) return
      this.setQuality(next)
      this.warmup = 30
      this.onQualityStep?.(next)
    }
  }

  private sky(): void {
    const geo = new THREE.SphereGeometry(2600, 24, 16)
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: this.skyTop }, horizon: { value: this.skyHorizon } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 horizon;
        void main(){ float h = clamp(normalize(vP).y, 0.0, 1.0); vec3 c = mix(horizon, top, pow(h, 0.55));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
        }`,
    })
    const sky = new THREE.Mesh(geo, mat)
    sky.renderOrder = -10
    this.scene.add(sky)
  }

  private sea(): void {
    const geo = new THREE.CircleGeometry(2800, 64)
    geo.rotateX(-Math.PI / 2)
    const mat = new THREE.MeshStandardMaterial({ color: palette.sea.deep, roughness: 0.35, metalness: 0.0 })
    const deep = this.seaDeep
    const shallow = this.seaShallow
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.seaUniforms.uTime
      shader.uniforms.uDeep = { value: deep }
      shader.uniforms.uShallow = { value: shallow }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSeaPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeaPos = (modelMatrix * vec4(position, 1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vSeaPos; uniform float uTime; uniform vec3 uDeep; uniform vec3 uShallow;
float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float n2(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h2(i), h2(i+vec2(1,0)), f.x), mix(h2(i+vec2(0,1)), h2(i+vec2(1,1)), f.x), f.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec2 p = vSeaPos.xz;
  float w1 = n2(p * 0.05 + vec2(uTime * 0.02, uTime * 0.012));
  float w2 = n2(p * 0.13 - vec2(uTime * 0.03, uTime * 0.01));
  float tone = w1 * 0.65 + w2 * 0.35;
  vec3 col = mix(uDeep, uShallow, smoothstep(0.3, 0.8, tone) * 0.35);
  // faint, sparse sparkles that drift
  float crest = smoothstep(0.86, 0.95, n2(p * 0.55 + vec2(uTime * 0.08, -uTime * 0.05)) * 0.7 + w2 * 0.35);
  col += crest * 0.10;
  diffuseColor.rgb = col;
}`)
    }
    const sea = new THREE.Mesh(geo, mat)
    sea.receiveShadow = true
    sea.position.y = 0
    this.scene.add(sea)
  }
}
