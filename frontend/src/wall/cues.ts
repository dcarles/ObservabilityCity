// What changed between two snapshots, in the words the wall puts up: new trouble (the camera cuts to it and the screen pulses red) and trouble that is over
// (a green note). Pure.

import type { Snapshot } from '../types'
import { attentionOf, type Attention, type AttentionKind } from './attention'

export interface Cue {
  kind: 'trouble' | 'resolved'
  /** What the cue is about (an incident id or a system id). */
  subject: string
  text: string
  /** For trouble: the stop to cut to. */
  attention?: Attention
}

const RANK: Record<AttentionKind, number> = { incident: 0, down: 1, degraded: 2, stale: 3 }

const bySubject = (list: Attention[]): Map<string, Attention> => {
  const m = new Map<string, Attention>()
  // a subject is in the list once (a system has one state); keep the worst if it ever were twice
  for (const a of list) if (!m.has(a.subject) || RANK[a.kind] < RANK[m.get(a.subject)!.kind]) m.set(a.subject, a)
  return m
}

/**
 * New trouble is a subject that was fine and is not, or one that got worse (degraded to down). Trouble that is over is a subject that was in the
 * list and is not. Going from down to degraded is neither: it is still trouble, and the tour carries on. The first snapshot has nothing to compare to, so no cues.
 * Trouble comes worst first.
 */
export function diffCues(prev: Snapshot | null, next: Snapshot): Cue[] {
  if (!prev) return []
  const before = bySubject(attentionOf(prev))
  const after = bySubject(attentionOf(next))
  const trouble: Cue[] = []
  const resolved: Cue[] = []
  for (const [subject, now] of after) {
    const was = before.get(subject)
    if (!was || RANK[now.kind] < RANK[was.kind]) trouble.push({ kind: 'trouble', subject, text: now.caption, attention: now })
  }
  for (const [subject, was] of before) {
    if (!after.has(subject)) {
      resolved.push({ kind: 'resolved', subject, text: was.kind === 'incident' ? `Resolved: ${was.caption.replace(/^Sev \d incident on /, 'incident on ')}` : `Resolved: ${was.name} is healthy again` })
    }
  }
  trouble.sort((a, b) => RANK[a.attention!.kind] - RANK[b.attention!.kind])
  return [...trouble, ...resolved]
}
