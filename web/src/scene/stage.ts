import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { palette } from '../themes/harbour-town/palette'

/** Renderer, camera, sky, sea and light: everything that is the same whatever town is shown. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls
  readonly sun: THREE.DirectionalLight
  private readonly seaUniforms = { uTime: { value: 0 } }
  private homeTarget = new THREE.Vector3(0, 0, -30)
  private homeDistance = 105
  private homeAzimuth = 0
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
    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 1500)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    // Free orbit, but never under the water or flat on top, and never lost far away.
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(25)
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(75)
    this.controls.minDistance = 12
    this.controls.maxDistance = 520
    this.controls.screenSpacePanning = false
    this.controls.addEventListener('change', () => this.clampPan())

    this.sky()
    this.sea()
    const hemi = new THREE.HemisphereLight('#d6ecff', '#c9b88f', 1.15)
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

  /** Where Home frames the town. Centre it on the islands and pull back to fit. */
  setHome(target: THREE.Vector3, distance: number): void {
    this.homeTarget.copy(target)
    this.homeDistance = distance
    this.sun.target.position.copy(target)
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

  private glide: { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t: number } | null = null

  glideTo(target: THREE.Vector3, position: THREE.Vector3): void {
    this.glide = { fromPos: this.camera.position.clone(), toPos: position, fromT: this.controls.target.clone(), toT: target.clone(), t: 0 }
  }

  tick(dt: number, time: number): void {
    this.seaUniforms.uTime.value = time
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
    const limit = 120
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

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  private sky(): void {
    const geo = new THREE.SphereGeometry(900, 24, 16)
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color(palette.sky.top) }, horizon: { value: new THREE.Color(palette.sky.horizon) } },
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
    const geo = new THREE.CircleGeometry(900, 64)
    geo.rotateX(-Math.PI / 2)
    const mat = new THREE.MeshStandardMaterial({ color: palette.sea.deep, roughness: 0.35, metalness: 0.0 })
    const deep = new THREE.Color(palette.sea.deep)
    const shallow = new THREE.Color(palette.sea.shallow)
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
