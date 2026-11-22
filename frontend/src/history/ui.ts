// The time bar: a button in the menu (it says "History" when live and the viewed time and speed when not), the popup with the quick picks, the strip and the
// controls, the travel animation and the note for a time with no data. It draws what the controller says and tells it what was pressed.

import './history.css'
import { escapeHtml } from '../picker'
import { addressAt, buildStrip, clockText, fieldTime, fieldValue, quickPicks, SPEEDS, speedText, stripTime, stripTip, stripX, viewedText } from './model'
import type { HistoryController, HistoryState } from './controller'
import { drawMachine, MACHINE_MS, pickMachine, requestedMachine, type Machine } from './travelMachine'

export interface HistoryMount {
  /** The id of the button the clock button goes before (the Wall button of the page). */
  beforeId: string
  /** Called with true while the popup is open, so a page can close its own popups. */
  onOpen?: () => void
  /** The Town plays a time machine (a car or a cabin, at random) on the travel overlay; the other pages keep the plain animation. */
  machine?: boolean
}

const STRIP_W = 640
const STRIP_H = 76
const TRAVEL_MS = 1500
const MIDNIGHT_BAR = 16

const CLOCK = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" style="vertical-align:-3px"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 5.5V10l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const reduced = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function mountHistory(controller: HistoryController, mount: HistoryMount): void {
  const before = document.getElementById(mount.beforeId)
  if (!before?.parentElement) return
  const button = document.createElement('button')
  button.id = 'history-button'
  button.type = 'button'
  button.className = before.className.replace(/\bon\b/g, '').trim()
  button.setAttribute('aria-expanded', 'false')
  button.hidden = true
  before.parentElement.insertBefore(button, before)

  const pop = document.createElement('div')
  pop.id = 'history-pop'
  pop.hidden = true
  const noData = document.createElement('div')
  noData.id = 'history-nodata'
  noData.hidden = true
  const badge = document.createElement('div')
  badge.id = 'history-rebuilt'
  badge.hidden = true
  badge.textContent = 'Rebuilt from the cloud · approximate'
  badge.title = 'The app was not recording at this time, so this picture was worked out afterwards from what the cloud keeps: numbers are right to the nearest five minutes, instance counts are today\'s.'
  const travel = document.createElement('div')
  travel.id = 'history-travel'
  travel.hidden = true
  travel.innerHTML = `${mount.machine ? '<canvas class="scene" aria-hidden="true"></canvas>' : ''}<div class="streaks">${Array.from({ length: 14 }, (_, i) => `<i style="top:${6 + i * 6.7}%;animation-delay:${((i * 37) % 90) / 100}s;animation-duration:${0.7 + ((i * 13) % 6) / 10}s"></i>`).join('')}</div>
    <svg class="capsule" viewBox="0 0 100 100" aria-hidden="true"><path d="M14 56a36 34 0 0 1 72 0z" fill="rgba(120,170,255,0.35)" stroke="#bcd6ff" stroke-width="3"/><circle cx="50" cy="56" r="26" fill="#10224a" stroke="#bcd6ff" stroke-width="3"/><g class="hands"><line x1="50" y1="56" x2="50" y2="38" stroke="#fff" stroke-width="3" stroke-linecap="round"/><line x1="50" y1="56" x2="63" y2="56" stroke="#fff" stroke-width="3" stroke-linecap="round"/></g><rect x="22" y="84" width="56" height="6" rx="3" fill="#bcd6ff"/></svg>
    <div class="when" id="history-when"></div><div class="words" id="history-words"></div>
    <button class="skip" id="history-skip" type="button">Skip</button>`
  document.body.append(pop, noData, badge, travel)
  const when = travel.querySelector<HTMLElement>('#history-when')!
  const words = travel.querySelector<HTMLElement>('#history-words')!

  let open = false
  let dragging = false
  let tipAt: { x: number; text: string } | null = null
  let copied = false

  const text = (s: HistoryState): string => {
    if (!s.active) return 'History'
    const date = viewedText(s.viewed).slice(0, -5)
    return `${s.paused ? 'Paused · ' : ''}${date}${clockText(s.viewed)} · ${speedText(s.speed)}`
  }

  function position(): void {
    const r = button.getBoundingClientRect()
    pop.style.top = `${r.bottom + 6}px`
    const w = pop.offsetWidth || 680
    pop.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`
  }

  function geometry(s: HistoryState): { from: number; to: number; width: number; height: number } {
    const to = Date.now()
    return { from: to - s.days * 86_400_000, to, width: STRIP_W, height: STRIP_H - MIDNIGHT_BAR }
  }

  function stripSvg(s: HistoryState): string {
    const g = geometry(s)
    const strip = buildStrip(s.points, g, s.intervalMs)
    const handle = s.active ? stripX(g, Math.min(Math.max(s.viewed, g.from), g.to)) : null
    return `<svg viewBox="0 0 ${STRIP_W} ${STRIP_H}" preserveAspectRatio="none" id="history-strip-svg" role="img" aria-label="Degraded systems over the last ${s.days} days">
      <rect x="0" y="0" width="${STRIP_W}" height="${g.height}" fill="transparent"/>
      ${strip.gaps.map(([x, w]) => `<rect class="gap${s.fill?.available ? ' fillable' : ''}" x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${g.height}"/>`).join('')}
      ${strip.areas.map((a) => `<path class="area" d="${a}"/>`).join('')}
      ${strip.lines.map((l) => `<path class="line" d="${l}"/>`).join('')}
      ${strip.rebuilt.map(([x, w]) => `<rect class="rebuilt" x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${g.height}"/>`).join('')}
      ${strip.days.map((d) => `<line class="tick" x1="${d.x.toFixed(1)}" x2="${d.x.toFixed(1)}" y1="0" y2="${g.height + 4}"/><text class="daylabel" x="${(d.x + 3).toFixed(1)}" y="${STRIP_H - 3}">${escapeHtml(d.label)}</text>`).join('')}
      <line class="nowline" x1="${STRIP_W - 1}" x2="${STRIP_W - 1}" y1="0" y2="${g.height}"/>
      ${handle === null ? '' : `<line class="handle" x1="${handle.toFixed(1)}" x2="${handle.toFixed(1)}" y1="0" y2="${g.height + 4}"/>`}
    </svg>`
  }

  function drawPop(): void {
    const s = controller.state
    const now = Date.now()
    const picks = quickPicks(now, s.days)
    const field = s.active ? s.viewed : now - 3_600_000
    const range = s.frames === 0
      ? 'Nothing recorded yet. The app records while it runs and someone has the town open.'
      : `${s.points.filter((p) => !p.rebuilt).length} recorded and ${s.points.filter((p) => p.rebuilt).length} rebuilt frames from ${viewedText(s.oldest!)} to ${viewedText(s.newest!)} (${(s.bytes / 1024).toFixed(0)} KB on disk).`
    const fill = s.fill?.available
      ? (s.fill.running ? `Rebuilding the gaps from the cloud: ${s.fill.done} of ${s.fill.total} hours done${s.fill.hour ? `, now the hour of ${viewedText(Date.parse(s.fill.hour))}` : ''}.` : 'Gaps are rebuilt from the cloud in the background while you look at an environment.')
      : ''
    popKey = [s.active, s.paused, s.speed, s.loading, s.enabled, s.frames, s.points.length, s.oldest, s.newest, s.days, s.fill?.available, s.fill?.running, s.fill?.done, s.fill?.total, s.fill?.hour].join('|')
    pop.innerHTML = `
      <h3>Go to a time <span class="note">· back up to ${s.days} days${s.fill?.available ? ', recorded or rebuilt from the cloud' : ', only what was recorded'}</span></h3>
      <div class="row"><span class="label">Quick</span>${picks.map((p) => `<button type="button" class="hb" data-pick="${p.at}">${escapeHtml(p.label)}</button>`).join('')}</div>
      <div class="row"><span class="label">Date</span><input type="datetime-local" id="history-date" value="${fieldValue(field)}" min="${fieldValue(now - s.days * 86_400_000)}" max="${fieldValue(now)}"><button type="button" class="hb" id="history-go">Go</button></div>
      <div id="history-strip">${stripSvg(s)}<div id="history-tip" ${tipAt ? '' : 'hidden'} style="left:${tipAt?.x ?? 0}px">${escapeHtml(tipAt?.text ?? '')}</div></div>
      <div class="row"><span class="label">Speed</span>${SPEEDS.map((v) => `<button type="button" class="hb" data-speed="${v}" aria-pressed="${s.speed === v}">${speedText(v)}</button>`).join('')}
        ${s.active ? `<button type="button" class="hb" id="history-pause">${s.paused ? 'Play' : 'Pause'}</button>` : ''}</div>
      <div class="row">${s.active ? '<button type="button" class="hb live" id="history-live">Go back to live</button><button type="button" class="hb" id="history-copy">Copy link</button>' : ''}${copied ? '<span class="copied">Link copied</span>' : ''}</div>
      <div class="note">${escapeHtml(range)}</div>${fill ? `<div class="note" id="history-fill">${escapeHtml(fill)}</div>` : ''}`
    position()
  }

  function render(): void {
    const s = controller.state
    button.hidden = !s.enabled
    // live: only a small clock (the bar has little room, and "Live" is already said by the status); in the past: the moment and the speed, in words
    if (s.active) button.textContent = text(s) + (s.rebuilt ? ' · rebuilt' : '')
    else if (!button.querySelector('svg')) button.innerHTML = CLOCK
    button.setAttribute('aria-label', s.active ? `Looking at ${text(s)}. Open to jump, change the speed or go back to live.` : 'History')
    button.classList.toggle('travelling', s.active)
    button.title = s.active ? 'Looking at the past. Open to jump, change the speed or go back to live.' : 'Go back in time and see how the town looked'
    document.body.classList.toggle('history', s.active)
    noData.hidden = !(s.active && s.noData && !s.loading)
    noData.classList.toggle('filling', s.filling)
    if (!noData.hidden) noData.textContent = s.filling
      ? `Rebuilding ${viewedText(s.viewed)} from the cloud. This can take a minute; the town shows as soon as it is ready.`
      : `Nothing was recorded at ${viewedText(s.viewed)}${s.fill?.available ? ' and it could not be rebuilt from the cloud' : '. History only holds what the app recorded while it was running'}; later frames play as soon as they come.`
    badge.hidden = !(s.active && s.rebuilt && !s.noData)
    if (open && !dragging) {
      // the popup is drawn again only when something other than the moving clock changed: a click lands only on a button that was not replaced between pressing and letting go
      const key = [s.active, s.paused, s.speed, s.loading, s.enabled, s.frames, s.points.length, s.oldest, s.newest, s.days, s.fill?.available, s.fill?.running, s.fill?.done, s.fill?.total, s.fill?.hour].join('|')
      if (key !== popKey) drawPop()
      else moveHandle()
    }
  }

  let popKey = ''
  function moveHandle(): void {
    const s = controller.state
    const svg = pop.querySelector<SVGSVGElement>('#history-strip-svg')
    if (!svg || !s.active) return
    const g = geometry(s)
    const x = stripX(g, Math.min(Math.max(s.viewed, g.from), g.to)).toFixed(1)
    const line = svg.querySelector('.handle')
    line?.setAttribute('x1', x)
    line?.setAttribute('x2', x)
  }

  // ---- the popup

  function setOpen(next: boolean): void {
    open = next
    pop.hidden = !next
    button.setAttribute('aria-expanded', String(next))
    if (next) {
      mount.onOpen?.()
      void controller.refresh().then(() => { if (open) drawPop() })
      drawPop()
    }
  }
  button.addEventListener('click', () => setOpen(!open))
  document.addEventListener('pointerdown', (e) => {
    if (open && !(e.target as HTMLElement).closest('#history-pop, #history-button')) setOpen(false)
  })
  window.addEventListener('resize', () => { if (open) position() })

  const jump = (at: number): void => { setOpen(false); void controller.goTo(at) }

  pop.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const pick = t.closest<HTMLElement>('[data-pick]')
    if (pick) return jump(Number(pick.dataset.pick))
    const speed = t.closest<HTMLElement>('[data-speed]')
    if (speed) { controller.setSpeed(Number(speed.dataset.speed)); return }
    if (t.closest('#history-go')) {
      const at = fieldTime((pop.querySelector<HTMLInputElement>('#history-date')?.value) ?? '')
      if (at !== null) jump(at)
      return
    }
    if (t.closest('#history-pause')) { controller.setPaused(!controller.state.paused); return }
    if (t.closest('#history-live')) { setOpen(false); void controller.goLive(); return }
    if (t.closest('#history-copy')) {
      const link = `${window.location.origin}${addressAt(window.location, controller.state.viewed)}`
      const done = (): void => { copied = true; drawPop(); window.setTimeout(() => { copied = false; if (open) drawPop() }, 2000) }
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(done, done)
      else done()
    }
  })
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).id === 'history-date') pop.querySelector<HTMLElement>('#history-go')?.click()
  })

  // ---- the strip: hover tells the time, a click jumps, a drag moves the handle and jumps when let go
  const stripAt = (e: PointerEvent): { at: number; x: number } | null => {
    const svg = pop.querySelector<SVGSVGElement>('#history-strip-svg')
    if (!svg) return null
    const r = svg.getBoundingClientRect()
    const g = geometry(controller.state)
    const x = Math.min(r.width, Math.max(0, e.clientX - r.left))
    return { at: stripTime(g, (x / r.width) * g.width), x }
  }
  const showTip = (e: PointerEvent): void => {
    const hit = stripAt(e)
    const tip = pop.querySelector<HTMLElement>('#history-tip')
    if (!hit || !tip) return
    const s = controller.state
    tipAt = { x: hit.x, text: stripTip(s.points, hit.at, s.intervalMs) }
    tip.textContent = tipAt.text
    tip.style.left = `${hit.x}px`
    tip.hidden = false
  }
  pop.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement).closest('#history-strip')) return
    dragging = true
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    showTip(e)
  })
  pop.addEventListener('pointermove', (e) => {
    if (!(e.target as HTMLElement).closest('#history-strip') && !dragging) return
    showTip(e)
    if (dragging) {
      const hit = stripAt(e)
      const svg = pop.querySelector<SVGSVGElement>('#history-strip-svg')
      if (hit && svg) {
        const g = geometry(controller.state)
        svg.querySelectorAll('.handle').forEach((n) => n.remove())
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
        line.setAttribute('class', 'handle')
        const x = stripX(g, hit.at).toFixed(1)
        line.setAttribute('x1', x); line.setAttribute('x2', x); line.setAttribute('y1', '0'); line.setAttribute('y2', String(g.height + 4))
        svg.appendChild(line)
      }
    }
  })
  pop.addEventListener('pointerup', (e) => {
    if (!dragging) return
    dragging = false
    const hit = stripAt(e)
    if (hit) jump(hit.at)
  })
  pop.addEventListener('pointerleave', () => {
    if (dragging) return
    tipAt = null
    pop.querySelector<HTMLElement>('#history-tip')?.setAttribute('hidden', '')
  })

  // ---- the keys: Space plays and pauses, L goes live, the arrows step one frame while paused, Escape closes the popup
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement
    if (e.key === 'Escape' && open) { setOpen(false); return }
    if (!controller.state.active || e.ctrlKey || e.metaKey || e.altKey) return
    if (target.closest('input, textarea, select, [contenteditable]')) return
    if (e.key === ' ') { e.preventDefault(); controller.setPaused(!controller.state.paused) }
    else if (e.key === 'l' || e.key === 'L') void controller.goLive()
    else if (controller.state.paused && e.key === 'ArrowLeft') { e.preventDefault(); controller.step(-1) }
    else if (controller.state.paused && e.key === 'ArrowRight') { e.preventDefault(); controller.step(1) }
  })

  // ---- the travel animation: a tint, streaks, the clock capsule and the date counting from where the page was to where it goes; in the Town a time machine (a car or a cabin) travels instead of the capsule
  let travelId = 0
  let frame = 0
  let skip: (() => void) | null = null
  const canvas = travel.querySelector<HTMLCanvasElement>('canvas.scene')
  function paint(machine: Machine | null, started: number, back: boolean): void {
    if (!canvas || !machine) return
    const w = window.innerWidth
    const h = window.innerHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr) }
    const g = canvas.getContext('2d')
    if (g) drawMachine(g, machine, { w, h, dpr }, (performance.now() - started) / 1000, back)
  }
  function playTravel(from: number, to: number): void {
    travel.hidden = false
    const forward = to > from
    travel.classList.toggle('forward', forward)
    const back = !controller.state.active
    words.textContent = back ? 'Back to now…' : forward ? 'Travelling forward in time…' : 'Travelling back in time…'
    const machine: Machine | null = canvas && !reduced() ? (requestedMachine(window.location.search) ?? pickMachine()) : null
    travel.classList.toggle('machine', machine !== null)
    travel.dataset.machine = machine ?? ''
    const duration = reduced() ? 300 : machine ? MACHINE_MS : TRAVEL_MS
    const started = performance.now()
    cancelAnimationFrame(frame)
    const end = (): void => {
      cancelAnimationFrame(frame)
      skip = null
      const wait = (): void => {
        if (controller.state.loading) { words.textContent = 'Fetching what was recorded…'; paint(machine, started, !forward); frame = requestAnimationFrame(wait); return }
        travel.hidden = true
      }
      wait()
    }
    skip = end
    const step = (now: number): void => {
      const p = Math.min(1, (now - started) / duration)
      const eased = machine ? (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2) : 1 - Math.pow(1 - p, 3)
      when.textContent = viewedText(from + (to - from) * eased)
      paint(machine, started, !forward)
      if (p < 1) frame = requestAnimationFrame(step)
      else end()
    }
    frame = requestAnimationFrame(step)
  }
  travel.querySelector('#history-skip')!.addEventListener('click', () => skip?.())
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !travel.hidden) skip?.() })

  controller.subscribe(() => {
    const t = controller.state.travel
    if (t && t.id !== travelId) { travelId = t.id; playTravel(t.from, t.to) }
    render()
  })
  render()
}
