// The wall's director: decides where the camera is and what the caption says. No DOM and no three.js, so the rules can be tested with a list of snapshots
// and a clock.
//
//   Trouble about (an incident, a system down or degraded, a system with no data): the tour visits it, worst first (incidents, then down, then degraded), holding at
//   each stop for `hold` seconds with a caption, then on to the next, round and round.
//   Nothing wrong: the showcase loop (the whole town with "All systems healthy, N h since last incident", the hub, each island in ring order, the busiest systems).
//   New trouble between two snapshots: the camera cuts to it at once (no glide) and holds there for a full stop; trouble that ends puts up a "resolved" note.

import type { Snapshot } from '../types'
import { attentionOf, type Attention, type AttentionKind, type Focus } from './attention'
import { calmScenes, type Scene } from './calm'
import { diffCues, type Cue } from './cues'

export interface Stop {
  /** The trouble's key or the scene's key. Stays the same while the stop is the same place. */
  key: string
  kind: AttentionKind | 'calm'
  focus: Focus
  caption: string
  /** True when the camera should jump there instead of gliding (new trouble). */
  cut: boolean
}

export interface Note {
  text: string
  /** The director's clock (seconds) after which the note goes away. */
  until: number
}

export type WallMode = 'alert' | 'calm'

const COOLDOWN_SECONDS = 3
const NOTE_SECONDS = 10

export class WallDirector {
  mode: WallMode = 'calm'
  current: Stop | null = null
  /** The "resolved" note on show, if any. */
  note: Note | null = null
  /** Set for as long as the screen should pulse: new trouble just arrived. The clock time it ends. */
  pulseUntil = 0
  /** How many times the camera has cut to new trouble. */
  cuts = 0
  /** The text of the cue that caused the last cut. */
  lastCue: Cue | null = null
  private snap: Snapshot | null = null
  private alertIndex = -1
  private calmIndex = -1
  private holdUntil = 0
  private lastCut = -Infinity

  constructor(private readonly hold: number, private readonly pulseSeconds = 4) {}

  /** Takes a new snapshot. Returns the stop when the camera has to go somewhere now (new trouble, or what it was on has ended), else null. */
  update(s: Snapshot, now: number): Stop | null {
    const cues = diffCues(this.snap, s)
    this.snap = s
    const attention = attentionOf(s)
    const modeBefore = this.mode
    this.mode = attention.length > 0 ? 'alert' : 'calm'

    for (const c of cues) if (c.kind === 'resolved') this.note = { text: c.text, until: now + NOTE_SECONDS }
    if (this.note && now >= this.note.until) this.note = null

    const trouble = cues.find((c) => c.kind === 'trouble')
    if (trouble?.attention && now - this.lastCut >= COOLDOWN_SECONDS) {
      this.cuts++
      this.lastCut = now
      this.lastCue = trouble
      this.pulseUntil = now + this.pulseSeconds
      this.alertIndex = attention.findIndex((a) => a.key === trouble.attention!.key)
      this.holdUntil = now + this.hold
      return (this.current = stopOfAttention(trouble.attention, true))
    }
    if (trouble?.attention) this.pulseUntil = now + this.pulseSeconds // trouble arrived too soon after the last cut to move again: the tour will get there, the screen still pulses

    if (!this.current) return this.advance(now)
    // what the camera is on has ended, or the town changed from trouble to calm or back: move on
    if (this.mode !== modeBefore) return this.advance(now)
    if (this.current.kind !== 'calm') {
      const still = attention.find((a) => a.key === this.current!.key)
      if (!still) return this.advance(now)
      this.current = { ...this.current, caption: still.caption }
    } else {
      const scene = calmScenes(s).find((c) => c.key === this.current!.key)
      if (scene) this.current = { ...this.current, caption: scene.caption }
    }
    return null
  }

  /** Called as time passes. Returns the next stop when the hold is over. */
  tick(now: number): Stop | null {
    if (this.note && now >= this.note.until) this.note = null
    if (!this.snap || !this.current || now < this.holdUntil) return null
    return this.advance(now)
  }

  /** Whether the screen should be pulsing red now. */
  pulsing(now: number): boolean {
    return now < this.pulseUntil
  }

  private advance(now: number): Stop | null {
    if (!this.snap) return null
    this.holdUntil = now + this.hold
    const attention = attentionOf(this.snap)
    if (attention.length > 0) {
      this.mode = 'alert'
      // on from where the camera is now, even if the list changed under it; from where it was when what it was on has ended
      const at = this.current ? attention.findIndex((a) => a.key === this.current!.key) : -1
      this.alertIndex = ((at >= 0 ? at : this.alertIndex) + 1) % attention.length
      return (this.current = stopOfAttention(attention[this.alertIndex], false))
    }
    this.mode = 'calm'
    const scenes = calmScenes(this.snap)
    this.calmIndex = this.current?.kind === 'calm' ? (this.calmIndex + 1) % scenes.length : 0
    return (this.current = stopOfScene(scenes[this.calmIndex], false))
  }
}

function stopOfAttention(a: Attention, cut: boolean): Stop {
  return { key: a.key, kind: a.kind, focus: a.focus, caption: a.caption, cut }
}

function stopOfScene(s: Scene, cut: boolean): Stop {
  return { key: s.key, kind: 'calm', focus: s.focus, caption: s.caption, cut }
}
