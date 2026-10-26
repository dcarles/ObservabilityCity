import type { FxClient, FxEffect, FxState } from './fxClient'
import { Aim, effectLabel, hasIntensity, SCENARIOS, tenantToHit, type Scenario } from './scenarios'
import { escapeHtml, Picker, type PickItem } from './picker'
import type { TenantInfo } from './types'
import type { TenantView } from './tenants'

/** What the panel needs from the page. */
export interface BreakContext {
  /** Everything that can be aimed at: the town, islands, buildings. */
  targets(): PickItem[]
  tenants(): TenantInfo[]
  view(): TenantView
  /** Told when a scenario starts or stops waiting for a click in the town. */
  armedChanged(armed: boolean): void
}

/** Days the speed menu offers: how many real seconds one simulated day takes. */
export const DAY_LENGTHS: readonly { seconds: number; label: string }[] = [
  { seconds: 120, label: '2 min' },
  { seconds: 30, label: '30 s' },
  { seconds: 10, label: '10 s' },
]

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/**
 * The left "Break things" panel: pick a scenario, then click a building in the town (or search for a target) and it starts. What is
 * going on shows as chips with a strength slider. Reset puts the town right and stops any story; Calm freezes the daily cycle.
 */
export class BreakPanel {
  private readonly el = $('break-panel')
  private readonly aim = new Aim()
  private collapsed = false
  private state: FxState | null = null
  private chipKey = ''
  private note = ''
  private noteTimer: number | undefined

  constructor(private readonly client: FxClient, private readonly ctx: BreakContext) {
    this.render()
    client.onState((s) => this.setState(s))
    // Escape lets go of a scenario that is waiting for its target
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.armed && !(e.target instanceof HTMLInputElement)) this.cancel()
    })
  }

  /** True while a scenario waits for a building to be clicked. */
  get armed(): boolean {
    return this.aim.scenario !== null
  }

  /** A building (or any target) was chosen: aim the waiting scenario at it, or keep it for the next scenario. */
  aimAt(target: string): void {
    const before = this.armed
    const req = this.aim.aim(target, this.tenant())
    if (req) void this.fire(req, target)
    else if (before && this.armed) this.say('A tenant scenario needs one building, not the whole town.')
    this.afterAimChange(before)
  }

  /** Draws the panel again, for names that changed (the town was rebuilt). */
  refresh(): void {
    this.render()
  }

  cancel(): void {
    const before = this.armed
    this.aim.cancel()
    this.afterAimChange(before)
  }

  private tenant(): string | undefined {
    return tenantToHit(this.ctx.view().tenants, this.ctx.tenants())
  }

  private nameOf(target: string): string {
    const base = target.split('#')[0]
    const item = this.ctx.targets().find((t) => t.id === base)
    const name = item?.name.replace(/^Island: /, '') ?? base
    return target.includes('#') ? `${name} (${target.split('#')[1]})` : name
  }

  private async fire(req: { target: string; kind: string; intensity: number }, shown: string): Promise<void> {
    await this.client.addEffect(req.target, req.kind, req.intensity)
    this.say(`${effectLabel(req.kind, req.intensity)} started on ${this.nameOf(shown)}.`)
  }

  private afterAimChange(before: boolean): void {
    this.render()
    if (before !== this.armed) this.ctx.armedChanged(this.armed)
  }

  private say(text: string): void {
    this.note = text
    window.clearTimeout(this.noteTimer)
    this.noteTimer = window.setTimeout(() => { this.note = ''; this.updateHint() }, 6000)
    this.updateHint()
  }

  private hint(): string {
    const s = this.aim.scenario
    if (s) return `<b>${escapeHtml(s.label)}</b>: click a building in the town, or search for a target below. Esc lets go.${this.note ? ` <i>${escapeHtml(this.note)}</i>` : ''}`
    if (this.aim.target) return `Target: <b>${escapeHtml(this.nameOf(this.aim.target))}</b>. Now pick a scenario.`
    return this.note || 'Pick a scenario, then click a building in the town (or search for a target).'
  }

  private updateHint(): void {
    const h = this.el.querySelector('.hint')
    if (h) h.innerHTML = this.hint()
  }

  private setState(s: FxState): void {
    this.state = s
    // chips are drawn again only when the set of effects changes, so a slider being dragged is not pulled out from under the hand
    const key = JSON.stringify([s.effects.map((e) => [e.id, effectLabel(e.kind, e.intensity), e.target]), s.story.effects.map((e) => [e.id, effectLabel(e.kind, e.intensity), e.target])])
    if (key !== this.chipKey) {
      this.chipKey = key
      this.render()
    } else {
      s.effects.forEach((e) => {
        const input = this.el.querySelector<HTMLInputElement>(`.fxchip[data-id="${e.id}"] input`)
        if (input && document.activeElement !== input) input.value = String(Math.round(e.intensity * 100))
      })
      this.el.querySelectorAll<HTMLElement>('.fxchip.story').forEach((c) => {
        const e = s.story.effects.find((x) => x.id === c.dataset.id)
        if (e) c.querySelector('.pct')!.textContent = `${Math.round(e.intensity * 100)}%`
      })
    }
    this.syncControls()
  }

  private syncControls(): void {
    const s = this.state
    if (!s) return
    this.el.querySelector('#calm')?.classList.toggle('on', s.calm)
    const day = this.el.querySelector<HTMLSelectElement>('#day-length')
    if (day && document.activeElement !== day) day.value = String(DAY_LENGTHS.some((d) => d.seconds === s.dayLengthSeconds) ? s.dayLengthSeconds : '')
  }

  private chip(e: FxEffect): string {
    const slider = hasIntensity(e.kind)
      ? `<input type="range" min="0" max="100" value="${Math.round(e.intensity * 100)}" aria-label="Strength of ${escapeHtml(effectLabel(e.kind, e.intensity))}" />`
      : ''
    return `<div class="fxchip" data-id="${e.id}" data-kind="${e.kind}"><span class="name">${escapeHtml(effectLabel(e.kind, e.intensity))} · ${escapeHtml(this.nameOf(e.target))}</span><button class="x" title="Clear this" aria-label="Clear">✕</button>${slider}</div>`
  }

  private storyChip(e: FxEffect): string {
    return `<div class="fxchip story" data-id="${e.id}" data-kind="${e.kind}"><span class="name">${escapeHtml(effectLabel(e.kind, e.intensity))} · ${escapeHtml(this.nameOf(e.target))}</span><span class="tag">story</span><span class="pct">${Math.round(e.intensity * 100)}%</span></div>`
  }

  private scenarioButton(s: Scenario): string {
    return `<button data-scenario="${s.id}" data-fx="${s.kind}" class="${this.aim.scenario?.id === s.id ? 'on' : ''}" title="${escapeHtml(s.hint ?? '')}">${escapeHtml(s.label)}</button>`
  }

  private render(): void {
    const st = this.state
    this.el.dataset.collapsed = String(this.collapsed)
    this.el.dataset.armed = String(this.armed)
    const hadFocus = document.activeElement?.id === 'target'
    this.el.innerHTML = `
      <div class="head"><h3>Break things</h3><button id="fold" aria-label="${this.collapsed ? 'Open' : 'Fold'} the panel">${this.collapsed ? '▾' : '▴'}</button></div>
      <p class="hint">${this.hint()}</p>
      <div class="grid">${SCENARIOS.map((s) => this.scenarioButton(s)).join('')}</div>
      <label>Or search for a target</label>
      <div class="combo"><input id="target" type="text" placeholder="Type to find a target" autocomplete="off" spellcheck="false" /><div id="target-results" class="picker-results" hidden></div></div>
      <div class="chips" id="fx-chips">${(st?.effects ?? []).map((e) => this.chip(e)).join('')}${(st?.story.effects ?? []).map((e) => this.storyChip(e)).join('')}</div>
      <div class="row2">
        <button id="reset" title="Clear every effect, stop the story and set the day back to 2 minutes">Reset</button>
        <button id="calm" class="${st?.calm ? 'on' : ''}" title="Freeze the daily cycle and the noise">Calm</button>
      </div>
      <label for="day-length">A day takes</label>
      <select id="day-length" aria-label="How long a simulated day takes">${DAY_LENGTHS.map((d) => `<option value="${d.seconds}">${d.label}</option>`).join('')}<option value="" hidden>other</option></select>`
    this.syncControls()
    this.wire()
    if (hadFocus) this.el.querySelector<HTMLInputElement>('#target')?.focus()
  }

  private wire(): void {
    this.el.querySelector('#fold')!.addEventListener('click', () => { this.collapsed = !this.collapsed; this.render() })
    this.el.querySelectorAll<HTMLButtonElement>('[data-scenario]').forEach((b) =>
      b.addEventListener('click', () => {
        const s = SCENARIOS.find((x) => x.id === b.dataset.scenario)!
        const before = this.armed
        const chosen = this.aim.target
        const req = this.aim.arm(s, this.tenant())
        if (req) void this.fire(req, chosen ?? req.target)
        else if (s.tenant && chosen && !this.armed) this.say('Pick a building; a tenant scenario cannot hit the whole town.')
        this.afterAimChange(before)
      }))
    // the box shows the name as the list does, so an island reads "Island: Beta"
    const named = (): string => this.ctx.targets().find((t) => t.id === this.aim.target)?.name ?? ''
    new Picker(this.el.querySelector<HTMLInputElement>('#target')!, this.el.querySelector<HTMLElement>('#target-results')!, {
      items: () => this.ctx.targets(), limit: 200, showAll: true, label: named, onPick: (t) => this.aimAt(t.id),
    })
    this.el.querySelector('#reset')!.addEventListener('click', () => { this.cancel(); void this.client.reset() })
    this.el.querySelector('#calm')!.addEventListener('click', () => void this.client.setCalm(!this.state?.calm))
    this.el.querySelector<HTMLSelectElement>('#day-length')!.addEventListener('change', (e) => {
      const seconds = Number((e.target as HTMLSelectElement).value)
      if (seconds > 0) void this.client.setDay(seconds)
    })
    this.el.querySelectorAll<HTMLElement>('.fxchip:not(.story)').forEach((c) => {
      const id = c.dataset.id!
      c.querySelector('.x')!.addEventListener('click', () => void this.client.removeEffect(id))
      // the slider sends while it moves; a change that comes while one is on its way waits and goes after it
      let sending = false
      let pending: number | null = null
      const push = (v: number): void => {
        if (sending) { pending = v; return }
        sending = true
        void this.client.setIntensity(id, v).finally(() => {
          sending = false
          if (pending !== null) { const p = pending; pending = null; push(p) }
        })
      }
      c.querySelector<HTMLInputElement>('input')?.addEventListener('input', (e) => push(Number((e.target as HTMLInputElement).value) / 100))
    })
  }
}
