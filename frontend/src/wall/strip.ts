// The wall's always-on status strip: big words at the bottom of the screen, a red pulse over the town when trouble arrives, and a banner when the live
// connection is lost. Drawn from a StripModel; no state of its own beyond what is on screen.

import { escapeHtml } from '../picker'
import type { ConnectionState } from '../connection'
import type { StripModel } from './stripModel'

const CONNECTION_WORDS: Partial<Record<ConnectionState, string>> = {
  connecting: 'Connecting…',
  reconnecting: 'Connection lost. Reconnecting…',
  offline: 'Backend offline. Trying again…',
  badData: 'Bad data from the backend. Showing the last good town.',
}

export interface StripContent {
  model: StripModel
  townName: string
  environmentName: string
  caption: string
  /** The "resolved" note, or null. */
  note: string | null
  clock: string
}

export class WallStrip {
  private readonly strip = document.createElement('section')
  private readonly pulse = document.createElement('div')
  private readonly banner = document.createElement('div')
  private key = ''
  private connection: ConnectionState = 'connecting'

  constructor() {
    this.strip.id = 'wall-strip'
    this.pulse.id = 'wall-pulse'
    this.banner.id = 'wall-connection'
    this.banner.hidden = true
    this.strip.hidden = true
    document.body.append(this.pulse, this.banner, this.strip)
    document.body.classList.add('wall')
  }

  setConnection(state: ConnectionState): void {
    this.connection = state
    const words = state === 'connecting' ? undefined : CONNECTION_WORDS[state]
    this.banner.hidden = !words
    this.banner.textContent = words ?? ''
    this.banner.dataset.state = state
  }

  /** The red pulse over the town while it is on. */
  setPulse(on: boolean): void {
    this.pulse.classList.toggle('on', on)
  }

  render(c: StripContent): void {
    const key = JSON.stringify(c)
    if (key === this.key) return
    this.key = key
    const m = c.model
    this.strip.hidden = false
    this.strip.dataset.tone = m.tone
    const countChips = ([
      ['incidents', m.counts.incidents, 'incidents', 'bad'], ['down', m.counts.down, 'down', 'bad'], ['degraded', m.counts.degraded, 'degraded', 'warn'], ['stale', m.counts.stale, 'no data', 'warn'],
    ] as const).filter(([, n]) => n > 0).map(([id, n, label, tone]) => `<span class="wall-count ${tone}" data-count="${id}"><b>${n}</b> ${label}</span>`).join('')
    this.strip.innerHTML = `
      <div class="wall-row">
        <div class="wall-where"><b id="wall-town">${escapeHtml(c.townName)}</b><span>${escapeHtml(c.environmentName)}</span><span class="wall-clock">${escapeHtml(c.clock)}</span></div>
        <div class="wall-numbers">${m.numbers.map((n) => `<div class="wall-num ${n.tone}"><b>${escapeHtml(n.value)}</b><span>${escapeHtml(n.label)}</span></div>`).join('')}</div>
      </div>
      <div class="wall-headline" id="wall-headline">${escapeHtml(m.headline)}</div>
      ${countChips ? `<div class="wall-counts">${countChips}</div>` : ''}
      <div class="wall-caption" id="wall-caption">${escapeHtml(c.caption || m.subline)}</div>
      ${c.note ? `<div class="wall-note" id="wall-note">${escapeHtml(c.note)}</div>` : ''}`
    this.setConnection(this.connection)
  }

  /** What the strip says, for tests. */
  read(): { headline: string; caption: string; note: string | null; tone: string; connection: string; pulsing: boolean } {
    return {
      headline: this.strip.querySelector('#wall-headline')?.textContent ?? '',
      caption: this.strip.querySelector('#wall-caption')?.textContent ?? '',
      note: this.strip.querySelector('#wall-note')?.textContent ?? null,
      tone: this.strip.dataset.tone ?? '',
      connection: this.banner.hidden ? '' : this.banner.textContent ?? '',
      pulsing: this.pulse.classList.contains('on'),
    }
  }
}
