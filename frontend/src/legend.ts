// The legend card: what each thing in the town means. The words live here, as data, so a test can hold them to the colour rules
// (red only ever means errors, amber is a warning, grey is no data) and to the list of things the town really draws.

export type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'grey' | 'blue'

export interface LegendEntry {
  id: string
  /** What you see. */
  sees: string
  /** What it means. */
  means: string
  tone: Tone
}

export interface LegendSection {
  id: string
  title: string
  entries: readonly LegendEntry[]
}

export const LEGEND: readonly LegendSection[] = [
  {
    id: 'buildings',
    title: 'Buildings',
    entries: [
      { id: 'api', sees: 'Office tower', means: 'An API', tone: 'neutral' },
      { id: 'worker', sees: 'Factory', means: 'A worker: it reads messages', tone: 'neutral' },
      { id: 'database', sees: 'Tanks', means: 'A database. One tank for each tenant where each has its own', tone: 'neutral' },
      { id: 'cache', sees: 'Water tower', means: 'A cache', tone: 'neutral' },
      { id: 'function', sees: 'Clock tower', means: 'A scheduled function', tone: 'neutral' },
      { id: 'hub', sees: 'The island in the middle', means: 'The platform hub: API gateway, message broker port (Service Bus, Kafka), central egress, shared database', tone: 'neutral' },
    ],
  },
  {
    id: 'health',
    title: 'How a building is doing',
    entries: [
      { id: 'floors', sees: 'Floors', means: 'Instances: 1, 2, 3 to 4, 5 to 8 and so on, doubling up to 8 floors. The plaque has the exact count. For a service in several regions they are the shown region\'s instances, not the total', tone: 'neutral' },
      { id: 'region', sees: 'Region line and split under a name', means: 'A service in several regions: which region the numbers are, and how its requests divide between them. A warning sign means one region takes too much while another runs', tone: 'amber' },
      { id: 'windows', sees: 'Lit windows', means: 'Load: more windows light up as requests and resources rise', tone: 'neutral' },
      { id: 'dark', sees: 'Dark, cracked floors', means: 'Instances that are not healthy, in the same share', tone: 'amber' },
      { id: 'beacon-green', sees: 'Green beacon on the roof', means: 'Errors are below the amber line', tone: 'green' },
      { id: 'beacon-amber', sees: 'Amber beacon', means: 'A warning: some errors, throttling, or CPU, memory or storage running hot', tone: 'amber' },
      { id: 'beacon-red', sees: 'Red beacon', means: 'Requests are failing. A steady red light and a closed sign mean it is down', tone: 'red' },
      { id: 'grey', sees: 'Everything grey', means: 'No fresh data. Never read as healthy', tone: 'grey' },
    ],
  },
  {
    id: 'traffic',
    title: 'Requests',
    entries: [
      { id: 'car', sees: 'Blue car', means: 'A request between our own systems', tone: 'blue' },
      { id: 'taxi', sees: 'Yellow taxi', means: 'A request from outside, arriving by the airport or the gateway', tone: 'amber' },
      { id: 'queue', sees: 'Cars queuing at a door', means: 'Latency: the slower p99 is, the longer the queue', tone: 'neutral' },
      { id: 'hazard', sees: 'Amber hazard lights', means: 'The queue is past the SLA', tone: 'amber' },
      { id: 'flag', sees: 'Red flag on a car', means: 'A failed request, turned back at the door', tone: 'red' },
      { id: 'bridge', sees: 'Bridge', means: 'A synchronous call between islands', tone: 'neutral' },
    ],
  },
  {
    id: 'messaging',
    title: 'Messaging',
    entries: [
      { id: 'boat', sees: 'Boats from the port to a pier', means: 'Messages: async traffic from the message broker', tone: 'neutral' },
      { id: 'crates', sees: 'Crates piling up on a pier', means: 'A backlog: messages waiting for a worker', tone: 'amber' },
      { id: 'pen', sees: 'Broken crates in a pen, a red beam and a count', means: 'Dead letters', tone: 'red' },
      { id: 'pennant', sees: 'Amber pennant', means: 'A worker still reads the old egress topic: a legacy route to migrate', tone: 'amber' },
    ],
  },
  {
    id: 'world',
    title: 'The rest of the world',
    entries: [
      { id: 'weather', sees: 'Weather over an island', means: 'An open incident there: clouds for sev 4, overcast sev 3, rain sev 2, storm with lightning sev 1', tone: 'amber' },
      { id: 'airport', sees: 'Airport', means: 'Callers from outside. Planes follow the inbound traffic', tone: 'neutral' },
      { id: 'vendor', sees: 'Small island out at sea', means: 'A third party we call, or a service of the company outside the monitored platform (labelled internal). Several services of one vendor stand on one island. Health comes from our calls to it', tone: 'neutral' },
      { id: 'sign', sees: 'Sign with a hedge in front of a block', means: 'A service: its API, worker and database, with the worst state of them', tone: 'neutral' },
      { id: 'yard', sees: 'Striped or pale unit in a yard', means: 'A test tenant. A "?" unit is a tenant nobody listed', tone: 'neutral' },
      { id: 'asset', sees: 'Small plain building behind a block, in the back yard or in a cluster on the hub', means: 'A resource that is not a system, such as a key vault, a storage account or the log workspace (a cluster on the hub has a sign). It is not monitored', tone: 'neutral' },
      { id: 'signpost', sees: 'Signpost at a gate', means: 'Traffic to or from an island the island filter has hidden', tone: 'neutral' },
    ],
  },
]

/** Every entry, flat. */
export const LEGEND_ENTRIES: readonly LegendEntry[] = LEGEND.flatMap((s) => s.entries)

export const LEGEND_SEEN_KEY = 'oc.legendSeen'
