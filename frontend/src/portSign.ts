// The words on the hub's message-broker port: the broker's own name (Service Bus, Kafka, ...), so a town on Kafka does not read "SERVICE BUS".

const FALLBACK = 'SERVICE BUS'
const MAX = 16

/** What the broker reports for the whole town, as the broker's sign counts it. */
export interface PortCounts {
  topics: number
  subscriptions: number
  piers: number
  legacy: number
}

/** The broker sign's last line: how many topics and subscriptions the town has and how many piers they reach. Null when nothing is configured, so an unconfigured broker shows no counts. */
export function portCountsLine(p: PortCounts): { text: string; hot: boolean } | null {
  if (p.topics + p.subscriptions + p.piers + p.legacy === 0) return null
  const base = `${p.topics} topics · ${p.subscriptions} subscriptions · ${p.piers} pier${p.piers === 1 ? '' : 's'}`
  return { text: p.legacy > 0 ? `${base} · ${p.legacy} legacy` : base, hot: p.legacy > 0 }
}

/** The sign text for a broker named so: upper case, and short enough to fit the board. A broker with no name is the Service Bus. */
export function portSignText(name?: string | null): string {
  const text = (name ?? '').trim().toUpperCase()
  if (text.length === 0) return FALLBACK
  return text.length <= MAX ? text : `${text.slice(0, MAX - 1).trimEnd()}…`
}
