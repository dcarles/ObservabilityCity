// Where an island sits on the wall's screen: the status strip covers the bottom of it, so an island is stood further back and lifted into the part above the strip. Pure.

/** The most the camera is pulled back (a tall strip on a small screen would otherwise push the island far out to sea). */
const MAX_ZOOM = 1.8
const MIN_ZOOM = 1.1

/**
 * `strip` and `viewport` are heights in pixels (the strip's real height including its gap to the screen edge). `zoom` multiplies the distance so the island still fills the
 * free part of the screen; `lift` is the fraction of the screen height to move the island up by, which puts its middle in the middle of the free part.
 */
export function wallFraming(strip: number, viewport: number): { zoom: number; lift: number } {
  if (!(viewport > 0) || !(strip > 0)) return { zoom: 1, lift: 0 }
  const covered = Math.min(0.6, strip / viewport)
  return { zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, 1 / (1 - covered))), lift: covered / 2 }
}
