// The time machines of the Town's travel overlay: a retro time-machine car that races along a road and blows up, and a blue police-box style cabin that spins through space. Both are drawn in
// code on a canvas (no images or other files) from the time since the jump started, and one of the two is picked at random for each jump. The date and the words stay in the page (see ui.ts).

export type Machine = 'car' | 'cabin'

/** How long a machine takes to travel, in milliseconds. */
export const MACHINE_MS = 2500

/** The machine for one jump: either one, at random. */
export function pickMachine(random: () => number = Math.random): Machine {
  return random() < 0.5 ? 'car' : 'cabin'
}

/** The machine a page asks for in its address (`?machine=car` or `?machine=cabin`), for trying one and for tests; anything else leaves the choice to chance. */
export function requestedMachine(search: string): Machine | null {
  const v = new URLSearchParams(search).get('machine')
  return v === 'car' || v === 'cabin' ? v : null
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

/** How far the journey has got, 0 to 1, after t seconds. It stays at 1 while the page waits for the frames to come. */
export function progress(t: number): number {
  return clamp(t / (MACHINE_MS / 1000), 0, 1)
}

/** Where the car is along its run: it speeds up across the visible width, always nose first (left when going back in time, right when going forward) and blows up at the end of the run, before it can leave the screen. */
export function carRun(p: number, back: boolean, visible: { x0: number; x1: number }): { x: number; alive: boolean; blast: number } {
  const q = clamp(p / 0.8, 0, 1)
  const startX = back ? visible.x1 + 150 : visible.x0 - 150
  const endX = back ? visible.x0 + 170 : visible.x1 - 170
  return { x: lerp(startX, endX, Math.pow(q, 1.5)), alive: p < 0.82, blast: clamp((p - 0.8) / 0.16, 0, 1) }
}

/** The turn of the cabin about its vertical axis, in radians: slow at first, faster as it goes, one way going back and the other going forward. */
export function cabinYaw(p: number, t: number, back: boolean): number {
  const e = ease(p)
  return (back ? -1 : 1) * (t * 0.8 + e * e * 5.5)
}

// ---- the drawing. The scene is laid out in a space 960 wide and 540 high; the part of it that is on screen is VX0..VX1 by VY0..VY1, which is wider or taller than that on other screen shapes.
const W = 960
const H = 540
let VX0 = 0
let VX1 = W
let VY0 = 0
let VY1 = H
let clockT = 0

/** Draws the machine at t seconds on a canvas of w by h pixels (the context is scaled by dpr). */
export function drawMachine(g: CanvasRenderingContext2D, kind: Machine, view: { w: number; h: number; dpr: number }, t: number, back: boolean): void {
  const s = clamp(Math.min(view.w / W, view.h / H), 0.7, 1.8)
  VX0 = W / 2 - view.w / (2 * s); VX1 = W / 2 + view.w / (2 * s)
  VY0 = H / 2 - view.h / (2 * s); VY1 = H / 2 + view.h / (2 * s)
  clockT = t
  g.save()
  g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0)
  g.translate(view.w / 2, view.h / 2)
  g.scale(s, s)
  g.translate(-W / 2, -H / 2)
  if (kind === 'car') car(g, t, back)
  else cabinScene(g, t, back)
  g.restore()
}

function flash(g: CanvasRenderingContext2D, p: number): void {
  const f = clamp((p - 0.86) / 0.1, 0, 1) * (1 - clamp((p - 0.97) / 0.03, 0, 1))
  if (f > 0) { g.fillStyle = `rgba(255,255,255,${f.toFixed(3)})`; g.fillRect(VX0, VY0, VX1 - VX0, VY1 - VY0) }
}

function bolt(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, seed: number, a: number): void {
  g.save()
  g.strokeStyle = `rgba(190,230,255,${a})`; g.lineWidth = 3; g.shadowColor = '#7cc4ff'; g.shadowBlur = 14
  g.beginPath(); g.moveTo(x1, y1)
  const n = 7
  for (let i = 1; i < n; i++) {
    const k = i / n
    g.lineTo(lerp(x1, x2, k) + (hash(seed + i) - 0.5) * 60, lerp(y1, y2, k) + (hash(seed + i + 50) - 0.5) * 60)
  }
  g.lineTo(x2, y2); g.stroke(); g.restore()
}

// ---- the time-machine car: an angular silver wedge facing right, about 245 wide around (0,0), fitted out with a rear reactor, a roof coil, glowing tubes and spinning rims
function carBody(g: CanvasRenderingContext2D, glow: number): void {
  const pu = 0.6 + 0.4 * Math.sin(clockT * 14)
  const glowFill = (c: string, a: number, blur: number): void => { g.fillStyle = c; g.shadowColor = c; g.shadowBlur = blur; g.globalAlpha = a }
  const noGlow = (): void => { g.shadowBlur = 0; g.globalAlpha = 1 }
  g.save()
  g.lineCap = 'round'; g.lineJoin = 'round'
  const ug = g.createRadialGradient(0, 30, 6, 0, 30, 150)
  ug.addColorStop(0, `rgba(110,200,255,${(0.5 * glow).toFixed(2)})`); ug.addColorStop(1, 'rgba(110,200,255,0)')
  g.fillStyle = ug; g.beginPath(); g.ellipse(0, 30, 150, 26, 0, 0, 7); g.fill()
  // rear exhaust pipes with a hot glow
  for (const y of [-2, 6]) {
    const pg = g.createLinearGradient(0, y - 6, 0, y + 6); pg.addColorStop(0, '#dfe5ee'); pg.addColorStop(1, '#6d778a')
    g.fillStyle = pg; g.fillRect(-138, y - 5, 34, 10)
    glowFill('#ff8a2a', 0.65 + 0.35 * pu, 18); g.beginPath(); g.ellipse(-139, y, 5, 6, 0, 0, 7); g.fill(); noGlow()
  }
  // body: a sharp wedge, high at the back and low at the nose
  const bg = g.createLinearGradient(0, -46, 0, 14); bg.addColorStop(0, '#f2f5fa'); bg.addColorStop(0.45, '#c3cad6'); bg.addColorStop(1, '#6c7689')
  g.shadowColor = `rgba(130,210,255,${glow})`; g.shadowBlur = 22
  g.fillStyle = bg; g.beginPath()
  g.moveTo(-122, 12); g.lineTo(-124, -12); g.lineTo(-112, -24); g.lineTo(-48, -30); g.lineTo(-30, -46)
  g.lineTo(14, -46); g.lineTo(84, -16); g.lineTo(122, -8); g.lineTo(126, 4); g.lineTo(120, 12); g.closePath(); g.fill()
  g.shadowBlur = 0
  g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 2; g.beginPath(); g.moveTo(-110, -22); g.lineTo(-46, -28); g.lineTo(80, -14); g.lineTo(120, -7); g.stroke()
  g.fillStyle = '#2b3345'; g.beginPath(); g.moveTo(-118, 6); g.lineTo(120, 6); g.lineTo(120, 12); g.lineTo(-122, 12); g.closePath(); g.fill()
  // glass, a reflection, the door seams and a handle
  const wg = g.createLinearGradient(-30, -44, 60, -16); wg.addColorStop(0, '#16284d'); wg.addColorStop(1, '#3d68a8')
  g.fillStyle = wg; g.beginPath(); g.moveTo(-34, -28); g.lineTo(-26, -42); g.lineTo(12, -42); g.lineTo(70, -17); g.lineTo(-34, -17); g.closePath(); g.fill()
  g.fillStyle = 'rgba(255,255,255,0.28)'; g.beginPath(); g.moveTo(-14, -41); g.lineTo(-2, -41); g.lineTo(34, -18); g.lineTo(22, -18); g.closePath(); g.fill()
  g.strokeStyle = '#2b3345'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(-8, -42); g.lineTo(-8, -17); g.stroke()
  g.strokeStyle = 'rgba(40,50,70,0.55)'; g.lineWidth = 1.8; g.beginPath(); g.moveTo(-34, -17); g.lineTo(-32, 6); g.moveTo(40, -16); g.lineTo(42, 6); g.stroke()
  g.fillStyle = '#505a6c'; g.fillRect(-26, -12, 16, 3.5)
  // two glowing tubes along the flank with light moving along them
  const tubes: Array<[string, number]> = [['#7fd8ff', 160], ['#ffb25a', -140]]
  tubes.forEach(([c, speed], i) => {
    const y = -3 + i * 6
    g.strokeStyle = '#3b4560'; g.lineWidth = 6; g.beginPath(); g.moveTo(-106, y); g.lineTo(104, y - 3); g.stroke()
    g.strokeStyle = c; g.lineWidth = 3; g.shadowColor = c; g.shadowBlur = 12; g.globalAlpha = 0.55 + 0.45 * pu
    g.setLineDash([14, 9]); g.lineDashOffset = -clockT * speed
    g.beginPath(); g.moveTo(-106, y); g.lineTo(104, y - 3); g.stroke(); g.setLineDash([]); noGlow()
  })
  // the rear reactor: a cylinder with glowing bands and a dome, and a tube over the roof to the coil
  const rg = g.createLinearGradient(-110, 0, -70, 0); rg.addColorStop(0, '#6f7a90'); rg.addColorStop(0.5, '#e4e9f2'); rg.addColorStop(1, '#6f7a90')
  g.fillStyle = rg; g.fillRect(-108, -54, 38, 28)
  for (const y of [-50, -42, -34]) { glowFill('#6ad2ff', 0.6 + 0.4 * pu, 12); g.fillRect(-106, y, 34, 3.5); noGlow() }
  g.fillStyle = '#505a6c'; g.beginPath(); g.ellipse(-89, -54, 19, 5, 0, 0, 7); g.fill()
  glowFill('#cfeeff', 0.5 + 0.4 * pu, 16); g.beginPath(); g.arc(-89, -56, 11, Math.PI, 0); g.fill(); noGlow()
  g.strokeStyle = '#9aa3b6'; g.lineWidth = 5; g.beginPath(); g.moveTo(-70, -44); g.quadraticCurveTo(-50, -66, -22, -58); g.stroke()
  g.strokeStyle = 'rgba(120,215,255,0.9)'; g.lineWidth = 2; g.beginPath(); g.moveTo(-70, -44); g.quadraticCurveTo(-50, -66, -22, -58); g.stroke()
  // the roof coil, an antenna with a beacon, and a small dish
  g.fillStyle = '#6f7a90'; g.fillRect(-20, -52, 30, 7)
  for (let r = 0; r < 4; r++) { g.strokeStyle = r % 2 ? '#c9d0de' : '#8893a8'; g.lineWidth = 3.5; g.beginPath(); g.ellipse(-5, -58 - r * 7, 15 - r * 1.5, 4, 0, 0, 7); g.stroke() }
  g.strokeStyle = '#c9d0de'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(-5, -86); g.lineTo(-5, -104); g.stroke()
  glowFill('#ffd060', 0.55 + 0.45 * Math.sin(clockT * 22 + 1), 18); g.beginPath(); g.arc(-5, -107, 5, 0, 7); g.fill(); noGlow()
  g.strokeStyle = '#c9d0de'; g.lineWidth = 3; g.beginPath(); g.moveTo(28, -42); g.lineTo(34, -54); g.stroke()
  g.fillStyle = '#e4e9f2'; g.beginPath(); g.ellipse(36, -57, 12, 5, -0.5, 0, 7); g.fill()
  // front light bar, headlight and nose vent, and the tail light
  glowFill('#e8f8ff', 0.7 + 0.3 * pu, 20); g.fillRect(100, -9, 24, 4.5); noGlow()
  g.fillStyle = '#fff6c0'; g.shadowColor = '#fff6c0'; g.shadowBlur = 24; g.fillRect(112, -4, 12, 5); g.shadowBlur = 0
  g.fillStyle = '#10141f'; g.fillRect(100, 1, 20, 4)
  glowFill('#ff3b3b', 0.7 + 0.3 * pu, 16); g.fillRect(-124, -12, 5, 18); noGlow()
  // wheels: tyres, bright rims with spinning spokes and a glowing ring
  for (const x of [-74, 72]) {
    g.fillStyle = '#10141f'; g.beginPath(); g.arc(x, 12, 24, 0, 7); g.fill()
    g.fillStyle = '#0c0e14'; g.beginPath(); g.arc(x, 14, 19, 0, 7); g.fill()
    const rm = g.createRadialGradient(x - 3, 11, 2, x, 14, 14); rm.addColorStop(0, '#f2f5fa'); rm.addColorStop(1, '#7d879b')
    g.fillStyle = rm; g.beginPath(); g.arc(x, 14, 13.5, 0, 7); g.fill()
    g.strokeStyle = '#3b4560'; g.lineWidth = 2.5
    for (let sp = 0; sp < 6; sp++) { const an = sp * 1.0472 + clockT * 26; g.beginPath(); g.moveTo(x + Math.cos(an) * 3, 14 + Math.sin(an) * 3); g.lineTo(x + Math.cos(an) * 12, 14 + Math.sin(an) * 12); g.stroke() }
    g.strokeStyle = `rgba(110,210,255,${(0.6 + 0.4 * pu).toFixed(2)})`; g.lineWidth = 2.5; g.shadowColor = '#6ad2ff'; g.shadowBlur = 12
    g.beginPath(); g.arc(x, 14, 16.5, 0, 7); g.stroke(); g.shadowBlur = 0
    g.fillStyle = '#c9d0de'; g.beginPath(); g.arc(x, 14, 3.2, 0, 7); g.fill()
  }
  g.restore()
}

function flame(g: CanvasRenderingContext2D, x: number, y: number, h: number, w: number, ph: number): void {
  if (h < 2) return
  const gr = g.createLinearGradient(x, y, x, y - h)
  gr.addColorStop(0, 'rgba(255,250,200,0.95)'); gr.addColorStop(0.35, 'rgba(255,170,50,0.9)'); gr.addColorStop(1, 'rgba(255,60,10,0)')
  g.fillStyle = gr; g.beginPath()
  g.moveTo(x - w, y); g.quadraticCurveTo(x - w * 0.6 + Math.sin(ph) * 3, y - h * 0.6, x + Math.sin(ph * 1.3) * 4, y - h)
  g.quadraticCurveTo(x + w * 0.6 + Math.sin(ph) * 3, y - h * 0.6, x + w, y); g.closePath(); g.fill()
}

function car(g: CanvasRenderingContext2D, t: number, back: boolean): void {
  const p = progress(t)
  const dir = back ? -1 : 1 // the car always drives nose first: left when going back, right when going forward
  const ROADTOP = 352
  const CARY = 308
  const VW = VX1 - VX0
  // the sky and a skyline far away, then the road
  const bgd = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.75)
  bgd.addColorStop(0, 'rgba(20,50,110,0.95)'); bgd.addColorStop(1, 'rgba(6,16,40,1)')
  g.fillStyle = bgd; g.fillRect(VX0, VY0, VW, VY1 - VY0)
  g.fillStyle = 'rgba(8,20,50,0.9)'
  for (let x = Math.floor(VX0 / 62) * 62; x < VX1; x += 62) {
    const i = Math.round(x / 62)
    g.fillRect(x - 10, ROADTOP - 10 - (40 + hash(i + 4) * 110), 50 + hash(i) * 40, 40 + hash(i + 4) * 110 + 10)
  }
  g.fillStyle = 'rgba(255,215,120,0.55)'
  for (let j = 0; j < 60; j++) g.fillRect(VX0 + hash(j) * VW, ROADTOP - 20 - hash(j + 40) * 120, 4, 5)
  g.fillStyle = '#10182e'; g.fillRect(VX0, ROADTOP, VW, VY1 - ROADTOP + 2)
  g.fillStyle = '#1a2440'; g.fillRect(VX0, ROADTOP, VW, 74)
  g.fillStyle = 'rgba(255,255,255,0.35)'
  for (let d = Math.floor(VX0 / 70) * 70; d < VX1; d += 70) g.fillRect(d, ROADTOP + 36, 34, 4)
  // the run
  const run = carRun(p, back, { x0: VX0, x1: VX1 })
  const { x } = run
  const ex = run.blast
  const startX = back ? VX1 + 150 : VX0 - 150
  const y = CARY + Math.sin(t * 45) * 1.5
  // fire on the road: it starts where the car has been and stays, higher near the car and dying off behind
  const trailLen = Math.abs(x - startX)
  for (let fx = Math.floor(VX0 / 8) * 8; fx < VX1; fx += 8) {
    const behind = (fx - startX) * dir
    if (behind < 0 || behind > trailLen) continue
    const age = (trailLen - behind) / 520
    const hgt = Math.max(0, 46 - age * 46) * (0.75 + 0.25 * Math.sin(t * 38 + fx * 0.31)) * (1 - ex * 0.5)
    flame(g, fx, ROADTOP + 14, hgt, 8, t * 20 + fx)
    flame(g, fx + 4, ROADTOP + 54, hgt * 0.8, 7, t * 22 + fx * 1.7)
  }
  const glow = g.createLinearGradient(0, ROADTOP, 0, ROADTOP + 74); glow.addColorStop(0, 'rgba(255,140,40,0.35)'); glow.addColorStop(1, 'rgba(255,140,40,0)')
  g.fillStyle = glow; g.fillRect(Math.min(startX, x), ROADTOP, Math.abs(x - startX), 74)
  // speed lines in the air
  g.save(); g.lineCap = 'round'
  for (let s = 0; s < 12; s++) {
    const sy = VY0 + 30 + s * 24, len = 140 + hash(s) * 200, sp = 1200 + hash(s + 9) * 900
    const sx = ((((hash(s + 3) * VW - dir * t * sp) % (VW + len)) + (VW + len)) % (VW + len)) + VX0 - len
    g.strokeStyle = 'rgba(190,220,255,0.28)'; g.lineWidth = 2; g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + len, sy); g.stroke()
  }
  g.restore()
  // lightning from the sky onto the car and the road around it, in flickering bursts
  if (p > 0.04 && p < 0.84) {
    const ph = Math.floor(t * 16)
    for (let bi = 0; bi < 4; bi++) {
      if (hash(ph * 7 + bi) > 0.38) {
        const tx = x + (hash(ph + bi * 3) - 0.5) * 340 * (bi ? 1 : 0.15)
        const ty = bi === 0 ? y - 40 : ROADTOP + 20 + hash(ph + bi) * 50
        bolt(g, tx + (hash(ph + bi + 8) - 0.5) * 260, VY0, tx, ty, ph * 5 + bi, 0.95)
        g.fillStyle = 'rgba(190,235,255,0.55)'; g.beginPath(); g.arc(tx, ty, 14 + hash(ph + bi) * 10, 0, 7); g.fill()
      }
    }
  }
  // the car, nose first in the direction of travel, with a beam ahead and a blue glow round it
  if (run.alive) {
    g.save(); g.translate(x, y); g.scale(dir * 1.25, 1.25)
    const beam = g.createLinearGradient(124, 0, 440, 0); beam.addColorStop(0, 'rgba(255,248,190,0.75)'); beam.addColorStop(1, 'rgba(255,248,190,0)')
    g.fillStyle = beam; g.beginPath(); g.moveTo(124, -3); g.lineTo(440, -60); g.lineTo(440, 52); g.lineTo(124, 4); g.closePath(); g.fill()
    g.globalAlpha = 0.55; g.strokeStyle = '#8fd0ff'; g.lineWidth = 3; g.shadowColor = '#8fd0ff'; g.shadowBlur = 24
    g.beginPath(); g.ellipse(0, -14, 160, 78, 0, 0, 7); g.stroke(); g.globalAlpha = 1; g.shadowBlur = 0
    carBody(g, 0.9)
    g.restore()
    for (const wx of [-74, 72]) flame(g, x + wx * 1.25 * dir, ROADTOP + 4, 40 + 10 * Math.sin(t * 50 + wx), 12, t * 30)
  }
  // the explosion: a white core, an orange fireball, a ring and flying pieces, with the car gone inside it
  if (p >= 0.8) {
    const r = 20 + ex * 230
    const ball = g.createRadialGradient(x, y, 0, x, y, r)
    ball.addColorStop(0, `rgba(255,255,255,${(1 - ex * 0.3).toFixed(2)})`)
    ball.addColorStop(0.35, `rgba(255,220,100,${(0.95 - ex * 0.4).toFixed(2)})`)
    ball.addColorStop(0.7, `rgba(255,100,20,${(0.8 - ex * 0.5).toFixed(2)})`)
    ball.addColorStop(1, 'rgba(60,20,10,0)')
    g.fillStyle = ball; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill()
    g.strokeStyle = `rgba(255,230,180,${(0.8 * (1 - ex)).toFixed(2)})`; g.lineWidth = 6 * (1 - ex) + 1; g.beginPath(); g.arc(x, y, r * 1.35, 0, 7); g.stroke()
    for (let pc = 0; pc < 36; pc++) {
      const ang = hash(pc) * 6.28, spd = 120 + hash(pc + 20) * 340
      const px = x + Math.cos(ang) * spd * ex, py = y + Math.sin(ang) * spd * ex + 300 * ex * ex
      g.fillStyle = pc % 3 ? `rgba(255,170,60,${(1 - ex).toFixed(2)})` : `rgba(210,215,225,${(1 - ex).toFixed(2)})`
      g.fillRect(px, py, 4 + hash(pc + 7) * 6, 3 + hash(pc + 9) * 5)
    }
  }
  const wash = Math.exp(-Math.pow((p - 0.82) / 0.05, 2))
  if (wash > 0.02) { g.fillStyle = `rgba(200,225,255,${(0.45 * wash).toFixed(3)})`; g.fillRect(VX0, VY0, VW, VY1 - VY0) }
  flash(g, p)
}

// ---- the cabin: a real 3D box with textured sides, turned by a yaw angle and tipped so the roof shows
const SIGN = { police: 'POLICE', public: 'PUBLIC', call: 'CALL', box: 'BOX' }

/** One side of the cabin in a space 112 wide and 200 high: a sign band, four windows that flash yellow, panelled doors and, on the front, a notice board. */
function boxFace(g: CanvasRenderingContext2D, w: number, t: number, notice: boolean): void {
  const fl = Math.sin(t * 9) > 0 ? 1 : 0.4
  const base = g.createLinearGradient(0, 0, 0, 200); base.addColorStop(0, '#1d54b6'); base.addColorStop(1, '#0f3586')
  g.fillStyle = base; g.fillRect(0, 0, w, 200)
  g.fillStyle = '#0a2a68'; g.fillRect(0, 0, 8, 200); g.fillRect(w - 8, 0, 8, 200)
  g.fillStyle = '#071a44'; g.fillRect(8, 6, w - 16, 28)
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1; g.strokeRect(10, 8, w - 20, 24)
  g.fillStyle = '#f4f7ff'; g.textBaseline = 'middle'; g.textAlign = 'left'
  const fs = 12.5
  g.font = `700 ${fs}px Inter, Arial, sans-serif`
  const x0 = 14
  g.fillText(SIGN.police, x0, 20); const pw = g.measureText(SIGN.police).width
  g.font = `600 ${fs * 0.42}px Inter, Arial, sans-serif`; g.fillText(SIGN.public, x0 + pw + 4, 15); g.fillText(SIGN.call, x0 + pw + 4, 25)
  const cw = g.measureText(SIGN.public).width
  g.font = `700 ${fs}px Inter, Arial, sans-serif`; g.fillText(SIGN.box, x0 + pw + 8 + cw, 20)
  const ww = (w - 16 - 14) / 2
  for (let c = 0; c < 2; c++) {
    const wx = 12 + c * (ww + 6), wy = 42
    g.fillStyle = '#0a2a68'; g.fillRect(wx - 3, wy - 3, ww + 6, 52)
    g.fillStyle = `rgba(255,224,110,${(0.35 + 0.65 * fl).toFixed(2)})`; g.shadowColor = '#ffd84a'; g.shadowBlur = 16 * fl
    for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) g.fillRect(wx + i * (ww / 2), wy + j * 16.5, ww / 2 - 2, 14.5)
    g.shadowBlur = 0
  }
  for (let d = 0; d < 2; d++) {
    const dx = 8 + d * ((w - 16) / 2)
    for (let r = 0; r < 3; r++) {
      const py = 102 + r * 32
      g.fillStyle = '#0d3a8c'; g.fillRect(dx + 3, py, (w - 16) / 2 - 6, 28)
      g.strokeStyle = '#0a2a68'; g.lineWidth = 2; g.strokeRect(dx + 3, py, (w - 16) / 2 - 6, 28)
      g.strokeStyle = 'rgba(120,170,255,0.4)'; g.lineWidth = 1; g.strokeRect(dx + 6, py + 3, (w - 16) / 2 - 12, 22)
    }
  }
  g.fillStyle = '#0a2a68'; g.fillRect(w / 2 - 1.5, 40, 3, 160)
  if (notice) {
    g.fillStyle = '#eef2fa'; g.fillRect(16, 108, 24, 32)
    g.fillStyle = '#566'; for (let l = 0; l < 7; l++) g.fillRect(19, 112 + l * 4, 18 - (l % 3) * 4, 1.5)
    g.fillStyle = '#d9dfe9'; g.beginPath(); g.arc(w / 2 + 10, 124, 3, 0, 7); g.fill()
  }
}

type V3 = [number, number, number]
interface Face { P: V3[]; nz: number; depth: number; tex: number; base: string; glowing: boolean; textured: boolean }

function cabin(g: CanvasRenderingContext2D, t: number, yaw: number): void {
  const lamp = 0.65 + 0.35 * Math.sin(t * 7)
  const PITCH = -0.24
  const F = 1000
  const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(PITCH), sp = Math.sin(PITCH)
  const rot = (v: V3): V3 => {
    const x = v[0] * cyw - v[2] * syw, z = v[0] * syw + v[2] * cyw
    return [x, v[1] * cp - z * sp, v[1] * sp + z * cp]
  }
  const proj = (v: V3): V3 => { const r = rot(v), k = F / (F - r[2]); return [r[0] * k, r[1] * k, r[2]] }
  const faces: Face[] = []
  const box = (cx: number, cy: number, cz: number, w: number, h: number, d: number, base: string, glowing = false, textured = false): void => {
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, z0 = cz - d / 2, z1 = cz + d / 2
    const defs: Array<{ n: V3; tl: V3; tr: V3; bl: V3; br: V3; tex: number }> = [
      { n: [0, 0, 1], tl: [x0, y0, z1], tr: [x1, y0, z1], bl: [x0, y1, z1], br: [x1, y1, z1], tex: 0 },
      { n: [1, 0, 0], tl: [x1, y0, z1], tr: [x1, y0, z0], bl: [x1, y1, z1], br: [x1, y1, z0], tex: 1 },
      { n: [0, 0, -1], tl: [x1, y0, z0], tr: [x0, y0, z0], bl: [x1, y1, z0], br: [x0, y1, z0], tex: 2 },
      { n: [-1, 0, 0], tl: [x0, y0, z0], tr: [x0, y0, z1], bl: [x0, y1, z0], br: [x0, y1, z1], tex: 3 },
      { n: [0, -1, 0], tl: [x0, y0, z0], tr: [x1, y0, z0], bl: [x0, y0, z1], br: [x1, y0, z1], tex: -1 }
    ]
    for (const f of defs) {
      const nr = rot(f.n)
      if (nr[2] <= 0.001) continue // turned away: not drawn
      const P = [proj(f.tl), proj(f.tr), proj(f.br), proj(f.bl)]
      faces.push({ P, nz: nr[2], depth: (P[0][2] + P[1][2] + P[2][2] + P[3][2]) / 4, tex: f.tex, base, glowing, textured })
    }
  }
  box(0, 104, 0, 124, 9, 124, '#071a44')
  box(0, 0, 0, 112, 200, 112, '#123f94', false, true)
  box(0, -105, 0, 130, 10, 130, '#0a2a68')
  box(0, -115, 0, 116, 10, 116, '#0f3586')
  box(0, -125, 0, 46, 10, 46, '#0a2a68')
  box(0, -136, 0, 32, 12, 32, '#143f8e')
  box(0, -150, 0, 24, 16, 24, '#78c8ff', true)
  box(0, -162, 0, 34, 6, 34, '#0a2a68')
  faces.sort((a, b) => a.depth - b.depth)
  const lp = proj([0, -150, 0])
  const lg = g.createRadialGradient(lp[0], lp[1], 4, lp[0], lp[1], 170); lg.addColorStop(0, `rgba(110,190,255,${(0.75 * lamp).toFixed(2)})`); lg.addColorStop(1, 'rgba(110,190,255,0)')
  g.fillStyle = lg; g.beginPath(); g.arc(lp[0], lp[1], 170, 0, 7); g.fill()
  const fl = Math.sin(t * 9) > 0 ? 1 : 0.4
  const wg = g.createRadialGradient(0, 0, 20, 0, 0, 190); wg.addColorStop(0, `rgba(255,215,90,${(0.22 * fl).toFixed(2)})`); wg.addColorStop(1, 'rgba(255,215,90,0)')
  g.fillStyle = wg; g.beginPath(); g.arc(0, 0, 190, 0, 7); g.fill()
  for (const f of faces) {
    const P = f.P, shade = 1 - Math.min(1, f.nz)
    g.save()
    if (f.textured && f.tex >= 0) {
      const tl = P[0], tr = P[1], bl = P[3]
      g.transform((tr[0] - tl[0]) / 112, (tr[1] - tl[1]) / 112, (bl[0] - tl[0]) / 200, (bl[1] - tl[1]) / 200, tl[0], tl[1])
      boxFace(g, 112, t + f.tex * 0.15, f.tex === 0)
      g.fillStyle = `rgba(0,12,45,${(0.5 * shade).toFixed(2)})`; g.fillRect(0, 0, 112, 200)
      g.restore(); continue
    }
    g.beginPath(); g.moveTo(P[0][0], P[0][1]); g.lineTo(P[1][0], P[1][1]); g.lineTo(P[2][0], P[2][1]); g.lineTo(P[3][0], P[3][1]); g.closePath()
    if (f.glowing) { g.fillStyle = `rgba(130,205,255,${(0.65 + 0.35 * lamp).toFixed(2)})`; g.shadowColor = '#78c8ff'; g.shadowBlur = 26; g.fill() }
    else {
      g.fillStyle = f.base; g.fill()
      g.fillStyle = f.tex === -1 ? 'rgba(160,200,255,0.18)' : `rgba(0,12,45,${(0.5 * shade).toFixed(2)})`; g.fill()
    }
    g.restore()
  }
}

/** The effects round the cabin: rings of energy pulsing out, golden sparks spiralling in and lightning from the lamp. Layer 0 is behind the cabin, layer 1 in front of it. */
function cabinEffects(g: CanvasRenderingContext2D, t: number, p: number, e: number, sgn: number, x: number, y: number, sc: number, layer: number): void {
  const live = clamp(p / 0.12, 0, 1) * (1 - clamp((p - 0.86) / 0.1, 0, 1))
  if (layer === 0) {
    for (let k = 0; k < 4; k++) {
      const ph = (t * (1.1 + e) + k * 0.25) % 1, rr = 90 + ph * 330
      g.strokeStyle = `rgba(150,215,255,${((1 - ph) * 0.5 * live).toFixed(2)})`; g.lineWidth = 3 + (1 - ph) * 4
      g.beginPath(); g.ellipse(x, y + 10, rr, rr * 0.34, 0, 0, 7); g.stroke()
    }
  }
  for (let i = 0; i < 70; i++) {
    const a = hash(i) * 6.2832 + t * (1.4 + 4 * e) * sgn + i * 0.07
    const r = (150 + hash(i + 40) * 170) * (1 - 0.45 * e) * sc * 1.1
    if ((layer === 1) !== (Math.sin(a) > 0)) continue
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r * 0.36 + (hash(i + 9) - 0.5) * 120
    const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 8 + i))
    g.fillStyle = `rgba(255,${Math.round(190 + hash(i + 3) * 50)},90,${(tw * live).toFixed(2)})`; g.shadowColor = '#ffc850'; g.shadowBlur = 10
    g.beginPath(); g.arc(px, py, 1.5 + hash(i + 12) * 2.5, 0, 7); g.fill(); g.shadowBlur = 0
    g.strokeStyle = `rgba(255,200,100,${(0.3 * live).toFixed(2)})`; g.lineWidth = 1.5
    g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.sin(a) * 14 * sgn, py - Math.cos(a) * 14 * 0.36 * sgn); g.stroke()
  }
  if (layer === 1 && p > 0.1 && p < 0.88) {
    const ph2 = Math.floor(t * 14)
    for (let b = 0; b < 3; b++) {
      if (hash(ph2 * 3 + b) > 0.5) {
        const ang = hash(ph2 + b * 5) * 6.2832, len = 200 + hash(ph2 + b) * 160
        bolt(g, x, y - 140 * sc, x + Math.cos(ang) * len, y - 140 * sc + Math.sin(ang) * len * 0.6, ph2 * 7 + b, 0.9 * live)
      }
    }
  }
}

function cabinScene(g: CanvasRenderingContext2D, t: number, back: boolean): void {
  const p = progress(t), e = ease(p)
  const sgn = back ? -1 : 1
  const VW = VX1 - VX0, VH = VY1 - VY0
  const cx = W / 2, cy = H / 2 - 10
  // deep space: a dark gradient, two nebula clouds, twinkling stars and a planet
  const sp = g.createLinearGradient(0, VY0, 0, VY1); sp.addColorStop(0, '#04061a'); sp.addColorStop(1, '#0d0a2a')
  g.fillStyle = sp; g.fillRect(VX0, VY0, VW, VH)
  const n1 = g.createRadialGradient(VX0 + VW * 0.25, VY0 + VH * 0.3, 10, VX0 + VW * 0.25, VY0 + VH * 0.3, 360); n1.addColorStop(0, 'rgba(150,60,170,0.35)'); n1.addColorStop(1, 'rgba(150,60,170,0)')
  g.fillStyle = n1; g.fillRect(VX0, VY0, VW, VH)
  const n2 = g.createRadialGradient(VX0 + VW * 0.78, VY0 + VH * 0.62, 10, VX0 + VW * 0.78, VY0 + VH * 0.62, 340); n2.addColorStop(0, 'rgba(40,130,190,0.32)'); n2.addColorStop(1, 'rgba(40,130,190,0)')
  g.fillStyle = n2; g.fillRect(VX0, VY0, VW, VH)
  for (let i = 0; i < 150; i++) {
    // stars drift past as the box travels, faster as it speeds up
    const z = 0.3 + hash(i + 3) * 0.7, drift = t * (40 + 360 * e) * z * sgn
    const sx = VX0 + ((((hash(i) * VW + drift) % VW) + VW) % VW), sy = VY0 + hash(i + 77) * VH
    const tw = 0.5 + 0.5 * Math.sin(t * 3 + i)
    g.fillStyle = `rgba(255,255,255,${(0.35 + 0.5 * tw * z).toFixed(2)})`
    const len = 1 + e * 14 * z
    g.fillRect(sgn > 0 ? sx : sx - len, sy, 1.6 + len, 1.6)
  }
  const plx = VX0 + VW * 0.84, ply = VY0 + VH * 0.86
  const pl = g.createRadialGradient(plx, ply, 10, plx, ply, 170); pl.addColorStop(0, '#5aa0e8'); pl.addColorStop(0.55, '#2a5ca8'); pl.addColorStop(1, '#0a1840')
  g.fillStyle = pl; g.beginPath(); g.arc(plx, ply, 150, 0, 7); g.fill()
  g.fillStyle = 'rgba(90,170,110,0.45)'; g.beginPath(); g.ellipse(plx - 30, ply - 40, 60, 26, -0.5, 0, 7); g.fill()
  // time vortex rings behind the cabin
  for (let r = 0; r < 12; r++) {
    const zz = (((r / 12 + t * 0.35 * -sgn) % 1) + 1) % 1, rad = Math.pow(zz, 1.9) * 700 + 10
    g.strokeStyle = `hsla(${200 + zz * 70},85%,65%,${(Math.sin(zz * Math.PI) * 0.28).toFixed(2)})`; g.lineWidth = 1 + zz * 3
    g.beginPath(); g.ellipse(cx, cy, rad, rad * 0.62, 0, 0, 7); g.stroke()
  }
  for (let a2 = 0; a2 < 5; a2++) {
    g.strokeStyle = 'rgba(170,210,255,0.16)'; g.lineWidth = 5; g.beginPath()
    for (let k = 0; k < 36; k++) {
      const rr = 20 + k * 15, th = a2 * 1.256 + k * 0.11 * sgn + t * 2.2 * sgn
      const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr * 0.62
      if (k) g.lineTo(x, y); else g.moveTo(x, y)
    }
    g.stroke()
  }
  const core = g.createRadialGradient(cx, cy, 0, cx, cy, 240); core.addColorStop(0, `rgba(225,240,255,${(0.28 + 0.4 * e).toFixed(2)})`); core.addColorStop(1, 'rgba(110,180,255,0)')
  g.fillStyle = core; g.fillRect(VX0, VY0, VW, VH)
  // the cabin floats and turns about its axis, slowly at first and faster as it goes, then fades out in a flash
  const x = cx + Math.sin(t * 3.1) * 36 * e, y = cy + Math.cos(t * 2.3) * 20 * e
  const scale = 0.5 + 0.5 * Math.sin(clamp(p * 1.3, 0, 1) * Math.PI / 2) - 0.25 * clamp((p - 0.82) / 0.18, 0, 1)
  const appear = clamp(p / 0.15, 0, 1) * (1 - clamp((p - 0.84) / 0.1, 0, 1))
  cabinEffects(g, t, p, e, sgn, x, y, scale, 0)
  g.save(); g.translate(x, y); g.rotate(sgn * Math.sin(t * 3.2) * 0.1 * (0.4 + e)); g.scale(scale * 1.25, scale * 1.25)
  g.globalAlpha = appear
  cabin(g, t, cabinYaw(p, t, back))
  g.restore()
  cabinEffects(g, t, p, e, sgn, x, y, scale, 1)
  flash(g, p)
}
