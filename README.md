# Observability City

A browser app that shows system health as a living, animated 3D town instead of a dashboard. Each pillar (or team) is an island, each system is a building, and what is going on shows in the town itself: floors for instances, lit windows for load, rooftop beacons for errors, cars for traffic.

**Status: Phase 1, slice 1.** The pipeline runs end to end on fake data (backend, live push, browser), and the hub island plus two sample islands (Galactic Credit's "Core Ledger" and "Payments") are built. Everything else is in [plan/](plan/observability-city-plan.md).

## What you need installed

| Tool | Version | Why |
| --- | --- | --- |
| [.NET SDK](https://dotnet.microsoft.com/download/dotnet/8.0) | **8.0** (a newer SDK works too, but the .NET 8 runtime must be installed) | Backend and the Aspire app host |
| [Node.js](https://nodejs.org) | **20 or 22 LTS** (includes npm) | The browser app (Vite) |
| A browser with WebGL | Any current Chrome, Edge, Firefox or Safari | The 3D town |
| Git | Any | To clone |

**You do not need Docker, Docker Desktop, Rancher or any container tool.** Phase 1 uses fake data and keeps no history store, so nothing runs in a container. The .NET Aspire dashboard that opens with the app runs as a normal process.

Check what you have:

```
dotnet --list-sdks     # should include 8.0.x
node --version         # v20 or v22
```

## Run it

```
git clone https://github.com/dcarles/ObservabilityCity.git
cd ObservabilityCity
cd web && npm install && cd ..
dotnet run --project src/ObservabilityCity.AppHost
```

The first run downloads NuGet packages, so give it a minute. When it is up:

- **The town:** http://localhost:5173
- **Aspire dashboard** (logs, traces, resource status): http://localhost:15180

In Visual Studio or Rider you can instead set `ObservabilityCity.AppHost` as the startup project and press F5.

### Without Aspire

Two terminals, if you prefer:

```
dotnet run --project src/ObservabilityCity.Host     # backend on http://localhost:5080
cd web && npm run dev                               # town on http://localhost:5173
```

The browser app proxies `/api` and `/hubs` to the backend, so there is nothing to configure.

## Try it

Hover a building for its numbers. Drag to orbit, scroll to zoom, right-drag to pan, **Home** frames the town.

The **Try it** panel (temporary in this slice) pokes the fake data source: pick a target (the whole town, an island or one building), then press Traffic spike, Slow, Errors, Sick instances, High CPU, High memory, DB saturated, Queue backs up, Dead letters or Down. Effects stack, and each shows as a chip you can click to clear. **Calm** freezes the noise and the daily cycle.

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
| Bridges | One road bridge from the hub's plaza to each island's gate. All sync traffic between islands goes through the hub |
| Harbour with crates and a crane | The island's port, where messaging boats dock. Messages waiting pile up as crates on the quay with a "waiting N, oldest" sign. Dead letters sit in a pen of broken crates with a "DLQ N" badge and a sweeping red light. The hub shows the DLQ total |
| Boats between hub quays and island harbours | Asynchronous messaging. Busier queues send more boats, smaller than before, and the crates on a boat show how loaded it is. Bridges are synchronous calls, boats are asynchronous ones. Boats sail only on open water: each island has a quay on the hub in the water gap beside its bridge, and lanes are found around land and bridges |
| "Closed for repairs" sign and a blackout | The system is down |
| Grey building | No fresh data. Never shown as healthy |

## How it fits together

```
samples/galactic-credit/   registry (YAML): town, defaults, hub, pillars, fake-data baselines
src/ObservabilityCity.Contracts    Snapshot records: the source of truth for the wire format
src/ObservabilityCity.Core         registry loader, source interface, snapshot builder and rules
src/ObservabilityCity.Adapters.Fake  the fake source: noise, daily cycle, autoscaling, scenario effects
src/ObservabilityCity.Host         ASP.NET Core: /api/snapshot/latest, SignalR hub /hubs/town, /api/fake
src/ObservabilityCity.AppHost      .NET Aspire: starts the host and the web app together
web/                               Vite + TypeScript + three.js browser app
contracts/openapi.json             generated from the C# records
tests/                             xunit tests and golden snapshot fixtures
```

Data flows one way: a source writes readings, the snapshot builder joins them with the registry and applies the rules (stale is never green, down beats degraded), and one snapshot is pushed over SignalR every two seconds. The browser invents all motion from the numbers in the snapshot. It never knows which source produced them, so real adapters later replace the fake one without touching the town.

### The contract

`contracts/openapi.json` and `web/src/contracts.ts` are generated from the C# `Snapshot` records. After changing a record:

```
cd web && npm run gen:contracts
```

CI runs `npm run check:contracts` and fails if the generated files are out of date, so the two sides cannot drift.

### Tests

```
dotnet test                       # registry, rules, fake source, golden snapshot fixture
cd web && npm test                # visual rules, plus the same golden fixture on the TypeScript side
```

To refresh the golden fixture after an intended change: `UPDATE_GOLDEN=1 dotnet test`.

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `Registry:Path` | `samples/galactic-credit` | Folder with the registry YAML files |
| `Fake:DayLengthSeconds` | `120` | Real seconds per simulated day |
| `Snapshot:IntervalSeconds` | `2` | How often a snapshot is pushed |

Set them with environment variables (`Registry__Path=...`) or in `appsettings.json` of the Host project.

## Using it at your own organisation

The core knows only generic concepts (groups, systems, resources, links). Everything specific to an organisation is configuration: copy `samples/` into your own `config/` folder, point `Registry:Path` at it, and add company-only adapters under `extensions/`. Never edit the core files, so `git pull upstream` stays clean. Details are in the [plan](plan/observability-city-plan.md).

## Assets and licences

The harbour-town theme uses roads, cars and street props from the CC0 [KayKit City Builder Bits](https://kaylousberg.itch.io/city-builder-bits) pack by Kay Lousberg (only the files in use, with the pack's licence beside them in `web/public/themes/harbour-town/kaykit/`). The buildings themselves are built from code in the same style. More free CC0 kits can be added through the theme system. Commercial model packs belong in a private fork and are git-ignored (`themes-private/`).
