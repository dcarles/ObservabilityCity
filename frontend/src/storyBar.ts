import type { FxClient, FxState } from './fxClient'
import { escapeHtml } from './picker'
import { cameraMove, clockText, IDLE, nextSpeed, playAction, speedText, stepMarks, type StoryState, type StorySummary } from './story'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/**
 * The bottom story bar: pick a story and it plays, breaking the town step by step with a caption for each. Play and pause, speed, a
 * scrub bar with a tick for every step, and a camera that glides to the step's target when the step begins.
 */
export class StoryBar {
  private readonly el = $('story-bar')
  private stories: StorySummary[] = []
  private state: StoryState = IDLE
  private picked = ''
  private dragging = false
  private last = { story: null as string | null, step: -2 }

  constructor(private readonly client: FxClient, private readonly camera: (target: string) => void) {
    this.el.hidden = true
    client.onState((s) => this.setState(s))
    void client.stories().then((list) => {
      this.stories = list
      this.el.hidden = list.length === 0
      this.render()
      if (this.client.state) this.setState(this.client.state)
    })
  }

  private get story(): StorySummary | undefined {
    return this.stories.find((s) => s.id === this.state.storyId)
  }

  private setState(fx: FxState): void {
    const prev = this.state
    this.state = fx.story ?? IDLE
    // what the select shows is the story that plays; with none playing it is empty (a story stopped elsewhere clears it too)
    this.picked = this.state.storyId ?? ''
    const target = cameraMove(this.last, this.state)
    this.last = { story: this.state.storyId, step: this.state.step }
    if (target) this.camera(target)
    if (prev.storyId !== this.state.storyId) this.render()
    else this.update()
  }

  private render(): void {
    const marks = this.story ? stepMarks(this.story) : []
    this.el.innerHTML = `
      <p id="story-caption" class="caption"></p>
      <div class="controls">
        <select id="story-select" aria-label="Story">
          <option value="">Stories…</option>
          ${this.stories.map((s) => `<option value="${escapeHtml(s.id)}" title="${escapeHtml(s.description ?? '')}">${escapeHtml(s.name)}</option>`).join('')}
        </select>
        <button id="story-play" aria-label="Play">▶</button>
        <button id="story-stop" aria-label="Stop" title="Stop and clear the story">■</button>
        <button id="story-speed" title="Playback speed">1x</button>
        <div class="scrub"><input id="story-scrub" type="range" min="0" max="1000" value="0" aria-label="Position in the story" />
          <div class="marks">${marks.map((m) => `<i data-step="${m.index}" style="left:${(m.fraction * 100).toFixed(2)}%" title="${escapeHtml(this.story?.steps[m.index]?.caption ?? '')}"></i>`).join('')}</div></div>
        <span id="story-time" class="time"></span>
      </div>`
    this.wire()
    this.update()
  }

  private update(): void {
    const s = this.state
    const active = s.storyId !== null
    const play = this.el.querySelector<HTMLButtonElement>('#story-play')
    if (!play) return
    const action = playAction(s)
    play.textContent = action === 'pause' ? '❚❚' : '▶'
    play.setAttribute('aria-label', action === 'pause' ? 'Pause' : action === 'resume' && s.ended ? 'Play again' : 'Play')
    play.dataset.action = action
    this.el.dataset.state = !active ? 'idle' : s.ended ? 'ended' : s.playing ? 'playing' : 'paused'
    const select = this.el.querySelector<HTMLSelectElement>('#story-select')!
    if (document.activeElement !== select) select.value = this.picked
    this.el.querySelector('#story-speed')!.textContent = speedText(s.speed)
    const scrub = this.el.querySelector<HTMLInputElement>('#story-scrub')!
    scrub.disabled = !active
    if (!this.dragging) scrub.value = String(s.duration > 0 ? Math.round((s.position / s.duration) * 1000) : 0)
    this.el.querySelector('#story-time')!.textContent = active ? `${clockText(this.shownPosition())} / ${clockText(s.duration)}` : ''
    const caption = this.el.querySelector<HTMLElement>('#story-caption')!
    const text = active ? (s.ended ? 'The story is over. Press play to watch it again.' : s.caption ?? '') : ''
    caption.textContent = text
    caption.hidden = text === ''
    this.el.querySelectorAll<HTMLElement>('.marks i').forEach((m) => m.classList.toggle('past', Number(m.dataset.step) <= s.step))
  }

  private shownPosition(): number {
    const scrub = this.el.querySelector<HTMLInputElement>('#story-scrub')!
    return this.dragging ? (Number(scrub.value) / 1000) * this.state.duration : this.state.position
  }

  private wire(): void {
    this.el.querySelector<HTMLSelectElement>('#story-select')!.addEventListener('change', (e) => {
      const id = (e.target as HTMLSelectElement).value
      this.picked = id
      if (id) void this.client.play(id, this.state.speed)
      else void this.client.stop()
      ;(e.target as HTMLSelectElement).blur()
    })
    this.el.querySelector('#story-play')!.addEventListener('click', () => {
      const action = playAction(this.state)
      if (action === 'pause') void this.client.pause()
      else if (action === 'resume') void this.client.resume()
      else if (this.picked || this.stories[0]) {
        this.picked ||= this.stories[0].id
        void this.client.play(this.picked, this.state.speed)
      }
    })
    this.el.querySelector('#story-stop')!.addEventListener('click', () => { this.picked = ''; void this.client.stop() })
    this.el.querySelector('#story-speed')!.addEventListener('click', () => {
      const speed = nextSpeed(this.state.speed)
      this.state = { ...this.state, speed }
      this.update()
      void this.client.setSpeed(speed)
    })
    const scrub = this.el.querySelector<HTMLInputElement>('#story-scrub')!
    scrub.addEventListener('input', () => { this.dragging = true; this.update() })
    scrub.addEventListener('change', () => {
      const seconds = (Number(scrub.value) / 1000) * this.state.duration
      this.dragging = false
      void this.client.seek(seconds)
    })
  }
}
