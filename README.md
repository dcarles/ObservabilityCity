# Observability City

A browser app that shows system health as a living, animated 3D town instead of a dashboard. Each pillar (or team) is an island, each system is a building, and what is going on shows in the town itself: floors for instances, lit windows for load, rooftop beacons for errors, cars for traffic.

**Status: Phase 1, slice 3.5.** The pipeline runs end to end on fake data (backend, live push, browser), and the whole sample town is built: the hub, 16 pillar islands and a Lost & found island, with messaging between them. Everything else is in [docs/](docs/observability-city-plan.md).

## What you need installed

| Tool | Version | Why |
| --- | --- | --- |
| [.NET SDK](https://dotnet.microsoft.com/download/dotnet/10.0) | **10.0** (LTS; the .NET 10 SDK includes the runtime) | Backend and the Aspire app host |
| [Node.js](https://nodejs.org) | **24 LTS** (includes npm) | The browser app (Vite) |
| A browser with WebGL | Any current Chrome, Edge, Firefox or Safari | The 3D town |
| Git | Any | To clone |

**You do not need Docker, Docker Desktop, Rancher or any container tool.** Phase 1 uses fake data and keeps no history store, so nothing runs in a container. The .NET Aspire dashboard that opens with the app runs as a normal process.

On Windows: `winget install Microsoft.DotNet.SDK.10` and `winget install OpenJS.NodeJS.LTS`, then open a new terminal.

Check what you have:

```
dotnet --list-sdks     # should include 10.0.x
node --version         # v24
```

## Run it

```
git clone https://github.com/dcarles/ObservabilityCity.git
cd ObservabilityCity
cd frontend && npm install && cd ..   # once, and again after pulling dependency changes
dotnet run --project backend/src/ObservabilityCity.AppHost
```

The first run downloads NuGet packages, so give it a minute. Stop it with Ctrl+C. When it is up:

- **The town:** http://localhost:5173
- **Aspire dashboard** (logs, traces, resource status): http://localhost:15180

In Visual Studio or Rider you can instead set `ObservabilityCity.AppHost` as the startup project and press F5.

### Without Aspire

Two terminals, if you prefer:

```
dotnet run --project backend/src/ObservabilityCity.Host     # backend on http://localhost:5080
cd frontend && npm run dev                                  # town on http://localhost:5173
```

The browser app proxies `/api` and `/hubs` to the backend, so there is nothing to configure.

## Try it

Hover a building for its numbers. Drag to orbit, scroll to zoom, right-drag to pan, **Home** frames the whole town. Click a building, or pick one in the search box (press `/` to focus it), and the camera glides to it and keeps its name board readable. Search also finds islands. Any drag cancels a glide.

The **Try it** panel (temporary in this slice) pokes the fake data source: pick a target (the whole town, an island or one building), then press Traffic spike, Slow, Errors, Sick instances, High CPU, High memory, DB saturated, Queue backs up, Dead letters, Down, or an Incident (Sev 1 to 4, which brings weather over the island). Pick a third party as the target to take a vendor offline or slow. Effects stack, and each shows as a chip you can click to clear. **Calm** freezes the noise and the daily cycle.

### Demo trouble from a script

Until the Break things panel exists, `scripts/trouble.ps1` pokes the fake source with ready-made trouble (PowerShell 5.1 or 7, backend running on http://localhost:5080):

```
./scripts/trouble.ps1 list                  # the presets
./scripts/trouble.ps1 high-cpu dlq-buildup  # presets stack
./scripts/trouble.ps1 bad-day               # errors, slowness, dead letters and a throttled DB across Payments and Core Ledger
./scripts/trouble.ps1 pier-backlog pier-dlq # a backlog and dead letters on the worker-only pillar's pier; the hub lighthouse lights up
./scripts/trouble.ps1 legacy-dlq            # dead letters on the legacy egress reader in Lost & found
./scripts/trouble.ps1 rain vendor-down      # incident weather over Payments, a third party offline
./scripts/trouble.ps1 raw cl.ledger-api Errors 0.5
./scripts/trouble.ps1 reset                 # back to a calm baseline
```

`scripts/trouble.http` has the same calls for VS Code, Visual Studio or Rider. Both use real Galactic Credit ids, so they only fit that town; edit the targets for another.

How to read the town, as built so far:

| You see | It means |
| --- | --- |
| Number of floors | Instance count on a doubling scale (1, 2, 3-4, 5-8 ... 65+ gives 1 to 8 floors) |
| Lit windows | Lights switch on floor by floor from the ground up. Apps and workers: CPU. Databases: share of provisioned capacity used (for example Cosmos RU %) |
| Dark, cracked floors and an amber plaque | Unhealthy instances ("5/10 healthy") |
| Rooftop beacon: green, amber, red (red pulses) | Errors, throttling or resource pressure against the system's own thresholds. Amber is a warning (including high CPU, memory or database utilisation), red means errors or throttled requests |
| Factory (workers) and storage units (databases) | Workers are yellow-brick factories with a FACTORY sign and roof chimneys, databases are storage buildings with a STORAGE sign, both next to the API office. Chimney smoke thickens as CPU climbs. Storage doors light up with database utilisation |
| Meter bars on the name board | Apps and workers show CPU and memory. Databases show utilisation (for example Cosmos RU %) and the share of throttled requests. An ERR bar shows the failure share (5xx, timeouts and unhandled exceptions; 4xx are not failures and 429 counts as throttling) and a line shows p99 against the SLA. Workers also show queue depth and oldest message, and dead letters. Each bar turns amber then red against its thresholds |
| Lowered barrier gate at a database | Requests are being throttled |
| Cars on the streets | Requests, drawn as a sample, not a count (at 200 requests a second only a few cars are shown, so more cars means more requests, not an exact number). Blue sedans are internal calls, yellow taxis external ones, all the same size. Cars never touch: in a lane each brakes for the car ahead, and at crossings a car keeps out of any older car's path |
| Service lane beside a building, with cars waiting | Each building has a lane that holds five cars (three beside the spine, where it is shorter). Time at the door is the latency, so a slow system builds a queue. Over the SLA the queued cars blink amber hazard lights, a "!" bubble honks over the lane and the name board shows p99 against the SLA. When the lane is full no more cars appear for that building, so nothing turns round and the road stays clear. A "+N waiting" marker then shows the requests in flight (request rate times about half of p99) that the lane has no room to draw. A served car drives into the building |
| Car with a red flag on its roof | A failed request. It is turned away at the door and drives back the way it came. Its colour stays blue or yellow. This is the only time a car turns round |
| Cars between buildings on one island | Calls between systems of the same pillar. A car runs only along a link declared in the pillar file (`calls: [pillar.system, ...]`). A callee's rate is shared evenly among its declared callers until a source reports each link's own rate, and a system with no declared caller sees no such traffic |
| API, worker and database side by side | One service. Systems that share a `service` in the registry stand next to each other on one pad, with their fronts toward the road. Pads sit on a grid, so every building's front is visible from the road side |
| Name board above a building | System name and "N/M healthy". Fades out when the camera is far away, except for troubled buildings |
| Bridges | One road bridge from the hub's plaza to an island's gate, for an island that has an API or a call link over its coast (to a hub database or cache, through the gateway, or into it from another island). All sync traffic between islands goes through the hub. An island with neither has no bridge, and no car drives to it |
| Islands on a ring round the hub, a few further out | Pillars, in the order of `layout.yaml`. `ringCapacity` (default 12, 6 to 18) fit on the first ring, the rest stand in a staggered second ring with their bridges passing between first-ring islands. Two rings only, so at most (ringCapacity x 2) - 1 pillars. The airport takes the second ring's north slot. A ring road circles the town, with third-party vendors outside it. The hub grows with the number of islands |
| Island with a heap of boxes and bins by the gate | Lost & found: systems that carry no pillar tag and no `pillar.code` |
| Pier with crates, only on an island with messaging | Where messaging boats dock, for an island that publishes a topic or has a worker that subscribes to one. The board reads PIER, the topics it publishes and the subscriptions it reads. Messages waiting pile up as crates on the quay with a "waiting N, oldest" sign. Dead letters sit in a pen of broken crates with a "DLQ N" badge and a sweeping red light. An amber pennant on the pier means a worker still reads the hub's egress topic (the old route) |
| Service Bus port and lighthouse on the hub | The port's sign counts the town's topics, subscriptions and piers. The lighthouse beside it sweeps a red light while any dead-letter queue is not empty, and its board and the top bar show the town-wide DLQ total |
| Boats between hub quays and piers | Asynchronous messaging, to piers only. Busier queues send more boats, smaller than before, and the crates on a boat show how loaded it is. Bridges are synchronous calls, boats are asynchronous ones. Boats sail only on open water: each island has a quay on the hub in the water gap beside its bridge, and lanes are found around land and bridges |
| "Closed for repairs" sign and a blackout | The system is down |
| Grey building | No fresh data. Never shown as healthy |

## How it fits together

```
backend/                           .NET solution (ObservabilityCity.slnx)
  src/ObservabilityCity.Contracts    Snapshot records: the source of truth for the wire format
  src/ObservabilityCity.Core         registry loader, source interface, snapshot builder and rules
  src/ObservabilityCity.Adapters.Fake  the fake source: noise, daily cycle, autoscaling, scenario effects
  src/ObservabilityCity.Host         ASP.NET Core: /api/snapshot/latest, SignalR hub /hubs/town, /api/fake
  src/ObservabilityCity.AppHost      .NET Aspire: starts the host and the frontend together
  tests/ObservabilityCity.Tests      xunit v3 tests (Microsoft Testing Platform)
  tools/ObservabilityCity.Validate   registry checker
frontend/                          Vite + TypeScript + three.js browser app
  src/                               app code
  tests/unit/                        Vitest unit tests
  tests/e2e/                         Playwright browser tests
config/galactic-credit/            registry (YAML): town, defaults, hub, layout, pillars, schemas, fake-data baselines
contracts/openapi.json             generated from the C# records
shared-test-data/                  fixtures used by both sides: registries, golden snapshots, layout golden
docs/                              plan, decision log, previews
```

Data flows one way: a source writes readings, the snapshot builder joins them with the registry and applies the rules (stale is never green, down beats degraded), and one snapshot is pushed over SignalR every two seconds. The browser invents all motion from the numbers in the snapshot. It never knows which source produced them, so real adapters later replace the fake one without touching the town.

### The contract

`contracts/openapi.json` and `frontend/src/contracts.ts` are generated from the C# `Snapshot` records. After changing a record:

```
cd frontend && npm run gen:contracts
```

CI runs `npm run check:contracts` and fails if the generated files are out of date, so the two sides cannot drift.

### Tests

```
dotnet test --solution backend/ObservabilityCity.slnx  # registry, resilient loading, validator, rules, fake source, 23- and 35-island backend load, golden fixtures
cd frontend && npm test          # visual rules, snapshot guard, island layout (including 24 uneven islands), golden fixtures
cd frontend && npm run e2e       # browser scenarios on a small town (break things, check the town, calm it down), then the link rules on a town with an island for each case, then the environment, tenant and service rules (about 3 minutes)
cd frontend && npm run e2e:links # the link rules alone: pier, bridge and buildings follow real links
cd frontend && npm run e2e:tenants # environments, tenant yards, tenant traffic and service groups, on a town with three environments
cd frontend && npm run e2e:slow  # 23- and 35-island stress towns and the full sample town, with screenshots (a few minutes)
dotnet run --project backend/tools/ObservabilityCity.Validate -- --all   # check every registry folder in the repo
```

To refresh the golden fixtures (calm town, a bad day across several islands, and the editor schemas) after an intended change: `UPDATE_GOLDEN=1 dotnet test --solution backend/ObservabilityCity.slnx`. The island layout golden is refreshed with `cd frontend && UPDATE_GOLDEN=1 npm test`.

**Browser tests** (`frontend/tests/e2e/`, Playwright) start the real backend with the fake source and the real page, steer the fake source through `/api/fake/effects`, and read the scene's state through `window.city` (beacon colour, dark floors, closed sign, queue warning, crates, dead-letter light) instead of pixels. With `?test=1` the page draws nothing on its own and time moves only when a test calls `city.step(seconds)`, so tests do not depend on a GPU. The first run needs the browser: `cd frontend && npx playwright install chromium` (once, and again when the Playwright version changes). Set `E2E_NO_BUILD=1` once the backend is built in Release.

**Registry checks** (`backend/tools/ObservabilityCity.Validate`) go beyond what loading needs. Errors fail CI, warnings are listed and do not:

| Rule | Severity |
| --- | --- |
| Format, ids, roles, calls and layout entries that point nowhere, aliases | error |
| Every pillar has a `layout.yaml` entry (Lost & found excepted) | error |
| In a hub-and-spoke town, a pillar does not call another pillar directly; it goes through the hub | error |
| Outside callers reach only systems marked `external` | error |
| Thresholds make sense: ranges, and amber below red, also after the defaults are applied | error |
| Colours are hex, pillars have a display name, the hub has one gateway, broker, egress and database at most | error |
| `fake.yaml` names real systems and its numbers make sense | error |
| A worker has a database, a system has a caller, no `layout.yaml`, an empty pillar, an island that stands alone (no API, messaging or call links) | warning |
| Messaging: topics are services of the pillar, subscriptions name an existing topic and a worker of the same pillar, no duplicates, `legacy` exactly for the hub's egress topic | error |

On a pull request the check writes annotations on the files and posts one comment listing every finding with file and line (the same comment is updated on each push).

**A broken pillar file does not stop the town.** The running app skips a pillar file with problems and draws its island as a *config error* island (a board saying what is wrong), drops call links that point nowhere, and lists everything it worked around in a small panel under the top bar. The registry folder is watched: a reload that fails keeps the last good registry and says so in the panel. If `town.yaml`, `defaults.yaml`, `hub.yaml` or `layout.yaml` is unreadable at start-up the app does not start, since there is nothing to show. The page also refuses a snapshot it cannot draw and keeps the last good town.

**Pull request checks.** `.github/workflows/ci.yml` runs four jobs side by side (backend tests, frontend tests and build, UI scenarios, registry checks) and a final job called `PR checks` that passes only when all of them did. `.github/workflows/slow.yml` runs the stress town and the full sample town on merge to main and every night.

To make it required on `main`: GitHub, Settings, Branches, Add branch protection rule (or Rulesets, New branch ruleset), branch name pattern `main`, tick *Require a pull request before merging* and *Require status checks to pass before merging*, search for and add **PR checks**, save. Run CI once first, or the check name will not be offered in the search.

### The registry

One folder describes a town. The sample is `config/galactic-credit/`:

| File | What it holds |
| --- | --- |
| `town.yaml` | Name, what an island is called, topology |
| `defaults.yaml` | App-wide defaults per role (SLA, error, resource, throttle and backlog thresholds) |
| `hub.yaml` | The hub's shared resources (gateway, broker, egress, database), its `messaging` topics (`egress`), and the outside callers (`externalCallers`, each lists the external systems it reaches) |
| `layout.yaml` | The order of the islands round the hub. Unlisted pillars follow, Lost & found is always last |
| `pillars/<code>.yaml` | One island: its systems, `calls` links, per-role `defaults`, and its `messaging` (topics it publishes, topics its workers consume) |
| `pillars/lost-found.yaml` | The island for systems nobody owns |
| `environments/<id>.yaml` | One file per environment (`dev`, `staging`, `prod`): its tenants, its sources and what it leaves out. Optional: a town without them has one environment, `demo` |
| `fake.yaml` | Baseline numbers for the fake source only |

Settings cascade: system, then the pillar's `defaults`, then `defaults.yaml`, then built-in values.

**Messaging and links.** Connectors follow real links only, and the registry is where the links are declared:

```yaml
messaging:
  topics: [payments, refunds]              # publishes pay-payments-outbox and pay-refunds-outbox
  subscriptions:                           # a worker of this pillar reads a topic
    - { topic: frd-screening-outbox, consumer: pay.payments-worker }   # another pillar's outbox, directly
    - { topic: hub-egress, consumer: pay.refunds-worker, legacy: true } # the old route, flagged
```

| Island has | Gets |
| --- | --- |
| A topic, or a worker with a subscription | A pier, its board, and boats from the Service Bus port. Only a subscribing worker has a queue and a dead-letter queue |
| An API, or a call link over its coast (a call to a hub database or cache, `gatewayCalls`, or a call into it) | A bridge to the hub, and cars |
| Neither | Nothing connects it: it stands alone and the registry warns about it |
| No database, or no worker | No storage unit, or no factory: buildings exist only for roles the island has |

Reading the hub's egress topic from a pillar must say `legacy: true`; the egress topic is otherwise for external destinations such as Snowflake, which are third-party calls.

The loader checks everything and reports all problems at once, each with its file name. Ids must be `pillar.system` (the prefix matches the file, lowercase kebab-case, unique in the town). A misspelt key, role, call target or layout entry gets a suggestion, for example `'aa.ledger-api' calls 'aa.ledger-dbb', which is not in this town. Did you mean 'aa.ledger-db'?`. When a system is renamed, keep its old id under `aliases: [old.id]` and files that still use it keep working.

**Editor help.** Each YAML file starts with a `# yaml-language-server: $schema=...` line, so an editor with the YAML extension (VS Code: Red Hat YAML) completes keys and roles and checks them as you type. `calls` and `layout.yaml` complete from the town's real ids, which live in `schema/system-ids.schema.json`. After adding systems, refresh it:

```
dotnet run --project backend/src/ObservabilityCity.Host -- --write-schema
```

A test fails if the committed schema files are out of date.

**Environments, tenants and services.** Pillar and system files are shared by every environment; an environment file only says what differs:

```yaml
# environments/staging.yaml
name: Staging
order: 2                                  # position in the picker
default: false                            # exactly one environment is the default (shown when the address has no ?env=)
sources:                                  # which source feeds each signal; only the fake source exists today
  metrics: { kind: fake }
  incidents: { kind: fake }
exclude: [lost-found.batch-gateway-api]   # systems that do not exist here, with the calls and links that hang on them
tenants:
  - { id: acme-bank, name: Acme Bank, kind: customer }
  - { id: smoke-stg, name: Smoke, kind: test }
fake: { undeclaredTenants: [zeta-trading] }   # fake source only: a tenant that shows up in the readings without being listed
```

- One backend serves every environment, each with its own snapshot stream. The page asks for one with `?env=staging` (nothing asked gets the default; a name that does not exist shows an empty town and a note, never another environment). The environment name in the top bar is a dropdown of every environment; picking one reloads the page for it. The fake-source calls take `?env=` too.
- A database with `tenantPattern: "merchant-{tenant}-db"` has a database for each tenant. It is drawn as a storage yard with a unit for each tenant (height is how much of its capacity it uses, colour is its state) and a sign, "N tenants, M throttled". A tenant found in the readings but not on the list is a purple unit marked "?". Test tenants are paler and striped, and their trouble is amber at worst: it never turns the store or its service red. The store itself shows the worst of its customers.
- Cars carry the tenant their request is for. The tenant dropdown in the top bar lists tenants by display name with the id beside it, in groups (customers, test tenants, unknown ones), with a search box (name or id), a tick box for each tenant and a dot on any tenant in trouble. Tick one or more to follow them: the other units dim and only their cars are drawn. *Hide test tenants* is a switch in the same list.
- A service is the systems that share a `service:` name, on one pad wherever they stand in the file (more than three take more pads). A low sign in front of the pad names it and shows its worst state; click the sign or the hedge to open the service's panel. A system with no service stands on a pad of its own. The validator warns when one service is split across pillars.

### Performance

The sample town has 17 islands, about 110 buildings and up to 420 cars. Roads, lamps, props, bridges and quays are merged into a few meshes per island (about 4,700 draw calls instead of 8,900). If a frame takes more than 33 ms on average, quality steps down by itself, once per step and never back up: first shadows refresh a few times a second and at a lower resolution, then they turn off, and a note says so. Add `?quality=high` (or `medium`, `low`) to the address to pin a level and turn the automatic step off.

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `Registry:Path` | `config/galactic-credit` | Folder with the registry YAML files |
| `Fake:DayLengthSeconds` | `120` | Real seconds per simulated day |
| `Snapshot:IntervalSeconds` | `2` | How often a snapshot is pushed |
| `Snapshot:StaleAfterSeconds` | `30` | Readings older than this are shown as stale |
| `Registry:WatchSeconds` | `5` | How often the registry folder is checked for changes (0 turns reloading off) |

Set them with environment variables (`Registry__Path=...`) or in `appsettings.json` of the Host project.

## Using it at your own organisation

The core knows only generic concepts (groups, systems, resources, links). Everything specific to an organisation is configuration: add your own town folder next to the sample in `config/`, point `Registry:Path` at it, and add company-only adapters under `extensions/`. Never edit the core files, so `git pull upstream` stays clean. Details are in the [plan](docs/observability-city-plan.md).

## Assets and licences

The harbour-town theme uses roads, cars and street props from the CC0 [KayKit City Builder Bits](https://kaylousberg.itch.io/city-builder-bits) pack by Kay Lousberg (only the files in use, with the pack's licence beside them in `frontend/public/themes/harbour-town/kaykit/`). The buildings themselves are built from code in the same style. More free CC0 kits can be added through the theme system. Commercial model packs belong in a private fork and are git-ignored (`themes-private/`).
