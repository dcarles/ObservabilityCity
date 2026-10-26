import * as THREE from 'three'
import { palette } from '../themes/harbour-town/palette'

/** Per-floor knobs the shader reads. Tweened by the building each frame. */
export interface WindowUniforms {
  uLit: { value: number }
  uDark: { value: number }
  uStale: { value: number }
  uSeed: { value: number }
}

/**
 * How strongly lit windows glow, shared by every building. The stage moves it with the lighting: a low sun makes the windows brighter, so a town
 * at dusk still reads from far away.
 */
export const WINDOW_GLOW = { value: 1 }

export interface WindowSpec {
  /** Wall colour. */
  color: string
  /** Trim colour for window frames, sills and the floor-edge band. */
  trim?: string
  /** One window cell is this wide, in world units, on every face, so windows are the same size and shape everywhere. */
  cell?: number
  floorHeight: number
  /** Box footprint, so windows sit symmetrically on each face. Leave out for round (radial) walls. */
  width?: number
  depth?: number
  /** Window glass size in world units. */
  win?: [number, number]
  /** Draw horizontal brick courses. */
  brick?: boolean
  /** Round walls: this many windows around the wall instead of a world-sized grid. */
  radial?: number
  roughness?: number
}

/**
 * A flat-shaded wall with a procedural window grid. Windows are laid out in world units, not texture
 * coordinates, so a wide face and a narrow face get the same square windows. Each window lights up when a
 * hash of its cell is below uLit, so "more lit windows" needs no textures and no extra geometry. uDark
 * blacks the wall out and draws cracks (an unhealthy floor), uStale greys it out (no data).
 */
export function makeWindowMaterial(spec: WindowSpec): { material: THREE.MeshStandardMaterial; uniforms: WindowUniforms } {
  const uniforms: WindowUniforms = {
    uLit: { value: 0.5 },
    uDark: { value: 0 },
    uStale: { value: 0 },
    uSeed: { value: Math.random() * 100 },
  }
  const material = new THREE.MeshStandardMaterial({
    color: spec.color,
    roughness: spec.roughness ?? 0.85,
    metalness: 0.0,
    flatShading: true,
  })
  const cell = spec.cell ?? 1.2
  const win = spec.win ?? [0.62, 0.78]
  const odd = (n: number | undefined) => (n === undefined ? 0 : Math.round(n / cell) % 2 === 1 ? 0.5 : 0)
  const key = `win|${cell}|${win}|${spec.floorHeight}|${odd(spec.width)}|${odd(spec.depth)}|${spec.radial ?? 0}|${spec.brick ? 1 : 0}`

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uGlow: WINDOW_GLOW,
      uCell: { value: new THREE.Vector2(cell, spec.floorHeight) },
      uWin: { value: new THREE.Vector2(win[0], win[1]) },
      uOffX: { value: odd(spec.width) },
      uOffZ: { value: odd(spec.depth) },
      uRadial: { value: spec.radial ?? 0 },
      uBrick: { value: spec.brick ? 1 : 0 },
      uLodNear: { value: 0.07 },
      uLodFar: { value: 0.3 },
      uGlass: { value: new THREE.Color(palette.window.glass) },
      uLitColor: { value: new THREE.Color(palette.window.lit) },
      uDeadColor: { value: new THREE.Color(palette.window.dead) },
      uTrim: { value: new THREE.Color(spec.trim ?? '#f1ece0') },
    })
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjNormal;\nvarying vec3 vLocal;\nvarying vec2 vWinUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjNormal = normal;\nvLocal = position;\nvWinUv = uv;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vObjNormal;
varying vec3 vLocal;
varying vec2 vWinUv;
uniform float uGlow;
uniform float uLit, uDark, uStale, uSeed, uOffX, uOffZ, uRadial, uBrick, uLodNear, uLodFar;
uniform vec2 uCell, uWin;
uniform vec3 uGlass, uLitColor, uDeadColor, uTrim;
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float winLit = 0.0;
float crack = 0.0;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float side = step(abs(vObjNormal.y), 0.5);
  bool alongX = abs(vObjNormal.z) > abs(vObjNormal.x);
  float cx;
  if (uRadial > 0.5) cx = vWinUv.x * uRadial;
  else cx = (alongX ? vLocal.x : vLocal.z) / uCell.x + (alongX ? uOffX : uOffZ);
  float cy = vLocal.y / uCell.y;
  vec2 cellId = vec2(floor(cx), floor(cy));
  vec2 f = vec2(fract(cx), fract(cy));
  // metres from the window centre, in this cell
  float cellW = uRadial > 0.5 ? (6.2831853 * 1.3 / uRadial) : uCell.x;
  vec2 m = vec2((f.x - 0.5) * cellW, (f.y - 0.5) * uCell.y);
  vec2 hw = uWin * 0.5;
  float inGlass = side * step(abs(m.x), hw.x) * step(abs(m.y), hw.y);
  float inFrame = side * step(abs(m.x), hw.x + 0.07) * step(abs(m.y), hw.y + 0.07) * (1.0 - inGlass);
  float sill = side * step(abs(m.x), hw.x + 0.14) * step(hw.y + 0.07, -m.y) * step(-m.y, hw.y + 0.17);
  // trim band where one floor meets the next
  float band = side * (step(f.y, 0.05) + step(0.955, f.y));
  vec3 wall = diffuseColor.rgb;
  if (uBrick > 0.5) {
    float course = step(0.5, fract(vLocal.y / 0.11));
    float joint = step(0.5, fract((alongX ? vLocal.x : vLocal.z) / 0.3 + course * 0.5));
    wall *= 0.92 + 0.08 * (course * 0.5 + joint * 0.5);
  }
  wall = mix(wall, uTrim, clamp(band, 0.0, 1.0) * 0.85);
  float h = hash21(cellId + uSeed);
  winLit = inGlass * step(h, uLit) * (1.0 - uDark) * (1.0 - uStale);
  vec3 deadWall = mix(wall, uDeadColor * 1.4, 0.75);
  wall = mix(wall, deadWall, uDark);
  float gray = dot(wall, vec3(0.299, 0.587, 0.114));
  wall = mix(wall, vec3(gray * 0.8 + 0.1), uStale);
  vec3 trim = mix(uTrim, vec3(0.3), max(uDark, uStale) * 0.7);
  vec3 glassCol = mix(uGlass, uDeadColor, max(uDark, uStale));
  vec3 col = wall;
  col = mix(col, trim, clamp(inFrame + sill, 0.0, 1.0));
  col = mix(col, glassCol, inGlass);
  // Far away a cell is only a few pixels and the grid shimmers, so blend toward the average colour of a wall.
  float px = max(fwidth(cx), fwidth(cy));
  float lod = smoothstep(uLodNear, uLodFar, px);
  col = mix(col, mix(wall, glassCol, 0.3), lod);
  winLit = mix(winLit, 0.3 * side * uLit * (1.0 - uDark) * (1.0 - uStale), lod);
  diffuseColor.rgb = col;
  // jagged cracks on dark floors
  float line1 = abs(fract(cx * 0.5 + 0.18 * sin(vLocal.y * 5.0 + uSeed)) - 0.5);
  float line2 = abs(fract(cx * 0.37 + 0.5 + 0.22 * sin(vLocal.y * 3.0 + uSeed * 2.0)) - 0.5);
  crack = side * uDark * (smoothstep(0.035, 0.012, line1) + smoothstep(0.03, 0.01, line2)) * step(0.15, f.y) * step(f.y, 0.92);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02), clamp(crack, 0.0, 0.9));
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += uLitColor * winLit * 1.5 * uGlow;`,
      )
  }
  material.customProgramCacheKey = () => key
  return { material, uniforms }
}
