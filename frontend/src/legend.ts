// The legend card: what each thing in the town means. The words live here, as data, so a test can hold them to the colour rules
// (red only ever means a failure, amber is a warning, grey is no data) and to the list of things the town really draws.
// The card has four tabs. Each tab holds one or more sections; each section holds entries (a picture, what you see, what it means).

import { groupWords, withGroupWords } from './groupLabel'

export type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'grey' | 'blue'

export type TabId = 'problems' | 'islands' | 'buildings' | 'traffic' | 'controls'

/** How islands reach each other: every call through the hub, or straight along the ring road. */
export type Topology = 'hub-and-spoke' | 'direct'

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
  /** Shown only in a town with this topology. Without it, in every town. */
  topology?: Topology
  /** Shown only when the town runs on demo data. */
  demoOnly?: boolean
  /** Kept in the data but not shown, with the reason: the thing is not built yet or not used yet. Remove it to show the entry again. */
  hidden?: string
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
  { id: 'islands', title: 'Islands', icon: '🗺️', blurb: 'The places in the town, and how they are laid out.' },
  { id: 'buildings', title: 'Buildings', icon: '🏢', blurb: 'What each building is, and how to read how it is doing.' },
  { id: 'traffic', title: 'Traffic', icon: '🚗', blurb: 'How requests and messages travel between the islands.' },
  { id: 'controls', title: 'Controls', icon: '🎛️', blurb: 'The numbers along the top and the buttons around the town.' },
]

export const LEGEND: readonly LegendSection[] = [
  {
    id: 'problems',
    title: 'Failing or down',
    tab: 'problems',
    entries: [
      { id: 'beacon-red', sees: 'Red beacon', means: 'Requests are failing', more: 'A steady red light and a closed sign mean it is down.', tone: 'red', icon: 'svg:beacon-red' },
      { id: 'health-sign', sees: 'Red exclamation mark above a building', means: 'Your cloud provider reports a problem with its resource', more: 'It stays up while the provider\'s resource health report is open, and for a few hours after it is resolved. Open the building to read it or dismiss it.', tone: 'red', icon: 'svg:health-sign' },
      { id: 'flag', sees: 'Red flag on a car', means: 'A failed request, turned back at the door', tone: 'red', icon: 'svg:flag' },
      { id: 'pen', sees: 'Broken crates in a pen, a red beam and a count', means: 'Dead letters', more: 'Messages that could not be handled. The count is on the pen; the top bar DLQ number adds them all up.', tone: 'red', icon: 'svg:pen' },
      { id: 'dark', sees: 'Dark, cracked floors', means: 'Instances that are not healthy', more: 'The share of dark floors is the share of unhealthy instances, at least one floor if any is unhealthy.', tone: 'amber', icon: '🧱' },
    ],
  },
  {
    id: 'warnings',
    title: 'A warning',
    tab: 'problems',
    entries: [
      { id: 'beacon-amber', sees: 'Amber beacon', means: 'A warning', more: 'Some errors, throttling, dead letters, or CPU, memory or storage running hot.', tone: 'amber', icon: 'svg:beacon-amber' },
      { id: 'hazard', sees: 'Amber hazard lights on a car', means: 'Stuck in a line of cars behind a slow service', more: 'The service\'s p99 is past its SLA.', tone: 'amber', icon: '🚧' },
      { id: 'bubble', sees: 'Bubble over a line of cars', means: 'A "!" or a "+N waiting"', more: 'The "!" shows when p99 is well past the SLA and a car is stuck behind it. "+N waiting" counts the requests in flight that the lane has no room to draw.', tone: 'amber', icon: '💬' },
      { id: 'crates', sees: 'Crates piling up on a pier', means: 'A backlog: messages waiting for a worker', tone: 'amber', icon: '📦' },
      { id: 'weather', sees: 'Weather over an island', means: 'An open incident there', more: 'Clouds for severity 4, overcast for 3, rain for 2, a storm with lightning for 1. The worst one wins.', tone: 'amber', icon: '⛈️', hidden: 'The incident work (Phase 5) is not built yet. Remove this when it is.' },
    ],
  },
  {
    id: 'nodata',
    title: 'No fresh data',
    tab: 'problems',
    entries: [
      { id: 'grey', sees: 'Everything grey', means: 'No fresh data. Never read as healthy', tone: 'grey', icon: '🌫️' },
      { id: 'frozen', sees: 'The whole page goes grey', means: 'The live feed has gone quiet', more: 'No update for 45 seconds, so the numbers on screen are old. It clears by itself as soon as the feed is back. The town, the dashboard and the wall strip all do this.', tone: 'grey', icon: '❄️' },
    ],
  },
  {
    id: 'islands',
    title: 'The places',
    tab: 'islands',
    entries: [
      { id: 'island', sees: 'Island with its name floating over it', means: 'A {group}: one team\'s own services', more: 'Its services stand in rows. The name shows from the air and fades as you come close.', tone: 'neutral', icon: '🏘️' },
      { id: 'hub', sees: 'The island in the middle', means: 'The platform hub, shared by every island', more: 'The API gateway, the message broker (Service Bus, Kafka), central egress and the shared databases stand here, with clusters of platform resources such as Monitoring.', tone: 'neutral', icon: '⚓' },
      { id: 'vendor', sees: 'Small island out at sea', means: 'A third party, or a service outside the platform', more: 'A third party we call, or a service of the company outside the monitored platform (labelled internal). Several services of one vendor stand on one island. Health comes from our calls to it.', tone: 'neutral', icon: '🏝️' },
      { id: 'airport', sees: 'Airport', means: 'Callers from outside', more: 'It has an island of its own at the edge of the town. Arrivals follow the inbound traffic.', tone: 'neutral', icon: '✈️' },
    ],
  },
  {
    id: 'roads',
    title: 'The roads',
    tab: 'islands',
    entries: [
      { id: 'spoke', sees: 'Bridge from an island to the hub', means: 'The island\'s one road to the middle', more: 'An island has one when it has an API, or a call that crosses its coast. The airport has one too.', tone: 'neutral', icon: '🌉', topology: 'hub-and-spoke' },
      { id: 'ring-hub', sees: 'Ring road out at sea', means: 'The way to the third parties', more: 'Each island that calls a third party has a back-gate bridge to it. Islands do not use it to reach each other.', tone: 'neutral', icon: '⭕', topology: 'hub-and-spoke' },
      { id: 'ring-direct', sees: 'Ring road round the town', means: 'How islands reach each other, the airport and third parties', more: 'Every island has a bridge from its back gate to the ring road. Nothing crosses the hub.', tone: 'neutral', icon: '⭕', topology: 'direct' },
    ],
  },
  {
    id: 'buildings',
    title: 'On a {group} island',
    tab: 'buildings',
    entries: [
      { id: 'api', sees: 'Office tower', means: 'An API', tone: 'neutral', icon: '🏢' },
      { id: 'worker', sees: 'Factory', means: 'A worker: it reads messages', tone: 'neutral', icon: '🏭' },
      { id: 'database', sees: 'Tanks', means: 'A database', more: 'One tank for each tenant where each has its own.', tone: 'neutral', icon: '🛢️' },
      { id: 'engine', sees: 'Name on the front of a database', means: 'What the database runs on', more: 'The engine in capitals, such as COSMOS DB, with its type under it (Document, Relational). A database that names no engine shows its building\'s plain word instead.', tone: 'neutral', icon: '🏷️' },
      { id: 'yard', sees: 'Striped or pale unit in a yard', means: 'A test tenant', more: 'A "?" unit is a tenant nobody listed.', tone: 'neutral', icon: '🧪' },
      { id: 'cache', sees: 'Water tower', means: 'A cache', tone: 'neutral', icon: '🗼' },
      { id: 'function', sees: 'Clock tower', means: 'A scheduled function', tone: 'neutral', icon: '⏰' },
      { id: 'sign', sees: 'Sign with a hedge in front of a block', means: 'A service', more: 'Its API, worker and database, with the worst state of them.', tone: 'neutral', icon: '🪧' },
    ],
  },
  {
    id: 'hub-buildings',
    title: 'On the hub',
    tab: 'buildings',
    entries: [
      { id: 'gateway', sees: 'Gate house', means: 'The API gateway', tone: 'neutral', icon: '🚪' },
      { id: 'broker', sees: 'Warehouse on a jetty with a crane', means: 'The message broker', more: 'Service Bus or Kafka. Boats sail from here. Its sign has the broker\'s name and the counts of messages.', tone: 'neutral', icon: '🚢' },
      { id: 'egress', sees: 'Tower with a satellite dish', means: 'Central egress, the way out', tone: 'neutral', icon: '📡' },
    ],
  },
  {
    id: 'resources',
    title: 'Resources, not monitored',
    tab: 'buildings',
    entries: [
      { id: 'asset-vault', sees: 'Steel strongroom', means: 'A vault, such as a key vault', tone: 'neutral', icon: '🔐' },
      { id: 'asset-store', sees: 'Warehouse with crates', means: 'A store, such as a storage account', tone: 'neutral', icon: '📦' },
      { id: 'asset-settings', sees: 'Kiosk with a cog', means: 'A settings store', tone: 'neutral', icon: '⚙️' },
      { id: 'asset-observatory', sees: 'Domed observatory', means: 'Monitoring, such as a log workspace', tone: 'neutral', icon: '🔭' },
      { id: 'asset', sees: 'Plain box', means: 'Any other resource', more: 'Not a system. It stands behind a block, in the back yard, or in a cluster on the hub with a sign. None has lights or a beacon.', tone: 'neutral', icon: '🗃️' },
    ],
  },
  {
    id: 'outside',
    title: 'Outside',
    tab: 'buildings',
    entries: [
      { id: 'vendor-building', sees: 'Building with a plain stripe', means: 'A service of a third party', more: 'The stripe is neutral because it belongs to nobody in the town. Each service has its own building on the vendor\'s island.', tone: 'neutral', icon: '🏪' },
      { id: 'terminal', sees: 'Terminal, tower and arrivals board', means: 'The airport\'s buildings', more: 'The board lists the callers from outside and their traffic.', tone: 'neutral', icon: '🛬' },
    ],
  },
  {
    id: 'health',
    title: 'Reading a building',
    tab: 'buildings',
    entries: [
      { id: 'floors', sees: 'Floors', means: 'How many instances', more: '1, 2, 3 to 4, 5 to 8 and so on, doubling up to 8 floors. The plaque has the exact count. For a service in several regions they are the shown region\'s instances, not the total.', tone: 'neutral', icon: '🪜' },
      { id: 'region', sees: 'Region line and split under a name', means: 'A service in several regions', more: 'Which region the numbers are, and how its requests divide between them. A warning sign means one region takes too much while another runs.', tone: 'amber', icon: '🌍' },
      { id: 'windows', sees: 'Lit windows', means: 'Load', more: 'More windows light up as requests and resources rise.', tone: 'neutral', icon: '💡' },
      { id: 'beacon-green', sees: 'Green beacon on the roof', means: 'Errors are below the amber line', tone: 'green', icon: 'svg:beacon-green' },
    ],
  },
  {
    id: 'flow',
    title: 'How requests travel',
    tab: 'traffic',
    entries: [
      { id: 'flow-hub', sees: 'Island to island: over the hub', means: 'A call between islands goes through the hub', more: 'Out of the caller\'s door, over its bridge, round the hub\'s plaza and over the other island\'s bridge. Islands never connect to each other.', tone: 'neutral', icon: '🔀', topology: 'hub-and-spoke' },
      { id: 'flow-outside-hub', sees: 'From outside: airport, then the API gateway', means: 'Callers from outside come in at the hub\'s gateway', more: 'Arrivals at the airport follow the inbound traffic. The outside traffic starts at the gateway.', tone: 'neutral', icon: '🛬', topology: 'hub-and-spoke' },
      { id: 'flow-vendor-hub', sees: 'To a third party: back gate and ring road', means: 'Calls to third parties never go through the hub', more: 'Out of the caller\'s back gate, over its back bridge to the ring road, round the loop and down the third party\'s own road.', tone: 'neutral', icon: '🏝️', topology: 'hub-and-spoke' },
      { id: 'flow-hidden-hub', sees: 'An island the filter hides', means: 'Its traffic ends at the hub plaza', tone: 'neutral', icon: '🙈', topology: 'hub-and-spoke' },
      { id: 'flow-direct', sees: 'Island to island: along the ring road', means: 'Nothing crosses the hub', more: 'Out of the caller\'s back gate, round the ring road and in at the other island\'s back gate.', tone: 'neutral', icon: '🔀', topology: 'direct' },
      { id: 'flow-outside-direct', sees: 'From outside: the airport on the ring road', means: 'Callers from outside come from the airport', more: 'Arrivals follow the inbound traffic. The outside traffic starts at the airport.', tone: 'neutral', icon: '🛬', topology: 'direct' },
      { id: 'flow-vendor-direct', sees: 'To a third party: along the ring road', means: 'Down the third party\'s own road', more: 'Out of the caller\'s back gate, round the ring road and down the third party\'s road.', tone: 'neutral', icon: '🏝️', topology: 'direct' },
      { id: 'signpost', sees: 'Signpost at a gate', means: 'Traffic to or from a hidden island', more: 'An island the island filter has hidden. With no common hub to end at, the traffic ends at a signpost.', tone: 'neutral', icon: '🪧', topology: 'direct' },
    ],
  },
  {
    id: 'moving',
    title: 'What you see moving',
    tab: 'traffic',
    entries: [
      { id: 'car', sees: 'Blue car', means: 'A request between our own systems', tone: 'blue', icon: '🚙' },
      { id: 'taxi', sees: 'Yellow taxi', means: 'A request from outside', more: 'It arrives from the airport or the gateway.', tone: 'amber', icon: '🚕' },
      { id: 'queue', sees: 'Cars lined up at a door', means: 'Latency', more: 'The slower p99 is, the longer the line of cars.', tone: 'neutral', icon: '🚦' },
      { id: 'bridge', sees: 'Bridge', means: 'A synchronous call between islands', tone: 'neutral', icon: '🌉' },
      { id: 'boat', sees: 'Boats from the port to a pier', means: 'Messages: async traffic from the message broker', more: 'Messages never use a road. They travel from the broker to the island that reads them.', tone: 'neutral', icon: '⛵' },
      { id: 'arcs', sees: 'Dashed arcs between islands', means: 'Which islands call which', more: 'Thicker for more traffic. Off until you turn on Dependencies in Layers.', tone: 'neutral', icon: '🌈' },
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
    title: 'The buttons',
    tab: 'controls',
    entries: [
      { id: 'btn-layers', sees: 'Layers', means: 'Show or hide a family of things', more: 'Traffic, messaging, databases, workers, and the dependency arcs (off until you turn them on).', tone: 'neutral', icon: '🗂️' },
      { id: 'btn-theme', sees: 'Theme picker', means: 'Harbour, works or space station', tone: 'neutral', icon: '🎨' },
      { id: 'btn-quality', sees: 'Quality', means: 'Less detail for a slower computer', tone: 'neutral', icon: '🎚️' },
      { id: 'btn-search', sees: 'Search ( / )', means: 'Find a system or island', tone: 'neutral', icon: '🔎' },
      { id: 'btn-lighting', sees: 'Day / Dusk', means: 'Switch the light (remembered)', tone: 'neutral', icon: '🌗' },
      { id: 'btn-dashboard', sees: 'Dashboard', means: 'The same data as a plain table', tone: 'neutral', icon: '📋' },
      { id: 'btn-home', sees: 'Home', means: 'Frame the whole town again', tone: 'neutral', icon: '🏠' },
    ],
  },
  {
    id: 'modes',
    title: 'Ways to look',
    tab: 'controls',
    entries: [
      { id: 'wall', sees: 'Wall mode', means: 'For a screen nobody touches', more: 'The Wall button in the top bar (or ?wall=1 in the address): Dusk light, a tour of the troubled islands and a status strip. Esc leaves it. ?wall=1&islands=… shows only some islands.', tone: 'neutral', icon: '🖥️' },
      { id: 'break', sees: 'Break things panel', means: 'Try failures on demo data', more: 'Only when the town runs on demo data. Reset puts everything right.', tone: 'neutral', icon: '🧨', demoOnly: true },
    ],
  },
]

/** Every entry, flat. */
export const LEGEND_ENTRIES: readonly LegendEntry[] = LEGEND.flatMap((s) => s.entries)

export const LEGEND_SEEN_KEY = 'oc.legendSeen'

/**
 * What a town shows of the legend: the entries that belong to its topology and its mode (demo or live) and are not hidden, and no empty sections. The
 * {group} holes in the words become what the town calls an island (its groupLabel; Pillar when it sets none).
 */
export function forTown(sections: readonly LegendSection[], town: { topology: Topology; demo: boolean; groupLabel?: string | null }): LegendSection[] {
  const words = groupWords(town.groupLabel)
  const fill = (t: string): string => withGroupWords(t, words)
  return sections
    .map((s) => ({
      ...s,
      title: fill(s.title),
      entries: s.entries.filter((e) => (!e.topology || e.topology === town.topology) && (!e.demoOnly || town.demo) && !e.hidden)
        .map((e) => ({ ...e, sees: fill(e.sees), means: fill(e.means), ...(e.more ? { more: fill(e.more) } : {}) })),
    }))
    .filter((s) => s.entries.length > 0)
}
