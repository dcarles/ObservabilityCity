// How fresh the data is, as plain functions: the marker in the menu, the popup's lines and where the popup goes.

import type { SourceFreshness } from '../types'

export const agoText = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds))
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`
}

export const intervalText = (seconds: number): string => {
  const s = Math.round(seconds)
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`
}

/** How long to wait for the next snapshot before the feed counts as late: three times the usual gap between snapshots, never under thirty seconds (the server sends one at least every fifteen). */
export function feedLateAfter(gapsSeconds: readonly number[]): number {
  if (gapsSeconds.length === 0) return 30
  const sorted = [...gapsSeconds].sort((a, b) => a - b)
  return Math.max(30, 3 * sorted[Math.floor(sorted.length / 2)])
}

/** The marker's words and whether it is amber. `sinceSnapshot` is seconds since the last snapshot arrived. */
export function marker(connected: boolean, sinceSnapshot: number | null, lateAfter: number): { text: string; late: boolean } {
  if (!connected) return { text: 'Not connected', late: true }
  if (sinceSnapshot === null) return { text: 'Connected · waiting for data', late: false }
  return { text: `Connected · snapshot ${Math.max(0, Math.round(sinceSnapshot))} s ago`, late: sinceSnapshot > lateAfter }
}

export interface SourceLine { name: string; lastRead: string; interval: string; overdue: boolean }

/** One line for each configured source: when it last reported (or that it has not), how often it is asked, and whether it is overdue. */
export function sourceLines(sources: readonly SourceFreshness[] | null | undefined, now: number): SourceLine[] {
  return (sources ?? []).map((x) => ({
    name: x.name,
    lastRead: x.lastRead ? agoText((now - Date.parse(x.lastRead)) / 1000) : 'not yet',
    interval: intervalText(x.intervalSeconds),
    overdue: x.overdue,
  }))
}

/** Where the popup's left edge goes: under the button, pulled back so the whole popup stays on the screen with a gutter either side. */
export function popupLeft(anchorLeft: number, popupWidth: number, viewportWidth: number, gutter = 16): number {
  return Math.max(gutter, Math.min(anchorLeft, viewportWidth - popupWidth - gutter))
}
