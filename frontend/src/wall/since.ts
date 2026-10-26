// "3 h since last incident": how long the islands on screen have been free of incidents, from the snapshot's own clock.

/** A span in words: minutes up to two hours, hours up to two days, then days. */
export function spanText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return 'under a minute'
  if (minutes < 120) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} days`
}

export interface IncidentClock {
  incidentFreeSince?: string | null
  incidentsSeen?: boolean
  generatedAt: string
}

/**
 * The tail of "All systems healthy, ...". The server says since when no incident has been open; when it has not seen one at all since it started
 * watching, the line says how long it has watched instead of claiming a record it cannot know about.
 */
export function sinceIncidentText(s: IncidentClock): string | null {
  if (!s.incidentFreeSince) return null
  const span = spanText(Date.parse(s.generatedAt) - Date.parse(s.incidentFreeSince))
  return s.incidentsSeen ? `${span} since last incident` : `no incident since watching began ${span} ago`
}
