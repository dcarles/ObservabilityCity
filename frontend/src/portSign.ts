// The words on the hub's message-broker port: the broker's own name (Service Bus, Kafka, ...), so a town on Kafka does not read "SERVICE BUS".

const FALLBACK = 'SERVICE BUS'
const MAX = 16

/** The sign text for a broker named so: upper case, and short enough to fit the board. A broker with no name is the Service Bus. */
export function portSignText(name?: string | null): string {
  const text = (name ?? '').trim().toUpperCase()
  if (text.length === 0) return FALLBACK
  return text.length <= MAX ? text : `${text.slice(0, MAX - 1).trimEnd()}…`
}
