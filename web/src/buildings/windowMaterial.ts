import * as THREE from 'three'
import { palette } from '../themes/harbour-town/palette'

/** Per-floor knobs the shader reads. Tweened by the building each frame. */
export interface WindowUniforms {
  uLit: { value: number }
  uDark: { value: number }
  uStale: { value: number }
  uSeed: { value: number }
}

export interface WindowSpec {
  color: string
  /** Window grid per face: columns across, rows up. */
  cols: number
  rows: number
  /** Width and height of one window inside its cell, 0..1. */
  winW?: number
  winH?: number
  roughness?: number
}

/**
 * A flat-shaded wall with a procedural window grid. Each window lights up when a hash of its cell is
 * below uLit, so "more lit windows" needs no textures and no geometry. uDark blacks the wall out and
 * draws cracks (an unhealthy floor), uStale greys it out (no data).
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
    roughness: spec.roughness ?? 0.8,
    metalness: 0.02,
    flatShading: true,
  })
  const glass = new THREE.Color(palette.window.glass)
  const lit = new THREE.Color(palette.window.lit)
  const dead = new THREE.Color(palette.window.dead)
  const key = `window-${spec.cols}-${spec.rows}-${spec.winW ?? 0.55}-${spec.winH ?? 0.5}`

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uCells: { value: new THREE.Vector2(spec.cols, spec.rows) },
      uWin: { value: new THREE.Vector2(spec.winW ?? 0.55, spec.winH ?? 0.5) },
      uGlass: { value: glass },
      uLitColor: { value: lit },
      uDeadColor: { value: dead },
    })
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjNormal;\nvarying vec2 vWinUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjNormal = normal;\nvWinUv = uv;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vObjNormal;
varying vec2 vWinUv;
uniform float uLit, uDark, uStale, uSeed;
uniform vec2 uCells, uWin;
uniform vec3 uGlass, uLitColor, uDeadColor;
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float winMask = 0.0;
float winLit = 0.0;
float crack = 0.0;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float side = step(abs(vObjNormal.y), 0.5);
  vec2 cell = floor(vWinUv * uCells);
  vec2 f = fract(vWinUv * uCells);
  vec2 edge = (1.0 - uWin) * 0.5;
  vec2 inWin = step(edge, f) * step(f, 1.0 - edge);
  // soft frame so windows read as recessed glass, not stickers
  winMask = side * inWin.x * inWin.y;
  float h = hash21(cell + uSeed);
  winLit = winMask * step(h, uLit) * (1.0 - uDark) * (1.0 - uStale);
  vec3 wall = diffuseColor.rgb;
  vec3 deadWall = mix(wall, uDeadColor * 1.4, 0.75);
  wall = mix(wall, deadWall, uDark);
  float gray = dot(wall, vec3(0.299, 0.587, 0.114));
  wall = mix(wall, vec3(gray * 0.8 + 0.1), uStale);
  vec3 glassCol = mix(uGlass, uDeadColor, max(uDark, uStale));
  diffuseColor.rgb = mix(wall, glassCol, winMask);
  // jagged cracks on dark floors
  float cx = vWinUv.x * uCells.x;
  float line1 = abs(fract(cx * 0.5 + 0.18 * sin(vWinUv.y * 11.0 + uSeed)) - 0.5);
  float line2 = abs(fract(cx * 0.37 + 0.5 + 0.22 * sin(vWinUv.y * 7.0 + uSeed * 2.0)) - 0.5);
  crack = side * uDark * (smoothstep(0.035, 0.012, line1) + smoothstep(0.03, 0.01, line2)) * step(0.15, vWinUv.y) * step(vWinUv.y, 0.92);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02), clamp(crack, 0.0, 0.9));
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += uLitColor * winLit * 1.6;`,
      )
  }
  material.customProgramCacheKey = () => key
  return { material, uniforms }
}
