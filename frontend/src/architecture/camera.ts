// The view of the diagram: which part of it is on screen. Plain rectangles in the diagram's own units, so every rule is unit tested; diagram.ts moves the SVG's
// viewBox to match.

export interface View { x: number; y: number; w: number; h: number }

/** The most the viewer can zoom out (a whole diagram a fifth of the screen wide) and in (a box fills the screen). */
export const MIN_SCALE = 0.2
export const MAX_SCALE = 3

/** Grows the rectangle around its centre until it has the shape of the screen, so nothing is stretched. */
export function matchScreen(v: View, screenW: number, screenH: number): View {
  if (screenW <= 0 || screenH <= 0) return v
  const ratio = screenW / screenH
  let { x, y, w, h } = v
  if (w / h < ratio) { const nw = h * ratio; x -= (nw - w) / 2; w = nw } else { const nh = w / ratio; y -= (nh - h) / 2; h = nh }
  return { x, y, w, h }
}

/** The whole diagram, with a little room around it, in the shape of the screen. */
export function fitView(width: number, height: number, screenW: number, screenH: number): View {
  return matchScreen({ x: 0, y: 0, w: Math.max(1, width), h: Math.max(1, height) }, screenW, screenH)
}

/** Screen pixels for each diagram unit. */
export const scaleOf = (v: View, screenW: number): number => (v.w > 0 ? screenW / v.w : 1)

/** Zooms by `factor` (above 1 closer) keeping the point under the pointer still. The result stays within the scales a screen can read. */
export function zoomAbout(v: View, factor: number, px: number, py: number, screenW: number, minScale = MIN_SCALE, maxScale = MAX_SCALE): View {
  const now = scaleOf(v, screenW)
  const next = Math.min(maxScale, Math.max(minScale, now * factor))
  const f = next / now
  return { x: px - (px - v.x) / f, y: py - (py - v.y) / f, w: v.w / f, h: v.h / f }
}

/** Moves the view by a drag of dx, dy screen pixels. */
export function panBy(v: View, dx: number, dy: number, screenW: number): View {
  const k = v.w / screenW
  return { ...v, x: v.x - dx * k, y: v.y - dy * k }
}

/** The point of the diagram under a screen position. */
export function pointAt(v: View, sx: number, sy: number, screenW: number, screenH: number): { x: number; y: number } {
  return { x: v.x + (sx / screenW) * v.w, y: v.y + (sy / screenH) * v.h }
}

export const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)

export function between(a: View, b: View, t: number): View {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t }
}
