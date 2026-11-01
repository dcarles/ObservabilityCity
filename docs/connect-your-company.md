# Connect your company

How to take a fork of Observability City from the fake town to your own Azure and Grafana, one source at a time. Nothing in this runbook needs a secret in the repository.

Every key of every config file, with its default and whether it is required, is in the [config reference](config-reference.md).

What works today: the town runs on fake data, and `validate --sources` tells you whether your Azure login can reach each source you configure. The adapters that turn real data into the town arrive phase by phase (real metrics, then messaging, then incidents); each one is added by the same steps, and a source you have not enabled yet stays out of the town.

## The shape of a fork

A fork adds only two things and never edits core:

- `config/<company>/`: your town (pillars, systems, environments).
- `extensions/`: your own code, when something is specific to your company.

Anything generic goes back upstream ([below](#send-a-generic-fix-upstream)). This keeps pulling upstream updates conflict-free.

## 1. Fork and clone

```
gh repo fork dcarles/ObservabilityCity --clone
cd ObservabilityCity
git remote add upstream https://github.com/dcarles/ObservabilityCity.git   # if the fork command did not
dotnet run --project backend/src/ObservabilityCity.AppHost
```

Check that the sample town opens on http://localhost:5173 before you change anything. You need .NET SDK 10 and Node 24 (see the README).

## 2. Sign in to Azure

```
az login
az account set --subscription "<subscription name or id>"
```

The tool and the backend use `DefaultAzureCredential`: it finds your `az login` on a laptop and a managed identity when hosted. There is no password or key in the repo or in `config/`.

Where a value must be kept (for example a Grafana service account token):

- **On your machine:** an environment variable, or `dotnet user-secrets` for the host project.
- **When hosted:** Azure Key Vault, read through the managed identity.

`.gitignore` already excludes `.env` and `secrets.json`. Never commit a connection string with a key in it; use the namespace or workspace *name* or *id* and let the login do the rest.

Your login needs read access only: Monitoring Reader on the Prometheus / Log Analytics workspace, and a role that can list topics on the Service Bus namespace.

## 3. Create your town

```
mkdir config/<company>
```

Start from the sample (`config/galactic-credit`) and keep the same layout:

```
config/<company>/
  town.yaml
  defaults.yaml
  hub.yaml                  shared resources (gateway, message broker, egress, shared databases)
  layout.yaml
  third-parties.yaml
  pillars/<pillar>.yaml     one island per pillar
  environments/<env>.yaml   dev, staging, prod...
```

Ids are `pillar.system`. Defaults cascade `defaults.yaml` -> pillar -> system. Pillar and system files are shared by every environment, so an environment file only says what differs: its sources, its tenants and the systems that are not deployed there (`exclude`). Ownership comes from your Azure `pillar` tag; a resource with no pillar lands on the Lost & found island.

Check the files as you go:

```
dotnet run --project backend/tools/ObservabilityCity.Validate -- config/<company>
```

Errors name the file and line. Every folder with a `town.yaml` under `config/` shows up in the town switcher with no setting.

## 4. Add one source at a time

Start with one environment (dev) and one signal (metrics). In `environments/dev.yaml`:

```yaml
name: Development
order: 1
sources:
  metrics: { kind: prometheus, connection: "https://<your-prometheus-query-endpoint>" }
```

| Signal | Kinds | `connection` is |
| --- | --- | --- |
| `metrics` | `prometheus`, `loganalytics`, `azuremonitor` | The Prometheus query endpoint URL, the Log Analytics workspace id, or (platform metrics) nothing: the resources come from the scope |
| `messaging` | `servicebus` | The namespace host name, for example `sb-example.servicebus.windows.net` |
| `incidents` | `grafana-irm` | The Grafana URL (token in the `GRAFANA_TOKEN` environment variable) |
| any | `fake` | Nothing; keeps fake data for that signal |

A signal you leave out is absent from the town, not grey. Add the next one only when the last one reports `connected`.

### Name your sources, then point each signal at one

`metrics`, `messaging` and `incidents` are the names a signal uses unless you say otherwise, but a source can have any lowercase kebab-case name, and each signal can be pointed at a different one. A company that reads request rate from one place and instance counts from another writes:

```yaml
name: Production
sources:
  telemetry: { kind: loganalytics, connection: "<workspace id>", pollSeconds: 60, timeoutSeconds: 20 }
  inventory: { kind: resourcegraph, connection: "<scope>" }
signals:                      # signal: source name, or none
  requests: telemetry
  errors: telemetry
  latency: telemetry
  instances: inventory
```

The signals are `requests`, `errors`, `latency`, `instances`, `cpu`, `memory`, `utilisation`, `throttled`, `backlog` and `deadLetters`. A signal comes from, in order: the system's own `signals:`, its pillar's `signals:`, the environment's `signals:`, then the environment's source called `metrics` (`messaging` for `backlog` and `deadLetters`). `none` switches a signal off for that system or pillar. A signal that ends up with no source is absent, and the town shows nothing for it: no lamp, no row in the inspector, no total in the top bar. That is different from grey, which is a source that is configured but has nothing fresh to say.

```yaml
# pillars/<pillar>.yaml or a system in it
signals: { cpu: platform }    # every system of the pillar takes cpu from the source called platform
```

Every source takes `pollSeconds` (default 30) and `timeoutSeconds` (default 10). Which kinds the build can already read is in the table of the phase you are on; a kind whose adapter is not loaded is an error in `validate` and, when the server starts, a notice; its signals then show no data (grey).

### Adapters are plug-ins

The program knows no platform by name. Each platform's source kinds and logins come in an adapter module: a folder under `adapters/` beside the program, which the host loads when it starts (`Adapters:Path` moves the folder). The build puts every adapter project in `backend/src/` and every project in `extensions/` there. Azure is the `azure` module; a company on another cloud, or that reads metrics from somewhere else, adds a module for it and leaves Azure out (`dotnet build -p:ExcludeAdapters=true` builds without any). Sources do not have to share a platform: an environment can read metrics from Prometheus while its resources are read from Azure.

### Logins

Azure sources (`resourcegraph`, `loganalytics`, `azuremonitor`, `servicebus`) sign in with whoever ran `az login`, unless you say otherwise. Define logins in the environment file and name one on a source:

```yaml
credentials:
  reader: { kind: service-principal, tenantId: "<tenant>", clientId: "<app id>", clientSecretEnv: REPORTER_SECRET }
sources:
  platform: { kind: azuremonitor, credential: reader }
```

| Kind | Signs in as |
| --- | --- |
| `azure-cli` (the default) | The account `az login` signed in |
| `default` | The Azure SDK's usual chain: environment variables, managed identity, developer tools |
| `managed-identity` | The identity of the machine it runs on (`clientId` picks a user-assigned one) |
| `service-principal` | An app registration. `clientSecretEnv` is the *name* of the environment variable that holds its secret; the secret never goes in a file |

A login defined with the name `default` replaces the Azure CLI one for every source that names none. Nobody is signed in when the server starts: a token is asked for when a source first needs it, so a town starts before `az login` and a missing login costs only the signals that need it. A service principal whose variable is not set is reported at start-up and its sources are left out.

### Scope: where each pillar and system lives

Nothing in the program knows how your company names things. An environment file's `scope:` block says it, with rules and templates, so a company with other names, tags or resource types writes other rules and changes no code. Templates have `{variable}` holes (and `{variable|nospace}`, `|lower`, `|upper`); `{environment}` is the environment's id and `variables:` are your own words.

```yaml
sources:
  inventory: { kind: resourcegraph, connection: "" }   # empty: every subscription the login can read; or subscription ids, comma separated
scope:
  inventory: inventory
  variables: { env: prod }
  workspace: "workspace-{env}"                          # the Log Analytics workspace by name (or a pattern like log-*-{env}): looked up in the inventory
  # workspaceId: "<workspace id>"                       # or its id, used as it is (wins when both are given; nothing is looked up)
  subscription: { nameLike: "*-{env}-{pillar}" }        # or: { tag: { key: pillar, value: "{pillarId}" } }
  pillars: { acme: 00000000-0000-0000-0000-000000000000 }  # a pillar named instead of found (optional)
  telemetryRole: "{name|nospace}"                       # what the telemetry calls a system that does not say
  resources:                                            # which resources belong to a service
    - { name: apps, types: [microsoft.web/sites], roles: [api, worker], pattern: '^(?<role>api|worker)-(?<service>[a-z]+)-(?<region>[a-z]+)' }
    - { name: accounts, types: [microsoft.documentdb/databaseaccounts], roles: [db], pattern: '^(?<tenant>[0-9a-f]{32})-(?<service>[a-z]+)$', tenantNameTag: customer }
```

To let the inventory supply the floors of the buildings, count the instances in a rule (`instances: "toint(sku.capacity)"` on the rule that matches the plans) and point the signal at the inventory source (`signals: { instances: inventory }` in the environment file, or in a pillar or system). The other signals can come from other sources: each signal is read from its own source. A building turns grey when any source it reads is stale; a source asked every five minutes stays fresh for ten.

- **Pillar to subscription.** `subscription` finds it by name (a wildcard, any case) or by a tag on the subscription; `{pillar}` is the pillar's `scope: { code: ... }` (else its id) and `{pillarId}` its id. `pillars:` names a subscription outright and wins. A pillar that no subscription, or more than one, matches is reported and not guessed.
- **Service to resources.** A `pattern` is a regular expression over a resource's name (any case) with named groups: `service` (required) is compared with the system's `serviceCode:` (else its `service:`); `role`, `pillar`, `region` and `tenant` are optional and narrow the match. `roles:` limits a rule to systems of those roles. `serviceTag:` finds a resource whose name does not match by a tag, and `tenantNameTag:` reads a tenant's friendly name from a tag, so the town can show it.
- **Instances.** A rule with `instances:` counts the instances of each of its resources, with an expression of the inventory query (a plan's workers, an app's replicas). The inventory query is built from the rules' expressions, so another company writes another expression for another resource type. A system's instances are the sum over its resources of such rules, so a service on two regions adds both. A system with no counted resource has an unknown count, which is not 0; a resource the cloud gives no number for adds nothing. The count is what is configured: the inventory cannot say which instances are unhealthy, so all count as healthy until a source that measures health says otherwise.
- **Workspace.** `workspace` is the workspace's name, or a wildcard pattern (`log-*-{env}`), and the inventory source looks it up through Resource Graph (the workspace's own `customerId` is the id the query API takes). Exactly one workspace must match; none or several are reported, with the names, and nothing is guessed. `workspaceId` gives the id outright (a GUID, or a resource id starting with `/subscriptions`) and is used as it is: when both are given the id wins and the lookup is skipped. A GUID or resource id written under `workspace` is taken as an id as well. The Config tab says which way it was settled. A source's own `connection` still wins over both. The lookup query can be replaced under `scope.queries.workspaces` (it returns `id`, `name` and `customerId`).
- **Telemetry names.** A system says what its telemetry calls it with `telemetry: { role: ... }` in its pillar file; one that does not takes the `telemetryRole` template. Two systems with the same name are reported, since their telemetry would be read as one.
- **Queries.** The adapter's own two queries (subscriptions, then the resources of the chosen subscriptions) can be replaced under `scope.queries`; every page of the answer is read.

- **Links.** `links:` makes an address per resource that opens it somewhere else, such as its page in a cloud portal or console. Each link has a `name` (the words shown), a `url` template and optionally `types` (only resources of those types). The template starts with `https://` written out and can use `{resourceId}`, `{name}`, `{type}`, `{region}`, `{subscriptionId}`, `{tenantId}`, `{tenantName}`, `{environment}` and your `variables`; values are percent-encoded. A tenant database account gets its own link. Nothing is shown without `links:`. The town only shows the address; it never opens it and holds no credentials for it.

```yaml
scope:
  variables: { directory: example.test }
  links:
    - { name: Cloud portal, url: "https://portal.example.test/#@{directory}/resource{resourceId}" }
```

Each system's **Config** tab in the town then has a *Where it lives* part with the subscription, workspace, service code, telemetry role and resources, and says how each was found. An environment without `scope:` shows nothing there.

#### `resourcegraph` (the inventory)

| | |
| --- | --- |
| Permission | Reader on the subscriptions to read (or on the management group above them) |
| `connection` | Empty for every subscription the login can read; subscription ids, comma separated, to limit it; `file:name.json` to replay a recording kept beside the town's files |
| `pollSeconds`, `timeoutSeconds` | The inventory changes slowly: 300 and 30 suit it |
| Fills | The scope above, which the adapters that read signals use to find their systems; and the `instances` signal of each system whose rules count instances (point `signals: { instances: <source name> }` at it) |

To try rules without Azure, keep a recording in the town folder, `{ "subscriptions": [ { "id", "name", "tags" } ], "resources": [ { "id", "name", "type", "subscriptionId", "location", "tags", "instances" } ] }`, and point the source at it with `file:`. The sample towns `scope-town-a` and `scope-town-b` under `shared-test-data/registries/` do exactly that, with opposite conventions.

#### `loganalytics` (request rate, errors and latency)

| | |
| --- | --- |
| Permission | Log Analytics Reader on the workspace |
| `connection` | The workspace id (a GUID) or its resource id (starting with `/subscriptions`). Empty: the workspace the environment's scope settles, either `scope.workspaceId` or the id found for the name in `scope.workspace` (see Workspace above). A bare name cannot be queried, so the first poll waits briefly for the inventory to be read. `file:name.json` replays a recorded answer kept beside the town's files |
| `query` | The query to send, a template (below). There is no default: which table, metric names and properties hold your span metrics is yours to say |
| `window` | How far back one answer looks: a number and a unit, `30s`, `5m`, `1h`. Default `5m` |
| `pollSeconds`, `timeoutSeconds` | 30 and 20 suit it; the query summarises, so keep it short in time |
| Fills | `requests`, `errors` and `latency` of every api, worker, gateway and cron system that has a telemetry name (point `signals: { requests: ..., errors: ..., latency: ... }` at it) |

One query serves the whole environment. The template may use `{window}` (`5m`), `{windowSeconds}` (`300`), `{roles}` (the telemetry names of the systems asked about, as `"A", "B"`), `{environment}` and the variables of `scope.variables`. It must return one row per telemetry name with the columns `role`, `calls` and, if you have them, `errors` and `latencyMs` (any order and case; extra columns are ignored). `calls` and `errors` are counts over the window; `latencyMs` is the latency you want compared with `slaP99Ms`, an average if that is all you have. Two towns can send entirely different queries (another table, another metric name, another status property) and show the same town:

```yaml
sources:
  telemetry:
    kind: loganalytics
    connection: "<workspace id>"
    window: 5m
    query: |
      <table> | where TimeGenerated > ago({window}) and <role column> in ({roles})
      | summarize calls = ..., errors = ..., latencyMs = ... by role = <role column>
signals: { requests: telemetry, errors: telemetry, latency: telemetry }
```

Use unsampled metrics (pre-aggregated span metrics), never a table that sampling thins out: a sampled count makes both the rate and the error share wrong. A system the answer has no row for made no calls in the window, which is reported as zero calls, not as unknown. Databases, caches and brokers are not asked (they have no span metrics) and keep the colour their other sources give them.

**Quiet.** A system with fewer calls in the window than its `minCalls` is *quiet*: its rate is shown, but its error share and latency are left out, and it is never amber because of them, since an error share on 3 calls means nothing. Set `minCalls` in `defaults.yaml` per role, in a pillar's `defaults`, or on one system; it counts at least 1, so a window with no calls is always quiet. The inspector's Errors and p99 rows say *quiet: too few calls to judge*, the service card says *quiet*, and the Config tab shows the minimum and which file it came from. A source that does not count calls never makes a system quiet.

To try a query's shape offline, keep a recorded answer in the town folder (`{ "tables": [ { "columns": [ { "name": "role" }, ... ], "rows": [ [ "Name", 120, 3, 85.5 ] ] } ] }`, the shape the API returns) and point the source at it with `file:`. `scope-town-a` and `scope-town-b` do this with two different queries.

#### `azuremonitor` (CPU, memory, capacity used and throttling)

| | |
| --- | --- |
| Permission | Monitoring Reader on the subscriptions of the resources |
| `connection` | Nothing: the resources come from the scope (the resources each system owns). `file:name.json` replays recorded series kept beside the town's files |
| `metrics` | Which metric of which resources fills which signal (below). There is no default: metric names, aggregations and filters are yours to say |
| `window` | How far back one answer looks. Default `5m`. The metrics are asked at a one-minute grain |
| `pollSeconds`, `timeoutSeconds` | 60 and 30 suit it: platform metrics have a one-minute grain, and a poll makes one call for each resource and kind of question |
| Fills | `cpu`, `memory`, `utilisation` (capacity used) and `throttled` of the systems whose resources an entry names (point `signals: { cpu: ..., memory: ..., utilisation: ..., throttled: ... }` at it) |

Each entry under `metrics` takes the resources that one rule of `scope.resources` finds for a system, and says for each signal which metric it is. The program knows no metric name, so another company, or another kind of resource, writes other entries:

```yaml
sources:
  platform:
    kind: azuremonitor
    window: 5m
    metrics:
      - resources: plans                       # the name of a scope.resources rule
        cpu: { metric: <cpu metric>, aggregation: average, scale: 0.01 }          # a percentage becomes the fraction the town reads
        memory: { metric: <memory metric>, aggregation: average, scale: 0.01 }
      - resources: accounts
        # request units used per second, as a share of what is provisioned
        utilisation: { metric: <request units>, aggregation: total, perSecond: true, over: { metric: <provisioned throughput>, aggregation: maximum } }
        # requests answered with 429, as a share of all requests
        throttled: { metric: <requests>, aggregation: count, filter: "<dimension> eq '429'", over: { metric: <requests>, aggregation: count } }
        requests: { metric: <requests>, aggregation: count, perSecond: true }   # per tenant database
        limit: { metric: <provisioned throughput>, aggregation: maximum }       # what is provisioned, as a plain number (not a health signal)
signals: { cpu: platform, memory: platform, utilisation: platform, throttled: platform }
```

A signal has the `metric` (as the cloud spells it), the `aggregation` that adds the window's points up (`average`, `total`, `count`, `maximum`, `minimum`), an optional dimension `filter`, and how the number becomes what the town reads: `over` divides by another metric (a share), `perSecond` divides a total by the window's seconds (a rate), and `scale` multiplies (a percentage is `0.01`). CPU, memory, capacity used and throttling are fractions held between 0 and 1. An entry may name a `namespace` for a resource type that has more than one. An entry may also set `interval`, the time grain it is asked at (`1m` by default; `5m`, `15m`, `30m`, `1h`, `6h`, `12h` or `24h`). Some metrics do not support a minute, and the cloud then answers `400` for that resource; give the entry a longer `interval` and make the source's `window` long enough to hold a few points of it (three times the interval is a good start). Metrics that agree on aggregation and filter share one call. An entry may also set its own `window`, how far back it looks (for example `1h`); without one it uses the source's `window`. The worst point of a longer window is steadier but slower to fall after a spike, so give a longer one only to what needs it, such as the databases. It must hold at least two points of the entry's `interval`.

- **Several resources.** A system with several resources (a service on two regions, a tenant database in each account) is as busy as its busiest. If any of them gives no number, the signal is unknown for the system rather than taken from the others, since the one without a number could be the one in trouble. A resource shared by several systems (one plan, two services) is read once.
- **A fallback metric.** Any signal's metric, and the `over` it divides by, may carry an `orElse`: another metric (`metric`, `aggregation`, optional `filter`) read in its place when the first gives no number or 0. For a data account it is how to measure against the autoscale ceiling where there is one and the fixed throughput where there is not: `limit: { metric: <autoscale max>, aggregation: maximum, orElse: { metric: <provisioned throughput>, aggregation: maximum } }`. An `orElse` cannot have an `over` or an `orElse` of its own.
- **A quiet account.** Some metrics (for a Cosmos account, the normalised consumption) are sent only when something happened, so a quiet account gives no number for hours, and with it the whole store would be unknown. Set `whenEmpty: idle` on that signal to read a successful but empty answer as 0. The tenant's row then says "no activity reported", because the 0 is an assumption and not a measurement. A read that fails (an error, a timeout, no permission) is never read as idle: the system is simply not reported.
- **A filter that matches nothing.** No request answered with 429 gives no points at all. When the whole it is a share of has points, the share is 0: no throttling, not an unknown.
- **Tenants.** A data account whose rule has a `tenant` group is read on its own, so the town can show whose is hot: the tenant list may spell an id with or without dashes. A tenant the environment does not list is shown as a customer under the name the `tenantNameTag` gives it; with no such tag it stays unknown (a purple ?) under its id. Only a tenant that should count as a test tenant needs an entry in the environment's `tenants:` list, with `kind: test`. A system's `tenantPattern` (for example `{tenant}-svc`) is what makes a data store stand as a yard with one unit for each tenant. In the inspector the tenants in trouble come first, each with its own share turned away. An entry that sets `limit` (the provisioned size as a plain number, read like any other signal) has each tenant row and the Overview's "Provisioned" row show it, as one size or the range; a database with no number (a serverless account, say) simply shows none.
- **A read that fails** fails the poll, naming how many reads failed and what the cloud answered. Only the systems that use the failed resource go without numbers (a system is never shown from only some of its resources); the others are reported as soon as their own reads finish, so the town fills in while a big first read is still running. A building whose data goes stale greys.
- **Restarts.** After every poll each source's newest readings are saved under `_discovered/readings/<environment>/` in the town's folder. When the server starts they are read back with the time they were taken, so a restart within a source's freshness window (twice its poll interval) carries on from the last picture; older readings come back stale and grey, as they would have. Keep the folder out of version control.

To try entries offline, keep recorded series in the town folder, `{ "<resource name>": [ { "metric": "...", "aggregation": "average", "filter": null, "points": [40, 44, 42] } ] }`, and point the source at it with `file:`. `scope-town-a` and `scope-town-b` do this with two differently shaped sets of entries (percentages and request units over provisioned throughput; cores and bytes over limits and a normalised consumption metric) and show the same town.

### Links: find the calls your systems make

Declared `calls` and `gatewayCalls` are always drawn. An environment can also find the rest from its dependency data: add a `links:` block to its file (see `links` in [config-reference.md](config-reference.md)). It names a `loganalytics` source of the file and a query template that returns one row for each caller and address, with the days it was seen on (`make_set(startofday(TimeGenerated))` in KQL), so Azure does the counting and no raw data comes back. Your own rules turn an address into a system: a regular expression over the host (and over the path, for a gateway that names the destination in it) with named groups, and a `target` template such as `{pillar}.{service}`. Nothing about names is built in.

- It runs in the background and never holds up the town. The first read looks back `firstRead` (7 days); after that each start reads only the gap since the last read, then once every `interval` (1 hour).
- A link needs both ends to be systems of the town and `minDays` (2) different days in the data. A link not seen for `keepFor` (30 days) drops off.
- Found links are saved under `_discovered/links/<environment>/` in the town's folder, one file for each pillar, with the days seen. Your pillar files are never edited. Keep the folder out of version control (a fork's `.gitignore` should list it).
- `discoverLinks: false` (in `defaults.yaml`, a pillar's `defaults` or a system) switches discovery off for the systems it covers. Only an API or a worker makes calls worth finding.
- An address no rule explains, no `ignoreHosts` pattern covers and no third party `domains` entry names appears under Notices, so a missing rule shows up as something to add. A wrong link is fixed by tightening a rule or adding an ignore pattern, not link by link.
- A call a rule explains but whose pillar is not in the town yet (a gateway path that starts with a pillar you have not added) is not a problem. It is listed as a note, one line for each pillar, apart from the problems and not counted among them, and it links up when that pillar joins the town. Remembered addresses are checked again on every read, so a rule or ignore pattern you add clears the notice at once, without waiting for it to age out. To make the same address one line instead of one for each id, replace the ids in the path in the query itself.
- The inspector's Links tab tags each link "Seen in calls" (with the last day it was seen) or "Declared".

#### Services outside the monitored platform

Calls to services that are not systems of the town (a third party, or the company's own services that no pillar file describes) are found by what they are called on. In `third-parties.yaml` give a vendor `services:`, each with a `match` list of a `host` (the host and everything under it) and an optional `path` pattern:

```yaml
vendors:
  - id: ext.shared
    name: Shared services
    internal: true            # the company's own, not a third party
    services:
      - { id: credit, name: Credit, match: [{ host: shared.example.test, path: '^/credit' }] }
      - { id: identity, name: Identity, match: [{ host: shared.example.test, path: '^/identity' }, { host: id.example.test }] }
```

The vendor stands on one island out at sea with a building for each service, in rows of 2, 4, 6 or 8 plots (whichever makes the smallest island, as on a pillar's island). Link discovery sends each call it finds to the first service whose match fits it, and the island gets a road and cars from every system that calls it. A service's health is not read yet: its building shows "not monitored", and is not counted as no data, until a source you name on that service reports it. A vendor without `services` is still one building on its own island.

Cars drive from the town to such a service at the rate the calls were measured (the `links.traffic` block), whatever the service's own state, so the traffic going out to a third party shows without any health being read for it.

**Services that call the town.** A service that is not a system of the town may itself call town systems, through the gateway. List the telemetry names its calls are recorded under, one for each instance, as `roles` on the service:

```yaml
      - { id: portal, name: Portal, match: [{ host: shared.example.test, path: '^/portal' }], roles: ["Portal.Instance.One", "Portal.Instance.Two"] }
```

Link discovery and the traffic read then ask about those names as well as the town systems', and resolve the calls with the same `links.rules`. What follows needs no extra setting: the service is drawn calling the town system, its calls are counted as a known caller (so they leave the airport's outside traffic), the Dependencies layer gets an arc from its island, and cars drive from the island round the ring road, through the airport (which has a back gate and a side road for this), over its bridge to the hub and through the gateway to the system. The names are exact; list every instance. A hub-and-spoke town only: a direct town has no hub, so the cars drive round the ring road to the island. Hosts that calls go to and no rule explains are listed in the **Unknown hosts** panel (a button next to Notices), grouped by host with the calls, the systems that made them and the days seen, and each row copies a ready `third-parties.yaml` line or an `ignoreHosts` pattern to paste. Nothing is added by itself.

#### Where an API's traffic comes from

An API's total request rate comes from your unsampled metrics. With a `links.traffic` block (see `links` in [config-reference.md](config-reference.md)) the town also learns how much each town system sends to it, from the same dependency table: the query returns one row for each caller and address over the last `shareWindow` with `calls` summed from the sampling-corrected count (`sum(ItemCount)` in KQL). The rest is outside traffic:

> outside = the API's measured total, less what the town systems that call it send (never below zero)

The callers' calls are counted over the whole `shareWindow`, so the town compares them with the API's own rate averaged over that same window (it keeps a rolling mean of it). To be steady from the first minute after a start, the town asks once, when it starts, for each API's average rate over the share window. It asks the environment's own telemetry query again with `{window}` set to the share window, so there is nothing new to write. That average stands in until the town has ten minutes of its own history. A source that cannot answer (a recording, or a failed read) leaves the split on the current rate until then, and the town asks again on its next read. The outside share is worked out from that mean and applied to the current rate. Otherwise an API with few calls, whose last few minutes jump about, would show a steady caller as outside traffic whenever a busy few minutes came along.

- Every API gets its own outside part, not only the ones marked `external`: whatever the town does not explain arrives at the airport. A caller is only known when it is a town system whose own calls the query sees, so a system with `discoverLinks: false` looks like an outside caller.
- If the callers would add up to more than the API receives (the two are measured differently), they are scaled down together.
- Below `minCalls` observed calls to an API the share is too noisy: the last good share stands and the inspector marks it "estimated". There is no setting for a share; every number is measured.
- Without a `traffic` block nothing is measured: each API's rate is shared evenly between the systems that declare a call to it (and the outside, when it is marked `external` or an outside caller reaches it).

### Logs tab: failed and slow requests, warnings, exceptions

A system's inspector has a Logs tab. In a live town it is empty of everything until you write a `logs:` block in the environment file (see `logs` in [config-reference.md](config-reference.md)); without it the tab says logs are not set up. With it, opening the tab sends one query for that system's telemetry name over the last `window` (4 hours by default) to the `loganalytics` source you name. Nothing is polled, nothing is stored, and the tab never changes a building's colour: health comes from your unsampled metrics.

The query is yours (which table, which columns, which status counts as a failure). It returns one row for each kind of entry, already grouped by Azure, with a `section` column saying which of four lists it belongs to:

- `failed`: requests that answered with a 5xx.
- `slow`: requests over the system's own latency line, passed to the query as `{slaMs}` (the `slaP99Ms` of the defaults cascade).
- `logs`: warnings and errors, including start-up.
- `exceptions`: exceptions.

Repeats come back as one row with a `count`, and the tab shows them newest first. A worker (or anything that does not answer requests) is shown only `logs` and `exceptions`. `links` put a link in the header of a section (say `failed` or `exceptions`) that opens your telemetry store's own search, already filtered to the system and the window. Each link names a `scope.assets` rule (for example the rule that finds your Application Insights resources); every resource the rule finds gets its own link, so a primary and a standby store both show. The address is a template that you write out in full (`{resourceId}`, `{resourceIdTwice}`, `{resourceName}`, `{role}`, `{from}`, `{to}`, `{windowMs}`). If you later move to another logging store, only the adapter behind the source changes.

### Function apps and regions

A system with role `function` (`cron` still works as an alias) stands as a function building. Three things in the environment file make it say more:

- **App state.** Give the resource rule a `state` expression (a query expression that reads the app's state as text) and `running` (the values that mean it runs). A running app is lit; a stopped one stands under construction; a system the inventory has no such app for is grey, "not found in the inventory". The core knows no state words.
- **Jobs.** A `functionjobs` source runs a query that summarises the function apps' logs into one row per app and job, with the columns `resourceId`, `job`, `lastRun`, `succeeded` and `next` (and `region` where it matters). Point `signals: { jobs: <source> }` at it. Each job shows as succeeded, failed or overdue (now later than `next` plus the source's freshness), and the building's beacon follows. How your logs word a run is yours to say in the query:

```yaml
sources:
  functions:
    kind: functionjobs
    connection: "<workspace id>"
    window: 1d
    query: |
      <table>
      | where TimeGenerated > ago({window}) and <your match on the app and the job>
      | summarize lastRun = max(TimeGenerated), succeeded = <your success test> by resourceId = <column>, job = <column>
      | extend next = <when the job should run next>
```

- **Regions.** A service that runs in two or more regions shows its worst region (by processor and memory) on the building; the drawer can switch between the worst region and each region in turn. The `scope.regions` block names where a region is read from (`tag`), how it is labelled (`names`), and how lopsided a split of requests may be before it is flagged (`skew`).
  - **Where each region's share comes from.** Give the `loganalytics` source a `regionQuery` that returns one row per app role and region with the number of `calls`. Counts are enough, even sampled ones, since only their proportions are used. The sign and the drawer show the split ("North 90% · West 10%"), and a region over `skew` (0.9 by default; 1 never flags) gets a warning while another region still runs instances. Without a `regionQuery` there is no split and nothing is shown for it.
  - **The switch.** The building shows one region at a time: the worst one, or the one picked in the drawer. There is no combined view, since adding up two regions' instances and averaging their processors would hide the one that is in trouble. A region the cloud does not report an instance count for adds nothing and is never shown as "unknown".

### Basic buildings (key vaults, storage, App Configuration) and the cloud's name

`scope.assets` lists rules for resources that have no health of their own but belong in the town. Each rule has a `name`, the `label` shown on its card, a `shape` (`vault`, `store`, `settings` or `box`), the resource `types` it matches and a `pattern` that names the pillar (and the service, when the resource belongs to one) with the same groups as the system rules. A resource tied to a service stands behind that service's pad; the others stand in the pillar's back yard. Clicking one opens a card with its name, type, owner and the portal links from `scope.links`. The inventory query includes the rules' types, so no other change is needed.

Shared resources that belong to no pillar (a log workspace, application insights) stand on the hub island: give the rule `island: hub` and a `group`, the name of the cluster they stand in, shown on a sign (rules with the same group share a cluster). If they live in a subscription of their own, add `subscription: { nameLike: "..." }` (or `tag`), a template over your `variables` and `{environment}`. The card has no health, only the portal links.

The hub's own systems (the gateway, the message broker) get their portal links the same way as any system: give the system a `serviceCode` in `hub.yaml`, and add a `scope.resources` rule for its resource type with `roles: [gateway]` or `roles: [broker]` and a `pattern` whose `service` group matches that code. The hub is not a pillar, so say where the rule looks with its own `subscription` (`nameLike` or `tag`); a rule that finds several resources (one for each region) gives the system one link for each. When the hub holds buildings of its own (`island: hub`), the hub island grows just enough to give each group a place.

`scope.cloud` is the name of your cloud as the town should say it (for example `Azure`, `AWS` or `Cumulus`). It is used in the words "not found in <cloud>" and nowhere else; the core assumes no cloud.

A demo town needs no cloud for any of this: `fake.yaml` takes `regions: { <name>: <weight>, ... }` on a service, and `fake-assets.yaml` lists the buildings by pillar, name, label, shape and service.


### What each adapter's runbook section contains

Each real adapter lands with its own section here, with the same four parts: the permission the login needs, the `connection` value, the `pollSeconds` and `timeoutSeconds` that suit it, and what `--sources` reports for it. Until an adapter has its section, its kind is known to the module but nothing reads it yet.

## 5. Run the check

```
dotnet run --project backend/tools/ObservabilityCity.Validate -- --sources config/<company>
```

For each environment and signal it makes one cheap read with your Azure login and says one of:

| Result | Means | What to do |
| --- | --- | --- |
| connected | It answered with data | Nothing |
| no permission | Refused (401/403), or no login or token | `az login`, check the role, set `GRAFANA_TOKEN` |
| query returned nothing | It answered but had no data | Wrong workspace or endpoint, or nothing is reporting yet. Not a failure unless you pass `--strict` |
| unreachable | No answer, an error, or a timeout | Check the address, VPN, firewall |
| not configured | The environment has no source for this signal | Fine; the town leaves the signal out |
| unknown kind | The kind is spelt wrong or has no probe | The message lists the kinds it knows |
| no probe yet | A loaded adapter knows the kind but its probe arrives with the adapter | Nothing; not a failure |

The exit code is 1 when anything is *no permission*, *unreachable* or *unknown kind* (and, with `--strict`, *empty*), so you can run it in a pipeline.

A `loganalytics` source with no `connection` is probed with the workspace its environment's scope names: `scope.workspaceId` as it is, else `scope.workspace` (an id as it is; a name or wildcard is looked up through Resource Graph, and none or several matches are reported with the names).

The Azure login keeps each token until shortly before it expires, and asks for one at a time per scope, so a login that starts a process for every request (`az login`) is not started once per read.

The normal registry check (`-- config/<company>`) validates the files, including source names, kinds, logins and signal choices, and warns about a signal pointed at a source the environment does not define. `--sources` reads the environment files directly and reports every source you defined, so you can verify connectivity before the adapter lands.

## 6. Watch the town

```
dotnet run --project backend/src/ObservabilityCity.AppHost
```

Open http://localhost:5173, pick your town in the top bar, then the environment. Check a few buildings against the tool you trust today. Use **Break things** on the fake sample town to learn what each light, floor and beacon means before you read your own.

## 7. Then the next environment, the next signal

Repeat steps 4 to 6 for the next signal, then copy the environment file for staging and prod. Commit `config/<company>/` on a branch and open a pull request in your fork; the registry check runs in CI and comments on the pull request.

## Send a generic fix upstream

If you found a bug or a missing capability that is not specific to your company:

```
git fetch upstream
git checkout -b fix/short-description upstream/main
# make the change in core, with tests on both sides (backend xUnit, frontend Vitest / Playwright)
git push -u origin fix/short-description
gh pr create --repo dcarles/ObservabilityCity --base main
```

Rules for the upstream pull request: no company names, tenant ids, hostnames or screenshots of your town; examples use generic names; tests use fakes and recorded fixtures, never live services. Once it is merged, `git fetch upstream && git merge upstream/main` brings it into your fork. A fix that only makes sense at your company stays in `config/<company>/` or `extensions/`.

## When something goes wrong

- **No Azure login** (`no permission` with "run az login"): `az login`, then `az account show` to confirm the subscription.
- **Everything unreachable:** try the address in a browser or with `curl`; a corporate proxy or VPN is the usual cause.
- **The town is empty or grey:** grey means configured but no fresh data; run `--sources` and fix whatever is not *connected*.
- **Registry errors:** the message names the file, line and rule. The README lists every rule.
