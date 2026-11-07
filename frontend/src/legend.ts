// The legend card: what each thing in the town means. The words live here, as data, so a test can hold them to the colour rules
// (red only ever means a failure, amber is a warning, grey is no data) and to the list of things the town really draws.
// The card has four tabs. Each tab holds one or more sections; each section holds entries (a picture, what you see, what it means).

export type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'grey' | 'blue'

export type TabId = 'problems' | 'buildings' | 'traffic' | 'controls'

export interface LegendTab {
  id: TabId
  title: string
  icon: string
  /** One line under the tabs saying what to look for here. */
  blurb: string
}

export interface LegendEntry {
  id: string
  /** What you see. */
  sees: string
  /** What it means, in one short line. */
  means: string
  /** The long part, behind a "more" fold. Optional. */
  more?: string
  tone: Tone
  /** The picture: an emoji, or `svg:<name>` for one drawn in legendIcons.ts. */
  icon: string
}

export interface LegendSection {
  id: string
  title: string
  tab: TabId
  entries: readonly LegendEntry[]
}

export const LEGEND_TABS: readonly LegendTab[] = [
  { id: 'problems', title: 'Problems', icon: '🚨', blurb: 'What it looks like when something needs you, worst first.' },
  { id: 'buildings', title: 'Buildings', icon: '🏢', blurb: 'What each building is, and how to read how it is doing.' },
  { id: 'traffic', title: 'Traffic', icon: '🚗', blurb: 'Requests and messages moving between the buildings.' },
  { id: 'controls', title: 'Top bar and controls', icon: '🎛️', blurb: 'The numbers along the top and the buttons around the town.' },
]

export const LEGEND: readonly LegendSection[] = [
  {
    id: 'problems',
    title: 'Something is wrong',
    tab: 'problems',
    entries: [
      { id: 'beacon-red', sees: 'Red beacon', means: 'Requests are failing', more: 'A steady red light and a closed sign mean it is down.', tone: 'red', icon: 'svg:beacon-red' },
      { id: 'beacon-amber', sees: 'Amber beacon', means: 'A warning', more: 'Some errors, throttling, dead letters, or CPU, memory or storage running hot.', tone: 'amber', icon: 'svg:beacon-amber' },
      { id: 'health-sign', sees: 'Red exclamation mark above a building', means: 'Azure reports a problem with its resource', more: 'It stays up while Azure Resource Health has the report open, and for a few hours after it is resolved. Open the building to read it or dismiss it.', tone: 'red', icon: 'svg:health-sign' },
      { id: 'dark', sees: 'Dark, cracked floors', means: 'Instances that are not healthy', more: 'The share of dark floors is the share of unhealthy instances, at least one floor if any is unhealthy.', tone: 'amber', icon: '🧱' },
      { id: 'grey', sees: 'Everything grey', means: 'No fresh data. Never read as healthy', tone: 'grey', icon: '🌫️' },
      { id: 'frozen', sees: 'The whole page goes grey', means: 'The live feed has gone quiet', more: 'No update for 45 seconds, so the numbers on screen are old. It clears by itself as soon as the feed is back. The town, the dashboard and the wall strip all do this.', tone: 'grey', icon: '❄️' },
      { id: 'hazard', sees: 'Amber hazard lights', means: 'The queue is past the SLA', tone: 'amber', icon: '🚧' },
      { id: 'flag', sees: 'Red flag on a car', means: 'A failed request, turned back at the door', tone: 'red', icon: 'svg:flag' },
      { id: 'crates', sees: 'Crates piling up on a pier', means: 'A backlog: messages waiting for a worker', tone: 'amber', icon: '📦' },
      { id: 'pen', sees: 'Broken crates in a pen, a red beam and a count', means: 'Dead letters', more: 'Messages that could not be handled. The count is on the pen; the top bar DLQ number adds them all up.', tone: 'red', icon: 'svg:pen' },
      { id: 'weather', sees: 'Weather over an island', means: 'An open incident there', more: 'Clouds for severity 4, overcast for 3, rain for 2, a storm with lightning for 1. The worst one wins.', tone: 'amber', icon: '⛈️' },
      { id: 'pennant', sees: 'Amber pennant', means: 'A legacy route to migrate', more: 'A worker still reads the old egress topic.', tone: 'amber', icon: '🚩' },
    ],
  },
  {
    id: 'buildings',
    title: 'What it is',
    tab: 'buildings',
    entries: [
      { id: 'api', sees: 'Office tower', means: 'An API', tone: 'neutral', icon: '🏢' },
      { id: 'worker', sees: 'Factory', means: 'A worker: it reads messages', tone: 'neutral', icon: '🏭' },
      { id: 'database', sees: 'Tanks', means: 'A database', more: 'One tank for each tenant where each has its own.', tone: 'neutral', icon: '🛢️' },
      { id: 'cache', sees: 'Water tower', means: 'A cache', tone: 'neutral', icon: '🗼' },
      { id: 'function', sees: 'Clock tower', means: 'A scheduled function', tone: 'neutral', icon: '⏰' },
      { id: 'hub', sees: 'The island in the middle', means: 'The platform hub', more: 'API gateway, message broker port (Service Bus, Kafka), central egress, shared database.', tone: 'neutral', icon: '⚓' },
      { id: 'sign', sees: 'Sign with a hedge in front of a block', means: 'A service', more: 'Its API, worker and database, with the worst state of them.', tone: 'neutral', icon: '🪧' },
      { id: 'vendor', sees: 'Small island out at sea', means: 'A third party, or a service outside the platform', more: 'A third party we call, or a service of the company outside the monitored platform (labelled internal). Several services of one vendor stand on one island. Health comes from our calls to it.', tone: 'neutral', icon: '🏝️' },
      { id: 'yard', sees: 'Striped or pale unit in a yard', means: 'A test tenant', more: 'A "?" unit is a tenant nobody listed.', tone: 'neutral', icon: '🧪' },
      { id: 'asset', sees: 'Small plain building out the back', means: 'A resource that is not a system, and not monitored', more: 'Such as a key vault, a storage account or the log workspace. It stands behind a block, in the back yard, or in a cluster on the hub (a cluster has a sign).', tone: 'neutral', icon: '🗃️' },
    ],
  },
  {
    id: 'health',
    title: 'How a building is doing',
    tab: 'buildings',
    entries: [
      { id: 'floors', sees: 'Floors', means: 'How many instances', more: '1, 2, 3 to 4, 5 to 8 and so on, doubling up to 8 floors. The plaque has the exact count. For a service in several regions they are the shown region\'s instances, not the total.', tone: 'neutral', icon: '🪜' },
      { id: 'region', sees: 'Region line and split under a name', means: 'A service in several regions', more: 'Which region the numbers are, and how its requests divide between them. A warning sign means one region takes too much while another runs.', tone: 'amber', icon: '🌍' },
      { id: 'windows', sees: 'Lit windows', means: 'Load', more: 'More windows light up as requests and resources rise.', tone: 'neutral', icon: '💡' },
      { id: 'beacon-green', sees: 'Green beacon on the roof', means: 'Errors are below the amber line', tone: 'green', icon: 'svg:beacon-green' },
    ],
  },
  {
    id: 'requests',
    title: 'Requests',
    tab: 'traffic',
    entries: [
      { id: 'car', sees: 'Blue car', means: 'A request between our own systems', tone: 'blue', icon: '🚙' },
      { id: 'taxi', sees: 'Yellow taxi', means: 'A request from outside', more: 'It arrives by the airport or the gateway.', tone: 'amber', icon: '🚕' },
      { id: 'queue', sees: 'Cars queuing at a door', means: 'Latency', more: 'The slower p99 is, the longer the queue.', tone: 'neutral', icon: '🚦' },
      { id: 'bridge', sees: 'Bridge', means: 'A synchronous call between islands', tone: 'neutral', icon: '🌉' },
      { id: 'airport', sees: 'Airport', means: 'Callers from outside', more: 'Planes follow the inbound traffic.', tone: 'neutral', icon: '✈️' },
      { id: 'signpost', sees: 'Signpost at a gate', means: 'Traffic to or from a hidden island', more: 'An island the island filter has hidden.', tone: 'neutral', icon: '🪧' },
    ],
  },
  {
    id: 'messaging',
    title: 'Messages',
    tab: 'traffic',
    entries: [
      { id: 'boat', sees: 'Boats from the port to a pier', means: 'Messages: async traffic from the message broker', tone: 'neutral', icon: '⛵' },
    ],
  },
  {
    id: 'numbers',
    title: 'The numbers along the top',
    tab: 'controls',
    entries: [
      { id: 'chip-requests', sees: 'req/s', means: 'Requests a second', more: 'For the islands and tenants you are looking at. A note on the number says when it is not split by tenant.', tone: 'neutral', icon: '🚗' },
      { id: 'chip-messages', sees: 'msg/s', means: 'Messages a second, taken in by queues', more: 'Each queue counts where it is read, so a message that crosses two queues is counted twice.', tone: 'neutral', icon: '✉️' },
      { id: 'chip-errors', sees: 'errors', means: 'The share of requests that fail', more: 'Amber from 1% and red from 5% by default; a system can set its own lines.', tone: 'neutral', icon: '⚠️' },
      { id: 'chip-p99', sees: 'p99', means: 'How slow the slowest 1% of requests are', tone: 'neutral', icon: '⏱️' },
      { id: 'chip-dlq', sees: 'DLQ', means: 'Dead letters in all queues. Click to list', tone: 'neutral', icon: '📮' },
      { id: 'chip-degraded', sees: 'degraded, down, no data', means: 'Systems in each state. Click to list', tone: 'neutral', icon: '🩺' },
      { id: 'chip-incidents', sees: 'incidents', means: 'Islands with an incident. Click to list', tone: 'neutral', icon: '🔔' },
      { id: 'chip-time', sees: 'town time', means: 'The clock of the town', tone: 'neutral', icon: '🕒' },
    ],
  },
  {
    id: 'buttons',
    title: 'The buttons and ways to look',
    tab: 'controls',
    entries: [
      { id: 'btn-layers', sees: 'Layers', means: 'Show or hide a family of things', more: 'Traffic, messaging, databases, workers, and the dependency arcs (off until you turn them on).', tone: 'neutral', icon: '🗂️' },
      { id: 'btn-theme', sees: 'Theme picker', means: 'Harbour, works or space station', tone: 'neutral', icon: '🎨' },
      { id: 'btn-quality', sees: 'Quality', means: 'Less detail for a slower computer', tone: 'neutral', icon: '🎚️' },
      { id: 'btn-search', sees: 'Search ( / )', means: 'Find a system or island', tone: 'neutral', icon: '🔎' },
      { id: 'btn-lighting', sees: 'Day / Dusk', means: 'Switch the light (remembered)', tone: 'neutral', icon: '🌗' },
      { id: 'btn-dashboard', sees: 'Dashboard', means: 'The same data as a plain table', tone: 'neutral', icon: '📋' },
      { id: 'btn-home', sees: 'Home', means: 'Frame the whole town again', tone: 'neutral', icon: '🏠' },
      { id: 'wall', sees: 'Wall mode', means: 'For a screen nobody touches', more: 'Add ?wall=1 to the address: Dusk light, a tour of the troubled islands and a status strip. ?wall=1&islands=… shows only some islands.', tone: 'neutral', icon: '🖥️' },
      { id: 'break', sees: 'Break things panel', means: 'Try failures on demo data', more: 'Only when the town runs on demo data. Reset puts everything right.', tone: 'neutral', icon: '🧨' },
    ],
  },
]

/** Every entry, flat. */
export const LEGEND_ENTRIES: readonly LegendEntry[] = LEGEND.flatMap((s) => s.entries)

export const LEGEND_SEEN_KEY = 'oc.legendSeen'
