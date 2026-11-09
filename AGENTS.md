# Instructions for coding agents

Observability City shows system health as a living 3D town in the browser. This file is for AI coding assistants (GitHub Copilot and others) and for people who want the short version. [README.md](README.md) has the full tour and [docs/connect-your-company.md](docs/connect-your-company.md) is the runbook for connecting a real environment.

## The rules that matter most

1. **In a company copy, never edit core, and never put company files in a public repository.** A GitHub fork of a public repo is always public, so a company keeps its town folder outside the clone (`Registry:Towns`), in its own private repo, or uses a private mirror of this repo (see the runbook). A company copy adds only its town folder and `extensions/`. Everything else (`backend/`, `frontend/`, `config/galactic-credit`, `config/droid-shop`, `shared-test-data/`, `contracts/`, `.github/`) is upstream. A change that is generic goes back upstream as a pull request (see the runbook); a rule that exists only at one company lives in that company's `config/` or `extensions/`.
2. **Every rule and behaviour is proven by tests on both sides**: .NET tests for the backend, and Vitest plus Playwright for the browser. A change that touches only one side says so in the pull request.
3. **Branches and pull requests.** Work on a branch, open a pull request, never push to `main`, never force-push `main`.
4. **No secrets, tenant ids, subscription ids, hostnames or company names in the repo.** Credentials come from the Azure login (`az login`), user secrets or Key Vault. Examples in docs and tests use generic names (`sb-example.servicebus.windows.net`, `prom.example.test`).
5. **Live data only.** The renderer never knows which source produced a number. Sources fill `NodeReading`s; the snapshot builder applies the rules; the browser invents all motion from the snapshot.
6. **A signal that is not configured is absent, not grey.** Grey means "configured but no fresh data". Never show stale or missing data as healthy.
7. **No new third-party library, package, tool or GitHub Action without the maintainer's explicit approval first.** That covers runtime, dev and test dependencies, and anything not from Microsoft, GitHub or three.js. If a change seems to need one, stop and ask: what it is, who owns it, its licence, and why built-in or in-house code will not do. Version bumps of packages already in use are fine.

## Architecture in one minute

```
source (fake now, Prometheus / Log Analytics / Service Bus / Grafana IRM later)
   -> LatestState -> SnapshotBuilder (rules) -> SnapshotPublisher -> SignalR /hubs/town and /api/snapshot/latest
   -> browser (three.js) draws the town from the snapshot
```

| Folder | What it is |
| --- | --- |
| `backend/src/ObservabilityCity.Contracts` | Snapshot records: the wire format. Source of truth for the TypeScript types |
| `backend/src/ObservabilityCity.Core` | Registry loader and schema, source interfaces (`IMetricSource`, `IIncidentSource`, `ILogSource`), `SourcePoller`, `SnapshotBuilder` and the health rules |
| `backend/src/ObservabilityCity.Adapters.Azure` | the azure adapter module (`IAdapterModule`): Azure source kinds and logins (`az login`, managed identity, service principal), and the `resourcegraph` inventory source that fills the scope (see **Scope** below). The host does not reference it: the build copies it to `adapters/azure/` and the host loads it |
| `backend/src/ObservabilityCity.AdapterKit` | Test kit for adapter authors: canned HTTP, a fixed login, a private town copy and the contract checks every adapter passes. Depends on no test framework |
| `templates/adapter` | A working adapter to copy into `extensions/`. Built and tested with the solution, never copied to `adapters/` |
| `backend/src/ObservabilityCity.Adapters.Fake` | The fake source: noise, daily cycle, autoscaling, scenarios and stories |
| `backend/src/ObservabilityCity.Host` | ASP.NET Core host: one runtime per town and environment, REST, SignalR |
| `backend/src/ObservabilityCity.AppHost` | .NET Aspire app host that starts backend and frontend together |
| `backend/tools/ObservabilityCity.Validate` | The registry checker and `--sources` connectivity check |
| `backend/tests/ObservabilityCity.Tests` | xUnit v3 tests |
| `frontend/` | Vite + TypeScript + three.js. `src/`, `tests/unit` (Vitest), `tests/e2e` (Playwright) |
| `config/<town>/` | One registry per town (YAML) |
| `shared-test-data/` | Registries, golden snapshots and layout golden used by both sides |
| `contracts/openapi.json` | Generated from the C# records |

## Two views of the same data

The page opens as the 3D town or as a plain dashboard (`?view=dashboard`, remembered per browser, switch in the menu). Both read the same snapshot and live feed. `frontend/src/main.ts` only picks a view and loads it, so the dashboard (`frontend/src/dashboard/`) never loads three.js. The dashboard's rules live in `dashboard/model.ts` as pure functions; its markup in `dashboard/render.ts`. The "why is it amber or red" line comes from the backend (`NodeSnapshot.Reason`, built in `HealthReasons.cs` from the same thresholds that set the state). Pillar choice (`?islands=`), environment and tenant filter are shared by both views.

The dashboard's service table has one line per service: traffic (with the share per region for a service in two or more regions), errors (green at 0, red above), p99 latency coloured against the service's SLA (green under it, amber from 90% of it, red over it), CPU and memory as one bar for each region, and two buttons: the callers and calls (opened under the row) and the detail drawer. Queues are never shown in the table; they stay in the drawer. The summary also has a Message flow tile (`dashboard/flows.ts`): the busiest pillars by what each sends to the others and receives from them in msg/s, read by the backend from the broker's topic totals chosen by the `flows` patterns in the Service Bus source config (never pairs: the broker cannot tell the sender of a message), with bars scaled to the busiest pillar and the averaging window taken from the snapshot, never hardcoded; the tile also shows one platform total in msg/s (the town top bar's number) and each pillar can show a third number, `sends int`, the sum of the queues its services read from each other (the same rate as the town's boats inside an island); a pillar's card shows `sends ext · sends int · receives` when it moves messages and its open card each side, also zeros. The Total traffic card lists the busiest pillars in rps. The summary cards share one row on a wide screen (the dashboard is 1600px wide at most) and wrap below that. In the town the same numbers set the boats on one lane out and one lane in per island beside its bridge to the hub (towns with no flows keep the old lanes between islands). A database row shows the worst tenant's %RU with that same tenant's provisioned throughput. The column titles stay under the menu and leave with the pillar's last service row (`dashboard/sticky.ts`; the table must never scroll sideways or sticky stops working, so narrow screens drop columns instead). `body.dash` must not set `overflow` itself: the page scrolls on `html`, or the menu stops sticking.

## Run and test

Needs .NET SDK 10 and Node 26. No Docker.

```
dotnet run --project backend/src/ObservabilityCity.AppHost          # town on http://localhost:5173
dotnet build backend/ObservabilityCity.slnx -c Release
dotnet test --solution backend/ObservabilityCity.slnx -c Release    # backend tests
cd frontend && npm ci
cd frontend && npm run typecheck && npm test                        # frontend unit tests
cd frontend && npx playwright install chromium                      # once
cd frontend && npm run e2e                                          # Playwright (about 3 minutes); E2E_NO_BUILD=1 once the host is built in Release
cd frontend && npm run gen:contracts                                # after changing a C# snapshot record; CI runs check:contracts
dotnet run --project backend/tools/ObservabilityCity.Validate -- --all   # registry checks
```

Golden fixtures refresh with `UPDATE_GOLDEN=1 dotnet test --solution backend/ObservabilityCity.slnx` and `cd frontend && UPDATE_GOLDEN=1 npm test`.

## The registry (config)

One folder per town under `config/`; every folder with a `town.yaml` is a town and gets the town switcher with no setting.

```
config/<company>/
  town.yaml          id, name, groupLabel, topology (hub-and-spoke | direct), islands (their order), ringCapacity, databaseEngines
  defaults.yaml      thresholds that every pillar and system inherits
  hub.yaml           shared resources: gateway, message broker, egress, shared databases
  third-parties.yaml outside vendors
  pillars/<id>.yaml  one island per pillar: its systems, calls and messaging
  environments/<id>.yaml  what differs per environment: sources, tenants, excluded systems
  fake.yaml          baseline numbers for the fake source only
  stories/*.yaml     scripted timelines
  schema/            editor schemas (regenerated, do not edit)
```

**Cascade:** `defaults.yaml` -> pillar `defaults` -> system. The most specific wins. System ids are `pillar.system`. Pillar and system files are shared by every environment; an environment file only says what is different (sources, tenants, `exclude`).

**Sources** are set per environment, per signal (`metrics`, `incidents`, `messaging`):

```yaml
sources:
  metrics: { kind: prometheus, connection: "https://prom.example.test" }
  incidents: { kind: grafana-irm, connection: "https://grafana.example.test" }
  messaging: { kind: servicebus, connection: "sb-example.servicebus.windows.net" }
```

A signal with no source is absent from the town (not grey: grey is a configured source with no fresh data). Source names are free (`metrics`, `messaging`, `incidents` are the defaults); `signals:` in an environment, a pillar or a system points a signal at a named source or at `none`. Kinds: `fake`, `resourcegraph`, `loganalytics`, `azuremonitor`, `servicebus`, `prometheus`, `grafana-irm`. Azure sources sign in with `az login` unless a `credentials:` entry says otherwise; a secret is never in a file, only the name of the variable that holds it. Real adapters arrive phase by phase (see the plan); a kind with no adapter yet is accepted, reported at start-up, and shows no data. The demo town's fake source fills every signal.

**Scope** (`scope:` in an environment file) says how pillars and systems map onto the cloud: a pillar's subscription (by a name pattern, a tag or an id), the workspace, which resources belong to a service (a regular expression over names with `service`, `role`, `region` and `tenant` groups), and what the telemetry calls a system (`telemetry.role` on a system, or a `telemetryRole` template). Every convention is a rule or template with `{variables}`; core assumes none, and a test runs two towns with opposite conventions (`shared-test-data/registries/scope-town-a` and `-b`) to prove it. `ScopeResolver` is pure; the `resourcegraph` source fills a `ScopeStore` with the inventory it read, which later adapters ask where a system lives, and reports each system's instance count for the `instances` signal (a resource rule's `instances:` expression; the sum over a system's resources) so building floors come from it. Several sources can serve one node: `LatestState` keeps each source's reading apart, `ReadingMerge` takes each signal from the source `signals:` names for it, and a building is grey when any source it reads is stale (a slow source is fresh for twice its poll interval). The workspace is a name the inventory looks up or an id used as it is (the id wins). The `azuremonitor` source reads platform metrics (CPU, memory, capacity used, throttling) for the resources the scope finds, from `metrics:` entries in the environment file; it knows no metric name. The inspector's Config tab shows the result. The runbook has the details.

Edit YAML with the schemas in `schema/` for completion. `dotnet run --project backend/tools/ObservabilityCity.Validate -- --all` must stay clean.

## Extension points

- **A new source adapter**: start from `templates/adapter`, follow [docs/write-an-adapter.md](docs/write-an-adapter.md) and test it with the kit in `backend/src/ObservabilityCity.AdapterKit` (`CannedHttp`, `StaticLogin`, `TownFiles`, `AdapterContract`). In short: add it to a module (`IAdapterModule.Register`: `AddSourceKind`, `AddSource` for its `IMetricSourceFactory`, `AddCredentialKind` for a login) and implement `IMetricSource` (and `IIncidentSource` / `ILogSource` when it has them) in a new project under `extensions/<company>.<name>/` in a fork (the build copies every such project to `adapters/<name>/`, and the host loads it; no host code changes), or under `backend/src/ObservabilityCity.Adapters.<Name>` upstream when it is generic. Build it against recorded fixtures kept in `shared-test-data/`, never against live services in tests.
- **A new connectivity probe**: implement `ISourceProbe` in `backend/tools/ObservabilityCity.Validate` (see `SourceProbes.cs`) and add it to `SourceProbes.Default`. Probes take an `HttpClient` and an `ITokenProvider` so tests use canned answers.
- **Company rules** (naming conventions, tag-to-pillar mapping, special cases) belong in the company's own town folder or `extensions/`, not in core.
- **Themes**: `frontend/src/themes` and `shared-test-data/themes/theme-contract.json`.

## Style

Match the surrounding code: comment density, naming, idiom. Comments say why, not what. Prefer small pure functions that tests can call directly. Commit messages are short and in the imperative. Pull request descriptions say what changed, what was proven and on which side.
