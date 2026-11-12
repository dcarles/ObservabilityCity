# Observability City: the plan

This is the overview of what the app is, how it works and what comes next. The full tour of features is in [README.md](../README.md), every config key is in [config-reference.md](config-reference.md), and the steps for a real environment are in [connect-your-company.md](connect-your-company.md).

## Summary

Observability City is a browser app that shows system health as a living, animated 3D town. Each group of systems (a pillar, a team, a domain: the town chooses the word) is an island, each system is a building, and what is going on shows in the town itself: floors for instances, lit windows for load, rooftop beacons for errors, cars for requests and boats for messages. The same data is also available as a plain dashboard.

The core is cloud-neutral. It ships an Azure adapter today; other clouds and tools plug in through adapters (see [write-an-adapter.md](write-an-adapter.md)).

It is for the people who run the systems: a team looking at its own islands, someone on call during an incident, and a wall screen in the office that nobody touches.

| Topic | How it is today |
| --- | --- |
| Backend | .NET 10 (ASP.NET Core and SignalR), started together with the frontend by a .NET Aspire app host. No Docker |
| Frontend | TypeScript, Vite and Three.js, with no UI framework (see [frontend-stack.md](frontend-stack.md)) |
| Demo mode | A town with `mode: demo` in `town.yaml` runs on the fake source: gentle noise, a daily traffic cycle and autoscaling, with the Break things panel and stories to show every failure on purpose |
| Live mode | A town with no `mode`, or `mode: live`, reads real sources through adapters and has no fake source, Break things panel or story bar |
| Where it runs | Locally on a developer's machine. It only reads from the sources. It writes only to the town's own `_discovered/` folder (found links, hosts added from the Unknown hosts panel, the last readings). It answers only this machine unless `Security:AllowedOrigins` lists other addresses. There is no sign-in yet |
| Open source | The repo holds only generic code and two sample towns. A company adds its own town folder, kept outside the clone or in a private mirror, and optional adapters under `extensions/`, and never edits core |

## Visual language

Each signal has exactly one visual meaning, and it reads the same in every theme. The words below are the harbour-town theme's; the other themes change the look, not the meaning.

**Colours.** Red means something is failing: errors or throttling past the red threshold, a system that is down, dead letters in a pen, or a health report from the cloud provider. Amber is a warning. Grey means a signal is configured but has no fresh data, and is never shown as healthy. A signal with no source configured is absent (its beacon is off), which is not the same as grey.

| Signal | What you see |
| --- | --- |
| Group | An island on a ring round the central hub (a pillar, team or domain: every part of the interface uses the town's `groupLabel`), in the order of `islands` in `town.yaml`. Up to `ringCapacity` islands (default 12) on the first ring, the rest on a staggered second ring |
| Hub | The island in the middle. In a hub-and-spoke town it holds the shared resources, for example an API gateway and the message broker's port, and an egress point or shared databases if you have them. It may hold several of each kind (two brokers, two gateways), each its own building; the traffic stays single: one pier per island, and the airport shows all gateways together |
| System | A building shaped by its role: an office for an API, a factory for a worker, a storage unit for a database (a storage yard for one database per tenant), a water tower for a cache, a clock tower for a function, a gate house for the gateway, a port for the broker and a tower with a dish for egress (an outbound proxy, if you have one) |
| Service | Systems that share a `service` stand together on one pad, with a low sign naming it and showing its worst state |
| Database engine | A database's sign names its engine (from `databaseEngines` in `town.yaml`), with its type underneath |
| Basic resources | Secrets stores, storage, config stores and other resources with no health of their own stand as simple buildings behind their service or in the island's back yard |
| Instances | Floors on a doubling scale (1, 2, 3-4, 5-8 ... 65+ gives 1 to 8 floors), with the count on the name board |
| Instance health | Dark, cracked floors for the share of unhealthy instances, and "5/10 healthy" on the plaque |
| Load | Lit windows, floor by floor from the ground: CPU for apps and workers, capacity used for a database. Chimney smoke thickens with CPU |
| Errors | The rooftop beacon: green, amber or red against the system's own thresholds (red pulses). High CPU, memory or database utilisation, a failed or overdue scheduled job and dead letters in a queue it reads make it amber |
| Throttling | A lowered barrier gate at a database. Throttling past the red threshold turns the beacon red |
| Down | A blackout, a "Closed for repairs" sign and a steady red beacon |
| Requests | Cars, as a sample and not a count. Blue sedans are internal calls, yellow taxis are calls from outside. The town shows at most 420 cars |
| Latency | Each building has a service lane of five cars, and the time at the door is the latency, so a slow system builds a queue. Over the SLA the queued cars blink amber hazard lights and a "!" bubble shows over the lane. A full lane shows "+N waiting" for the requests it has no room to draw |
| Failed request | A car with a red flag on its roof, turned away at the door. It is the only car that turns round |
| Sync calls | Bridges. In a hub-and-spoke town each island has one bridge to the hub, and calls between islands go through it. In a direct town (`topology: direct`) islands reach each other over an outer ring road |
| Messaging | Boats from the broker's port to an island's pier. Messages waiting pile up as crates on the quay. Bridges are sync, water is async |
| Dead letters | A pen of broken crates on the pier with a "DLQ N" badge and a sweeping red light. The top bar shows the town-wide total. Clicking a pier, a pen or the DLQ count lists the queues with dead letters |
| Scheduled jobs | A function's jobs send boats to the services the pillar file maps them to. An unmapped job shows "Job not mapped" |
| Regions | A service in two or more regions shows its worst region, with the split of requests under its name |
| Tenants | A store with one database per tenant is a yard with a unit for each tenant. Test tenants are paler and striped and never go past amber; an undeclared tenant is a purple unit marked "?" |
| Incident | Weather over the island it belongs to: light cloud for sev 4, overcast for sev 3, rain for sev 2, a storm with lightning for sev 1. The rest of the town stays sunny |
| Cloud health report | A red "!" above a building whose resource the cloud provider reports as degraded or unavailable |
| Outside callers | An airport whose planes land at the rate of outside traffic, with an arrivals board. Taxis carry the requests from the terminal into the town |
| Third parties | Vendor islands outside the ring road. A call leaves the island's back gate, goes round the ring road and down the vendor's own road |
| Who calls whom | The dependency overlay: dashed arcs between islands, as thick as the traffic between them (a layer, off until shown) |
| Lost & found | An optional island, id `lost-found`, with boxes and bins by its gate, for systems you declare that no team owns. It always stands last |
| Config error | A pillar file with problems is drawn as an island with a board saying what is wrong, and the rest of the town carries on |
| Stale data | A grey building. If the live feed itself goes quiet, the whole page goes grey |

## Views

**The town.** The 3D view: orbit, zoom, pan, Home, and search (`/`) for a system or island. Clicking a building opens the inspector drawer with Overview, Links, Logs and Config tabs. The top bar has the town, environment, tenant, island, layer, theme and quality choices, the totals, the connection state, Day/Dusk, the legend, Home, and the Wall and Dashboard buttons (in a "⋯" menu when the bar is full). Notices (config problems, failed reloads, unmapped jobs) and the Unknown hosts panel sit under it. The island filter (`?islands=`) is applied by the backend, so totals count only what is on screen; layers (`?hide=`, `?show=dependencies`) only hide things in the page.

**The dashboard.** `?view=dashboard`, remembered per browser. It reads the same snapshot and never loads Three.js. It has a service table (traffic with the share per region, errors, p99 against the SLA, CPU and memory per region, and the reason a service is amber or red), a Message flow tile, a Total traffic card, an Incidents card and a freshness marker for each source.

**Wall mode.** `?wall=1`, or the Wall button, which remembers "wall on" in the browser. It hides the bar and panels, uses Dusk and Medium quality, and shows a status strip with the headline, the totals and a caption. The camera tours by itself: an overview (the whole town, then each island seen from its front), then incidents, then what is down, then what is degraded, and a showcase loop when all is well. The timings and light have town defaults in `town.yaml` (`wall:`), and `&hold=`, `&overview=`, `&overviewIsland=` and `&light=` override them on one screen. Esc, the Exit wall chip or leaving full screen ends it. `?wall=1&view=dashboard` is the wall dashboard: the same strip and tour, opening one group at a time.

**Themes.** Harbour town (the default), space colony and works. A theme changes the buildings, ground, water, bridges, vehicles, sky and the wording of the legend; the data, the layout and every signal stay the same. Picking another theme reloads the page.

**Easter eggs.** The Konami code (or `?event`) plays a short scripted event for the theme in the town view: pirates, zombies or aliens. Nothing in the town is changed by it. See [easter-eggs.md](easter-eggs.md).

## Architecture

```
config/<town>/*.yaml -> registry loader -> sources poll -> latest state -> snapshot builder (rules) -> SignalR /hubs/town -> browser (Three.js or dashboard)
```

[how-it-fits-together.md](how-it-fits-together.md) follows this path step by step.

| Part | What it does |
| --- | --- |
| Contracts | The C# snapshot records are the wire format. `contracts/openapi.json` and `frontend/src/contracts.ts` are generated from them, and CI fails if they drift |
| Core | The registry loader and checks, the source interfaces, the poller and the snapshot builder with the health rules |
| Host | ASP.NET Core: one runtime per town and environment, the REST API (`/api/snapshot/latest`, `/api/systems/{id}`, its logs, towns, environments) and the SignalR hub |
| Frontend | Draws the town or the dashboard from the snapshot and invents all motion (cars, boats, planes, weather) from the rates in it. It never knows which source produced a number |
| Validate tool | The registry checks (`--all`) that CI runs, and `--sources`, which probes each configured source with your login |

**Adapters.** Sources are plug-in modules (`IAdapterModule`). The host loads every module it finds in its `adapters/` folder and does not reference any of them. The Azure adapter, the module that ships today, provides these source kinds:

| Kind | Reads |
| --- | --- |
| `resourcegraph` | The inventory: which resources belong to which system, through the environment's `scope` rules, and the instance counts |
| `loganalytics` | Request rate, error share and latency from your own query template, the split by region, and link discovery from dependency data |
| `azuremonitor` | Platform metrics (CPU, memory, capacity used, throttling) for the resources the scope found |
| `servicebus` | Backlog and dead letters per queue from the namespaces' metrics, message flows per group, and the message types a queue handled |
| `functionjobs` | Whether each scheduled job of a function app ran, failed or is overdue |
| `resourcehealth` | The cloud's own health reports for resources, from the activity log |

The Azure adapter's logins are the Azure CLI by default, or a named `credentials:` entry (`default`, `managed-identity` or `service-principal`, whose secret is read from an environment variable). The core also knows `fake`, and reserves a few kind names for adapters still to come: such a source is reported at start-up and its signals have no data. Several sources can serve one building, each signal from the source `signals:` names. A company writes its own adapter in `extensions/`, starting from `templates/adapter` and testing it with the adapter kit (see [write-an-adapter.md](write-an-adapter.md)).

**Running.**

- A live environment polls its sources only while a browser is watching it, and for two minutes after. `Polling:AlwaysOn` keeps every environment polling.
- Each source polls on its own timer. A failing source goes stale on its own, and one that keeps failing is asked less often until it works again.
- A snapshot is built every 2 seconds (`Snapshot:IntervalSeconds`) and sent to viewers when something in it changed, and at least every 15 seconds (`Snapshot:KeepAliveSeconds`) so the feed shows it is alive.
- One server runs every `config/*/town.yaml` as a town (`?town=`), each with its environments (`?env=`). A town without environment files has one, `demo`.
- The town folder is watched (`Registry:WatchSeconds`). A good reload replaces the registry in use, a failed one keeps the last good registry and says so in the notices. Sources and the town's mode are read at start-up, so changing them needs a restart.
- The page refuses a snapshot it cannot draw and keeps the last good town.

## Registry config in brief

One folder describes a town. Each file and key is in [config-reference.md](config-reference.md), and the order to set them up in is in [connect-your-company.md](connect-your-company.md).

```
config/<town>/
  town.yaml               id, name, groupLabel, topology, mode, islands, ringCapacity, databaseEngines, messaging, labels
  defaults.yaml           thresholds per role
  hub.yaml                shared resources, the hub's topics, outside callers
  third-parties.yaml      vendors, their domains and services
  pillars/<id>.yaml       one island: systems, calls, service groups, messaging, scheduler
  environments/<id>.yaml  what differs per environment: sources, credentials, signals, scope, tenants, exclude, links, logs
  fake.yaml, fake-assets.yaml, stories/   demo towns only
  schema/                 editor schemas, regenerated with `Host -- --write-schema`
  _discovered/            written by the app: found links, added hosts, the last readings
```

- **Ids** are `<pillar>.<system>`, and `aliases` keep old ids working. A system's `role` is required. A key, id, role or engine the loader does not know is an error with a "did you mean".
- **Thresholds cascade** from `defaults.yaml` to the pillar's `defaults` to the system. The inspector's Config tab shows each value and where it came from.
- **Links are declared** (`calls`, `gatewayCalls`, `messaging`) and can be added from dependency data by link discovery (`links:` in an environment file). Buildings, bridges and piers exist only for links and roles that are really there.
- **Scope** in an environment file maps pillars and systems onto the cloud provider with rules and templates: the account each pillar lives in (`account`; an Azure subscription, an AWS account, a GCP project), the telemetry store (`telemetryStore`; on Azure a Log Analytics workspace), which resources belong to a service, and what the telemetry calls a system.

**Staying company-neutral.** Core knows only generic things: islands, systems, links, brokers and vendors. Every naming convention, tag and query is a rule or template in the town's own files, and core assumes none. The two sample towns are shaped differently to prove it: Galactic Credit is hub-and-spoke with two gateways, two brokers (Service Bus and an event-streaming broker), two shared databases, 16 pillars plus Lost & found and topics named `{pillar}-{service}-outbox`; Droid Shop has six teams that call each other directly, Kafka, no gateway, topics named `{service}.events` and non-Azure basic buildings (a secrets store, a config store, a media bucket). Both render with no code changes, and the scope tests run two towns with opposite conventions.

## Rules and why

Why some rules are the way they are, where the reason is not obvious from the code or the other docs. What the app does, and every config key, is in [README.md](../README.md), [config-reference.md](config-reference.md) and [connect-your-company.md](connect-your-company.md). Read this before changing one of these rules.

### Data

- **Health comes from metrics, never from logs or traces.** Companies often sample logs and traces heavily, so a count from them makes the rate and the error share wrong. Adapters read pre-aggregated platform or OpenTelemetry metrics. Traces or dependency data may only help find which systems call which (that a link exists, not how much it is used). Logs are an on-demand view in the drawer and never decide a colour.
- **Missing data is unknown, never healthy.** A metric that is not reported is null, never zero.
- **Errors are 5xx, timeouts and unhandled exceptions.** 4xx are the caller's mistake, not failures. 429 is throttling.
- **A late source leaves out only its own signals.** A building used to go grey when any source that feeds it was late, so one failed broker read blanked every worker that reads queues. Now a late source's signals are left out (listed as absent, so no health rule uses them) while some source of health signals is fresh. The building is grey only when none is. A source that supplies only instance counts or queue numbers cannot keep a building alive, because they do not say how it is doing.

### Links and layout

- **Connectors follow real links only.** A pier exists only for an island that publishes a topic or has a subscribing worker. A bridge to the hub exists only for an island with an API or a call over its coast. Buildings exist only for roles the registry has. The backend works the rule out once and sends the result on every island, so the renderer and the registry checks cannot disagree.
- **Hub and spoke: one bridge per island, so bridges never cross.** Calls between islands go through the hub, and the dependency overlay shows team-to-team links as arcs rather than extra bridges. Beyond one ring the second ring is staggered so its bridges pass between first-ring islands. The limit is readability, not rendering cost.
- **The island filter is in the backend; layers are in the page.** The filter changes what the backend sends and counts (totals, links, third parties). Layers only hide things on the page. A filter of only unknown island ids shows the hub alone, and the unknown ids are reported.
- **An unknown environment name gets no snapshots.** A typo must not land anyone on production.

### Traffic and messaging

- **Cars and boats are a sample, not a count.** More cars means more requests, not an exact number.
- **Known limit: junction standoffs.** Cars never overlap: in a lane a car brakes for the one ahead, and at crossings a car keeps out of older cars' paths. When two cars still wait for each other for over a second and a half, the younger one dissolves from the sample. A reservation scheme at junctions is the proper fix if it becomes noticeable.
- **Boat rates come from what arrives in the queues, not from the broker building's health.** The broker's own building may have no data source (it is watched through its queues), and a building nothing measures is not a stopped one. Only a broker that is Down stops the boats.
- **Messages a second in all counts each hop.** Each queue is counted where it is read, so a message that crosses two queues counts twice, because each hop is work for a service.
- **A queue name is matched to a reader only when it is certain.** A pattern may name only the reader's service; the queue goes to that service if its code belongs to exactly one system of the kind, otherwise it is left out rather than guessed. When the name also says the publisher, the queue becomes a route, so who sends to whom follows the broker, not a list kept in step by hand.
- **A topic's owner is the file that lists it, never read from its name.** A topic is listed by its service (the town's template names it) or by its own name, with the service that publishes it or none, so event names such as `orders.created` and several topics for one service fit. Piers, boats and the old-route check work from that owner.
- **A scheduled job's targets are declared in the pillar file, never read from queue names.** The logs name a job but not what it feeds, and queue names are free-form. An unmapped job sends no boats and says "Job not mapped", so the file can be completed. Scheduler boats are approximate on purpose: runs are not measured as messages.
- **The dead-letter link is a template on the broker source.** The program knows no queue explorer. A system with no code for a word the address needs gets no link instead of a broken one.

### Provider health

- **A report the log never closed still clears** when the resource's current status says Available. It is listed as resolved only if this server listed it open before, so a restart does not invent one.
- **Dismissal is kept in memory.** A restart brings a report back if the cloud still lists it.
- **A round where some reads fail keeps the last good reports for those reads**, with a notice that the list may be incomplete, instead of showing nothing.

### Rules of the Azure adapter

- **A short hiccup in the cloud's metrics API is tried again.** 429, 500, 502, 503, 504 or a dropped connection is tried up to three times a moment apart before the read counts as failed. A refusal (400, 403) fails at once, since trying again will not help.
- **Azure Monitor answers a read split by queue with only 10 series unless asked for more.** A namespace holds hundreds of queues, so queues came and went between polls. The read asks for up to 1000 series.
- **A queue Azure Monitor sends nothing for keeps its place, with no numbers.** Dropping it aged its reader into "late", and 0 is wrong: a quiet queue has no number to show.
- **Resource Health is read from the activity log, not a resource query.** The Resource Graph health table only covers virtual machines, and the CLI's activity log command stops at 50 events, so the server filters by provider itself and follows the pages.

### Databases

- **Engine and type are separate.** The eight types (relational, document, key-value, wide-column, graph, time-series, analytical, vector) are fixed in core, because the renderer may one day draw them differently. The engines are each town's own list, each mapped to one type, so two teams cannot spell one engine two ways.
- **Search, cache and file storage are not database types.** A cache and file storage have their own buildings, and a search index is usually a copy of data kept elsewhere. A multi-model engine belongs to its main type.
- **Test tenants never go past amber,** so they cannot turn a store, its service or the town red.

### Themes

- **A signal reads the same in every theme.** Beacon colours (green, amber, red, grey), floors and dark floors, lit windows, the dead-letter pen, crates, weather, tenant yards and service pads stay the same; only how a building looks changes. A new building kind or health state must be drawn by every theme: both sides' tests read `shared-test-data/themes/theme-contract.json` and fail if a theme falls behind.
- **A model keeps the default theme's footprint, door, door direction and plaque place**, within a tolerance a unit test holds it to, so layout and traffic work unchanged.
- **The theme is chosen once, when the page opens.** Picking another reloads the page, so nothing of the old theme is left behind.
- **Red only ever means something is failing** (errors, throttling past the red threshold, or down). Amber is a warning, grey is no data. A unit test holds the legend to that.

### Performance

- **Fixed scenery and the fixed parts of each building are merged into a few meshes per island.** Parts a model moves (smoke, clock hands, cranes, dishes) are marked `animated` and keep their own meshes, so a new moving part must be marked or it freezes.

## Roadmap

Real sources are added one adapter at a time behind the same town, so the town itself does not change when one arrives. The core is cloud-neutral: the Azure adapter is built, and other clouds, metric stores and brokers come as further adapters.

**Built**

1. **Demo town and themes.** The whole pipeline on the fake source: two sample towns, scenarios, stories, the daily cycle, the inspector, the legend, three themes, quality levels and resilient loading.
2. **Real cloud sources (Azure adapter).** The inventory and scope rules, Log Analytics (requests, errors, latency, regions, the Logs tab), Azure Monitor platform metrics, Service Bus backlog, dead letters and message flows from metrics, function jobs and the scheduler, link discovery and the Unknown hosts panel, and the `--sources` check.
3. **Cloud provider health (Azure Resource Health adapter).** The provider's health reports as a mark on the building, in the drawer, the Incidents list and the dashboard, with Dismiss.
4. **Dashboard and wall mode.** The dashboard view, the wall tour and status strip, the Wall button and the wall dashboard.

**Next**

5. **Incidents and third parties.** An incidents adapter so real incidents drive the weather over the right island (today only the fake source makes weather, and provider health reports go to the Incidents list), and third-party health from our own outbound calls in live towns.
6. **Hosting.** Sign-in, a hosted deployment, and what that needs from polling and security (`Polling:AlwaysOn`, `Security:AllowedOrigins` are already there).

**Later, or ideas**

- Adapters for other metric stores, message brokers and platforms.
- History and replay of the town.
- Hysteresis, so a state that hovers at a threshold does not flicker.
- Deployment crews from CI/CD events.

## Risks and open questions

The biggest risk is the mapping, not the 3D. The same system has different names in the inventory, the telemetry, the broker and the incident tool, and the town's scope rules and templates are what tie them together. A rule that is wrong shows a system as quiet or grey rather than as broken, so `validate --sources`, the Config tab and the notices are the way to find it.

- **Visual noise.** Too many cars and effects hide the signal. Cars and boats are sampled and capped at 420 cars, but without hysteresis a value near a threshold can still make a beacon flicker.
- **False green.** Missing data must render grey, never healthy, and a signal that is not configured must stay absent rather than look measured.
- **Performance on ordinary laptops.** Instanced cars, merged scenery and quality that steps down by itself on slow frames. Bigger towns than the sample (17 islands, about 110 buildings) are tested only in the stress towns.

Open questions:

- [ ] Incidents: how do open incidents map to islands and systems (labels, service tags)?
- [ ] Third parties: which vendors matter most, and are their status pages worth a second signal?
- [ ] Hosting: where it should live, how people sign in, and whether it then needs per-team views beyond the island filter.
- [ ] History and replay: how often to keep a snapshot, where to store it and for how long.
