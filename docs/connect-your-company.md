# Connect your company

How to take a copy of Observability City from the fake town to your own systems, one source at a time. Nothing in this runbook needs a secret in the repository.

The core is cloud-neutral. It ships an Azure adapter today, which is what the source sections below describe; other clouds and tools plug in through adapters (see [write-an-adapter.md](write-an-adapter.md)).

Every key of every config file, with its default and whether it is required, is in the [config reference](config-reference.md).

What works today: the sample towns run on fake data, and a live town reads real sources through adapters. The Azure adapter reads the kinds `resourcegraph` (the inventory and instance counts), `loganalytics` (request rate, errors, latency), `azuremonitor` (CPU, memory, capacity used, throttling), `servicebus` (backlog and dead letters), `functionjobs` (scheduled jobs) and `resourcehealth` (the cloud provider's own health reports, shown as incidents). `prometheus` and `grafana-irm` are only reserved kind names: nothing reads them yet, so a source of either kind shows no data. Incidents come in a later phase (see the [plan](observability-city-plan.md)). Each source is added by the same steps, and a source you have not enabled yet stays out of the town.

## Keep your company config out of any public repository

**A GitHub fork of a public repository is always public, and it cannot be made private.** Your town files hold cloud account and tenant ids, customer tenant names, workspace names, resource-name patterns and queries. Never commit them to a fork of this repository, or to this repository.

Use one of these two setups:

1. **Config outside the clone (recommended).** Keep your town in its own folder, ideally its own *private* repository, anywhere on the machine, and point the app at it (step 3). The clone of this repository then holds nothing of yours, so `git add .` cannot publish it.
2. **A private copy of the code.** Only if you also need to change code. Create an empty *private* repository, then:

```
git clone --bare https://github.com/dcarles/ObservabilityCity.git
cd ObservabilityCity.git
git push --mirror https://github.com/<you>/<your-private-repo>.git
cd .. && rm -rf ObservabilityCity.git
git clone https://github.com/<you>/<your-private-repo>.git
cd <your-private-repo>
git remote add upstream https://github.com/dcarles/ObservabilityCity.git
```

`origin` is your private copy. `upstream` is only a link you pull from (`git fetch upstream && git merge upstream/main`); you never push to it.

## The shape of a company setup

A company adds only two things and never edits core:

- Your town folder (pillars, systems, environments), kept outside the clone or in `config/<company>/` of a private copy.
- `extensions/`: your own code, when something is specific to your company.

The build picks up only the projects under `extensions/` inside the clone, so your own code does not fit setup 1 as it stands. A company that needs its own adapter either uses setup 2 (a private copy, with the project in its `extensions/`), or builds the module elsewhere and loads it through `Adapters:Path`. That setting moves the whole folder the host loads modules from, so the folder must hold the upstream modules it still needs (such as `azure/`) beside yours. A town that needs only the adapters that ship upstream needs no `extensions/` at all.

Anything generic goes back upstream ([below](#send-a-generic-fix-upstream)). This keeps pulling upstream updates conflict-free.

## 1. Clone

```
git clone https://github.com/dcarles/ObservabilityCity.git
cd ObservabilityCity
dotnet run --project backend/src/ObservabilityCity.AppHost
```

Check that the sample town opens on http://localhost:5173 before you change anything. You need .NET SDK 10 and Node 26 (see the README).

## 2. Sign in to your cloud

Each adapter signs in its own way, and there is no password or key in the repo or in `config/`. The Azure adapter is shown below; an adapter for another cloud or tool says how it signs in in its own section of this runbook.

Where a secret must be kept (for example a service principal's secret, or the token the `--sources` probe for `grafana-irm` reads from `GRAFANA_TOKEN`), it must be a real environment variable of the process:

- **On your machine:** an environment variable set in the shell that starts the app. `dotnet user-secrets` does not work for this: the host project has none, and the code reads the secret from the process environment, not from the app's settings.
- **When hosted:** surface the secret as an environment variable of the app (for example through your platform's secret store). The app itself reads only environment variables; nothing in it reads a secret store.

`.gitignore` already excludes `.env` and `secrets.json`. Never commit a connection string with a key in it; use the resource's *name* or *id* and let the login do the rest.

### Azure adapter

```
az login
az account set --subscription "<subscription name or id>"
```

The backend signs in with your `az login` (the `azure-cli` login) unless the environment file's `credentials:` says otherwise (see [Logins](#logins)). When hosted, it does not pick up a managed identity by itself: the environment file must define a login called `default` of kind `managed-identity` (or `default`). `validate --sources` is different: it uses the Azure SDK's `DefaultAzureCredential` (your `az login` on a laptop) and ignores the `credentials:` block.

Your login needs read access only, for each kind you use:

- `resourcegraph`: Reader on the subscriptions (or the management group above them).
- `loganalytics` and `functionjobs`: Log Analytics Reader on the workspace.
- `azuremonitor`: Monitoring Reader on the subscriptions of the resources.
- `servicebus`: Monitoring Reader on the namespaces (it reads their platform metrics). Only the `--sources` probe lists topics, and that needs Manage on the namespace.
- `resourcehealth`: read of the activity log of each subscription (Monitoring Reader or the like) and of the resources' health status.

## 3. Create your town

Create the folder outside the clone (the examples below call it `<company-config>`, for example `C:\Config\acme` or `~/config/acme`) and start from the sample (`config/galactic-credit`), keeping the same layout:

```
<company-config>/
  town.yaml                 the town: id, name, mode, topology, groupLabel, islands (their order), ringCapacity,
                            trafficDensity, databaseEngines, messaging (topic naming) and labels
  defaults.yaml
  hub.yaml                  shared resources, for example a gateway and a message broker (several of a kind
                            are allowed, each its own building)
  third-parties.yaml
  groups/<group>.yaml       one island per group (pillars/<pillar>.yaml, the older name, reads the same)
  environments/<env>.yaml   dev, staging, prod...
```

**Group** is the neutral word the files use for one island's set of systems, and **pillar** its older name: `groups/` or `pillars/`, `group:` or `pillar:` in a group file, `{group}` or `{pillar}` in a template and `(?<group>...)` or `(?<pillar>...)` in a pattern all read the same, so a town written either way loads unchanged. Use one spelling of the folder and of the key; both is an error. The interface never shows either word: it uses your `groupLabel` (Team, Domain, Pillar). The rest of this page says pillar for a group.

The sample is a demo town, so a copy of it must be turned into a live one before it reads anything real:

- **Give it a new `id` and `name` in town.yaml.** A second town with the same `id` as another (the sample's `galactic-credit`) is left out when the server starts.
- **Remove `mode: demo`** (or write `mode: live`). A demo town runs only the fake source, whatever its environment files say. A town that does not say is live. The mode is read once, when the server starts: restart after changing it.
- **Delete `fake.yaml`, `fake-assets.yaml` and `stories/`.** They belong to a demo town; in a live one `validate` reports them as an error.
- **Replace the `kind: fake` sources** in the environment files with real ones (step 4). A live town refuses a `fake` source.
- **Set `messaging` to your topic naming.** When each service has one topic named by a rule, `topicTemplate` and `hubTopicTemplate` say the rule, for example `{service}.events` (the sample uses `{pillar}-{service}-outbox`), and a pillar file lists the service. When your topics are named after events (`orders.created`), or a service has several, list each topic by its name in the pillar file instead, `{ topic: orders.created, service: orders }`, and leave the templates out. Both ways can stand in one town. A pillar's `messaging.topics` and `subscriptions` only line up with the broker when the names match your real topic names.
- **`labels`** holds the town's own words, for now `internalVendors` (what the town calls your own services outside the monitored platform).

Ids are `pillar.system`. Defaults cascade `defaults.yaml` -> pillar -> system. Pillar and system files are shared by every environment, so an environment file only says what differs: its sources, its tenants and the systems that are not deployed there (`exclude`). The other way round, a system can list the environments it is deployed in, `environments: [dev, prd]`; the names are checked against the files in `environments/`.

An environment file's name is its id: `environments/prd.yaml` is the environment `prd`. That id is what `{environment}` stands for in templates, what `environments: [...]` lists and the name of its folders under `_discovered/`. It must be lowercase kebab-case.

Ownership comes from your pillar files and the environment's scope rules, not from the cloud: only systems a pillar file (or `hub.yaml`) declares are in the town. The scope ties a pillar to its cloud account (with the Azure adapter, a subscription: `scope.account`, by a name pattern or a tag you name, or `scope.groupAccounts`, older name `pillarAccounts`) and a system to its resources (`scope.resources`); see [Scope](#scope-where-each-pillar-and-system-lives). Lost & found is optional: a pillar file with the id `lost-found`, for systems you declare by hand that no team owns; the town only places it last. Nothing sends unmatched resources there.

Check the files as you go:

```
dotnet run --project backend/tools/ObservabilityCity.Validate -- <company-config>
```

Errors name the file and line. Tell the app where the folder is with the `Registry:Towns` setting; each extra folder gets the next number, and every one shows up in the town switcher next to the sample town:

```
$env:Registry__Towns__0 = "C:\Config\acme"      # PowerShell
export Registry__Towns__0=~/config/acme         # bash
```

`Registry:Towns` adds towns; the sample towns stay. `Registry:Path` is different: it names the one town to run in place of the sample and turns off the automatic pickup of the other `config/*` towns (described next), though `Registry:Towns` folders are still added. `Registry:DefaultTown` (`Registry__DefaultTown`) is the id of the town the page opens on; without it, the first one (the sample, or the `Registry:Path` town).

Without `Registry:Path`, folders with a `town.yaml` under the clone's own `config/` also show up with no setting, which is how a private copy (setup 2) works. As a guard, add its name to `.git/info/exclude` (never committed) if you keep a company folder there in a clone that has a public remote:

```
echo config/<company>/ >> .git/info/exclude
```

## 4. Add one source at a time

Start with one environment (dev): the inventory, which finds where each system lives, and one source of health signals. In `environments/dev.yaml`:

```yaml
name: Development
order: 1
sources:
  inventory: { kind: resourcegraph, connection: "", pollSeconds: 300, timeoutSeconds: 30 }
  telemetry: { kind: loganalytics, connection: "<workspace id>", query: "<your query; see loganalytics below>" }
scope:
  inventory: inventory
  resources: []               # your rules; see Scope below
signals: { requests: telemetry, errors: telemetry, latency: telemetry }
```

An `azuremonitor` source (CPU and memory) is an equally good first health source. These are the kinds the Azure adapter reads today:

| Signals | Kind | `connection` is |
| --- | --- | --- |
| `instances` (and the scope) | `resourcegraph` | Empty for every subscription the login can read, or subscription ids |
| `requests`, `errors`, `latency` | `loganalytics` | The Log Analytics workspace id, or empty for the workspace the scope settles |
| `cpu`, `memory`, `utilisation`, `throttled` | `azuremonitor` | Nothing: the resources come from the scope |
| `backlog`, `deadLetters` | `servicebus` | Nothing: the namespaces come from the scope. Needs an `entities:` block ([below](#servicebus-backlog-and-dead-letters)) |
| `jobs` | `functionjobs` | The Log Analytics workspace id |
| none (incidents) | `resourcehealth` | Nothing: the subscriptions come from the scope |

Every kind that reads Azure also takes `file:name.json`, a recording kept beside the town's files.

Not read yet:

- `prometheus` and `grafana-irm` are accepted names with no adapter: a source of either kind is left out with a notice when the server starts, and its signals have no data. There is no live incident source yet; the incidents a live town shows come from `resourcehealth`. The `--sources` probe can still check that a `grafana-irm` URL answers (token in the `GRAFANA_TOKEN` environment variable), but nothing reaches the town.
- `fake` runs only in a demo town (`mode: demo`), where it supplies every signal and every other source is ignored. A live town refuses it; it cannot be mixed in for one signal.

A signal you leave out is absent from the town, not grey. Add the next one only when the last one reports `connected`.

### Name your sources, then point each signal at one

`metrics`, `messaging` and `jobs` are the names a signal uses unless you say otherwise, but a source can have any lowercase kebab-case name (except `incidents`, which a live town keeps for incident adapters and does not run as a source), and each signal can be pointed at a different one. A company that reads request rate from one place and instance counts from another writes:

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

The signals are `requests`, `errors`, `latency`, `instances`, `cpu`, `memory`, `utilisation`, `throttled`, `backlog` and `deadLetters`, and for a function also `jobs`. A signal comes from, in order: the system's own `signals:`, its pillar's `signals:`, the environment's `signals:`, then the environment's source called `metrics` (`messaging` for `backlog` and `deadLetters`, `jobs` for `jobs`). `none` switches a signal off for that system or pillar. A signal that ends up with no source is absent, and the town shows nothing for it: no lamp, no row in the inspector, no total in the top bar. That is different from grey, which is a source that is configured but has nothing fresh to say.

```yaml
# pillars/<pillar>.yaml or a system in it
signals: { cpu: platform }    # every system of the pillar takes cpu from the source called platform
```

Every source takes `pollSeconds` (default 30) and `timeoutSeconds` (default 10); a job source also takes `lateAfterSeconds` (see Jobs below). A kind that no loaded module knows is an error in `validate`. `prometheus` and `grafana-irm` are known kinds with no adapter: they pass `validate`, get a notice when the server starts, and read nothing, so their signals show no data (grey).

### Adapters are plug-ins

The program knows no platform by name. Each platform's source kinds and logins come in an adapter module: a folder under `adapters/` beside the program, which the host loads when it starts (`Adapters:Path` moves the folder). The build puts every adapter project in `backend/src/` and every project in `extensions/` there. Azure is the `azure` module; a company on another cloud, or that reads metrics from somewhere else, adds a module for it and leaves Azure out (`dotnet build -p:ExcludeAdapters=true` builds without any). Sources do not have to share a platform: an environment can read metrics through another module while its resources are read from Azure. A module of your own lives in `extensions/` (see [The shape of a company setup](#the-shape-of-a-company-setup)).

A source block has the core's keys (`kind`, `connection`, `credential`, `pollSeconds`, `timeoutSeconds`, `lateAfterSeconds`, `query`, `window`) and the keys of its kind's adapter. Each adapter checks its own keys, in `validate` and when the server loads the town, and says where a mistake is. The Azure adapter's keys (`regionQuery`, `typesQuery`, `metrics`, `entities`, `providers`, `keepResolvedFor`) are in the sections below and under [Azure adapter settings](config-reference.md#azure-adapter-settings). A kind whose adapter is not loaded is reported once and its keys are not checked.

### Logins

Each adapter has its own login kinds. The Azure adapter's sources (`resourcegraph`, `loganalytics`, `azuremonitor`, `servicebus`, `functionjobs`, `resourcehealth`) sign in with whoever ran `az login`, unless you say otherwise. Define logins in the environment file and name one on a source:

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

The scope speaks of the **account** a pillar lives in (an Azure subscription, an AWS account, a GCP project) and the **telemetry store** its telemetry is in (on Azure, a Log Analytics workspace). The keys use those words: `account`, `groupAccounts` (older name `pillarAccounts`), `telemetryStore`, `telemetryStoreId`, and `accounts` and `telemetryStores` under `queries`. A file written with the Azure names (`subscription`, `pillars`, `workspace`, `workspaceId`, `queries.subscriptions`, `queries.workspaces`) loads the same; write one spelling of a key per block, since both on one block is an error. The inventory is read by a source whose kind can read one: with the Azure adapter, the `resourcegraph` source. Another adapter's kind can do it too, if its adapter says so.

```yaml
sources:
  inventory: { kind: resourcegraph, connection: "" }   # empty: every subscription the login can read; or subscription ids, comma separated
scope:
  inventory: inventory
  variables: { env: prod }
  telemetryStore: "workspace-{env}"                     # on Azure the Log Analytics workspace, by name (or a pattern like log-*-{env}): looked up in the inventory
  # telemetryStoreId: "<workspace id>"                  # or its id, used as it is (wins when both are given; nothing is looked up)
  account: { tag: { key: team, value: "{pillarId}" } }  # on Azure the subscription, by tag; or by name: { nameLike: "{pillar}-{env}" }
  groupAccounts: { acme: 00000000-0000-0000-0000-000000000000 }   # a group named instead of found (optional; older name pillarAccounts)
  telemetryRole: "{service}-{role}"                     # what the telemetry calls a system that does not say
  resources:                                            # which resources belong to a service
    - { name: apps, types: [microsoft.web/sites], roles: [api, worker], pattern: '^(?<service>[a-z]+)-(?<role>api|worker)-[a-z]+$' }
    - { name: accounts, types: [microsoft.documentdb/databaseaccounts], roles: [db], pattern: '^tenant-(?<tenant>[a-z0-9]+)-(?<service>[a-z]+)$', tenantNameTag: customer }
```

To let the inventory supply the floors of the buildings, count the instances in a rule (`instances: "toint(sku.capacity)"` on the rule that matches the plans) and point the signal at the inventory source (`signals: { instances: inventory }` in the environment file, or in a pillar or system). The other signals can come from other sources: each signal is read from its own source. A late source takes out only its own signals, which are then listed as absent, while another source of a health signal for that building is fresh; the building greys only when no source of a health signal is fresh. A source that supplies only `instances`, `backlog` or `deadLetters` cannot keep a building lit on its own. A source asked every five minutes stays fresh for ten.

- **Pillar to account (Azure adapter: a subscription).** `account` (Azure name `subscription`) finds it by name (a wildcard, any case) or by a tag on the account; `{pillar}` is the pillar's `scope: { code: ... }` (else its id) and `{pillarId}` its id. `groupAccounts:` (older name `pillarAccounts`, Azure name `pillars`) names an account outright and wins. A pillar that no account, or more than one, matches is reported and not guessed.
- **Service to resources.** A `pattern` is a regular expression over a resource's name (any case) with named groups: `service` (required) is compared with the system's `serviceCode:` (else its `service:`); `role`, `pillar`, `region` and `tenant` are optional and narrow the match. `roles:` limits a rule to systems of those roles. `serviceTag:` finds a resource whose name does not match by a tag, and `tenantNameTag:` reads a tenant's friendly name from a tag, so the town can show it.
- **Instances.** A rule with `instances:` counts the instances of each of its resources, with an expression of the inventory query (a plan's workers, an app's replicas). The inventory query is built from the rules' expressions, so another company writes another expression for another resource type. A system's instances are the sum over its resources of such rules, so a service on two regions adds both. A system with no counted resource has an unknown count, which is not 0; a resource the cloud gives no number for adds nothing. The count is what is configured: the inventory cannot say which instances are unhealthy, so all count as healthy until a source that measures health says otherwise.
- **Telemetry store (Azure adapter: a Log Analytics workspace).** `telemetryStore` (Azure name `workspace`) is the store's name, or a wildcard pattern (`log-*-{env}`), and the inventory source looks it up (with the Azure adapter, through Resource Graph; the workspace's own `customerId` is the id the query API takes). Exactly one store must match; none or several are reported, with the names, and nothing is guessed. `telemetryStoreId` (Azure name `workspaceId`) gives the id outright (on Azure a GUID, or a resource id starting with `/subscriptions`) and is used as it is: when both are given the id wins and the lookup is skipped. A GUID or resource id written under `telemetryStore` is taken as an id as well. The Config tab says which way it was settled. A source's own `connection` still wins over both. The lookup query can be replaced under `scope.queries.telemetryStores` (Azure name `workspaces`; with the Azure adapter it returns `id`, `name` and `customerId`).
- **Telemetry names.** A system says what its telemetry calls it with `telemetry: { role: ... }` in its pillar file; one that does not takes the `telemetryRole` template. Two systems with the same name are reported, since their telemetry would be read as one.
- **Queries.** The adapter's own two queries (accounts, then the resources of the chosen accounts) can be replaced under `scope.queries` (`accounts`, `resources`); every page of the answer is read.

- **Links.** `links:` makes an address per resource that opens it somewhere else, such as its page in a cloud portal or console. Each link has a `name` (the words shown), a `url` template and optionally `types` (only resources of those types). The template starts with `https://` written out and can use `{resourceId}`, `{name}`, `{type}`, `{region}`, `{accountId}` (Azure name `{subscriptionId}`), `{tenantId}`, `{tenantName}`, `{environment}` and your `variables`; values are percent-encoded. A tenant database account gets its own link. Nothing is shown without `links:`. The town only shows the address; it never opens it and holds no credentials for it.

```yaml
scope:
  variables: { directory: example.test }
  links:
    - { name: Cloud portal, url: "https://portal.example.test/#@{directory}/resource{resourceId}" }
```

Each system's **Config** tab in the town then has a *Where it lives* part with the account, telemetry store, service code, telemetry role and resources, and says how each was found. An environment without `scope:` shows nothing there.

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
| `connection` | The workspace id (a GUID) or its resource id (starting with `/subscriptions`). Empty: the workspace the environment's scope settles as its telemetry store, either `scope.telemetryStoreId` (Azure name `workspaceId`) or the id found for the name in `scope.telemetryStore` (Azure name `workspace`; see Telemetry store above). A bare name cannot be queried, so the first poll waits briefly for the inventory to be read. `file:name.json` replays a recorded answer kept beside the town's files |
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
- **A read that fails** fails the poll, naming how many reads failed and what the cloud answered. Only the systems that use the failed resource go without numbers (a system is never shown from only some of its resources); the others are reported as soon as their own reads finish, so the town fills in while a big first read is still running. The signals of a stale source drop out; the building greys only when none of its health sources is fresh.
- **Restarts.** After every poll each source's newest readings are saved under `_discovered/readings/<environment>/` in the town's folder. When the server starts they are read back with the time they were taken, so a restart within a source's freshness window (twice its poll interval) carries on from the last picture; older readings come back stale, as they would have. Keep the folder out of version control.

To try entries offline, keep recorded series in the town folder, `{ "<resource name>": [ { "metric": "...", "aggregation": "average", "filter": null, "points": [40, 44, 42] } ] }`, and point the source at it with `file:`. `scope-town-a` and `scope-town-b` do this with two differently shaped sets of entries (percentages and request units over provisioned throughput; cores and bytes over limits and a normalised consumption metric) and show the same town.

#### `servicebus` (backlog and dead letters)

| | |
| --- | --- |
| Permission | Monitoring Reader on the namespaces |
| `connection` | Nothing: the namespaces are the resources a `scope.resources` rule finds. `file:name.json` replays recorded series kept beside the town's files |
| `entities` | Required: without it the source refuses to start. Which rule finds the namespaces and which metrics are the backlog and the dead letters (below) |
| `pollSeconds`, `timeoutSeconds` | 60 suits it, with a `window` of a few minutes (the example in the config reference uses `15m`) |
| Fills | `backlog` and `deadLetters` of the systems that consume each entity (point `signals: { backlog: ..., deadLetters: ... }` at it, or call the source `messaging`) |

The source reads the Azure Monitor platform metrics of each namespace, split by entity (queue or topic) name. The program knows no metric name and no naming convention; the `entities:` block says them:

```yaml
sources:
  messaging:
    kind: servicebus
    pollSeconds: 60
    window: 15m
    entities:
      resources: broker                       # a scope.resources rule that finds the namespaces
      backlog: { metric: <active messages metric>, aggregation: average }
      deadLetter: { metric: <dead-lettered messages metric>, aggregation: last }
      patterns:                               # the first that matches decides
        - { match: '^(?<pillar>[a-z]+)\.(?<service>[a-z]+)\.in$' }
      deadLetterLink: { name: Open in queue explorer, url: "https://queues.example.test/queues/{queue}?env={environment}" }
signals: { backlog: messaging, deadLetters: messaging }
```

- **Entity to consumer.** Each pattern is a regular expression over the entity's name: `service` (required) is the service code of the system that reads it, `pillar` (optional) the code or id of its pillar, and `consumer` the role of the reader (`worker` by default). An entity no pattern claims, or no system consumes, is left out. A name that also says its publisher (`producerGroup`, older name `producerPillar`, and `producer`) adds that topic and subscription to the town on every poll, with no `messaging:` block needed in the pillar file.
- **Regions.** A system's backlog is what waits in all its entities, in every namespace the rule finds (one for each region), added up. A namespace that cannot be read fails the poll, so a number made from only some of them never shows.
- **Optional keys.** `dimension` (the metric dimension that holds the entity's name, `EntityName` by default), `interval` (the time grain), `throughput` (incoming messages: sets how many boats sail to the consumer), `flows` (entities that carry a group's whole traffic in or out, for example an outbound topic, for the Message flow numbers) and, on the source, `typesQuery` (a Log Analytics query that lists the kinds of message each queue handled).
- **Dead-letter links.** `deadLetterLink` (`{ name, url }`) puts a link to your queue explorer on each queue in its consumer's drawer. The url is a template over `{queue}`, `{pillar}`, `{service}`, `{system}` and `{environment}`. For a broker with namespaces in several regions and a tool for each, `deadLetterLinks` is a list of `{ region, name, url }`; a region with no entry uses `deadLetterLink`. Without either, no link.
- **Queue page links.** `queueLink` (`{ name, url }`) puts a link to the queue's own page in your cloud portal next to it. The url is a template over `{namespaceResourceId}` (the id of the namespace that holds the queue), `{queue}`, `{region}` and the words above, so one line covers every environment and region; a queue in the namespaces of two regions gets one link for each.
- **The check.** The `--sources` probe for `servicebus` does not test what this adapter reads: it lists topics on the namespace host named in `connection` (which needs Manage). A source set up as above has no connection, so it reports *not configured*, which is not a failure, and says nothing about whether the metrics read works. Watch the town and the server log instead.

Every key, with its default, is under `entities` in the [config reference](config-reference.md).

### Links: find the calls your systems make

Declared `calls` and `gatewayCalls` are always drawn. An environment can also find the rest from its dependency data: add a `links:` block to its file (see `links` in [config-reference.md](config-reference.md)). It names a source of the file whose kind can read dependencies (with the Azure adapter, a `loganalytics` source) and a query template that returns one row for each caller and address, with the days it was seen on (`make_set(startofday(TimeGenerated))` in KQL), so the store does the counting and no raw data comes back. Your own rules turn an address into a system: a regular expression over the host (and over the path, for a gateway that names the destination in it) with named groups, and a `target` template such as `{pillar}.{service}`. Nothing about names is built in.

- It runs in the background and never holds up the town, while someone views the environment (see [step 6](#6-watch-the-town)). The first read looks back `firstRead` (7 days); after that each start reads only the gap since the last read, then once every `interval` (1 hour). When the rules, the ignore list, the aliases, the third parties' domains and matches or the town's systems change (including a rule or vendor added from the Unknown hosts panel), the next read looks back the whole `firstRead` window again for every name, so a new rule shows its links at once instead of only for new calls. Edits made by hand to the files are picked up at the next scheduled read; the panel asks for the read straight away.
- A link needs both ends to be systems of the town and `minDays` (2) different days in the data. A link not seen for `keepFor` (30 days) drops off.
- Found links are saved under `_discovered/links/<environment>/` in the town's folder, one file for each pillar, with the days seen. Your pillar files are never edited. Keep the folder out of version control: the upstream `.gitignore` covers only `config/**/_discovered/`, so a town kept outside the clone needs `_discovered/` in its own private repository's `.gitignore`.
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

**Services that call the town.** In a hub-and-spoke town with a gateway, a service that is not a system of the town may itself call town systems through the gateway. List the telemetry names its calls are recorded under, one for each instance, as `roles` on the service:

```yaml
      - { id: portal, name: Portal, match: [{ host: shared.example.test, path: '^/portal' }], roles: ["Portal.Instance.One", "Portal.Instance.Two"] }
```

Link discovery and the traffic read then ask about those names as well as the town systems', and resolve the calls with the same `links.rules`. What follows needs no extra setting: the service is drawn calling the town system, its calls are counted as a known caller (so they leave the airport's outside traffic), the Dependencies layer gets an arc from its island, and cars drive from the island round the ring road, through the airport (which has a back gate and a side road for this), over its bridge to the hub and through the gateway to the system. The names are exact; list every instance. A hub-and-spoke town only: a direct town has no hub, so the cars drive round the ring road to the island. Hosts that calls go to and no rule explains are listed in the **Unknown hosts** panel (a button next to Notices), grouped by host with the calls, the systems that made them and the days seen, and each plain host has three buttons: **Add vendor** (a third party), **Add internal** (one of the company's own services, saved with `internal: true`) and **Ignore**. A click makes the server save the host in `_discovered/third-parties.yaml` (the app writes only under `_discovered/` in your town folder, never your own files; list `_discovered/` in your private repository's `.gitignore`), load the town again and take the host off the list, with no restart. That file has the same shape as `third-parties.yaml`: a `vendors:` list with the same keys (a new vendor starts with its host as its name; edit the file to give it a proper name, an SLA, services and so on) and an `ignoreHosts:` list like the environment file's. A save keeps every key of every vendor, but not comments, and a change you make to the file by hand is loaded within a few seconds, with no restart. The town reads it next to `third-parties.yaml`; when both have the same id the config file wins, and the ignored hosts are added to the `links.ignoreHosts` of every environment. A host that a `links.rules` entry reads the path of (a shared gateway) is listed by the paths no rule explains; for each one pick the system it belongs to, how many parts of the path name it (two by default) and whether its calls go through the gateway (ticked by default), and press **Add rule**: the rule (the host, the path to that depth, the system, and `gateway` as ticked) is saved under `rules:` in the same file and tried after the environment's own rules, so that part of the path explains every call under it (widen or narrow the pattern in the file if you need to). What was added is listed under the hosts as **Added from this panel**, each with a **Remove** button (the button stays while that list has anything in it). A vendor needs a system of the town that was seen calling the host, and it is called by those systems; a host only vendor buildings called can only be ignored. Calls made only by vendor buildings are left out of the Notices and hidden in the panel until you tick *Include calls made by the town's internal services and vendors*. Nothing is added without a click.

#### Where an API's traffic comes from

An API's total request rate comes from your unsampled metrics. With a `links.traffic` block (see `links` in [config-reference.md](config-reference.md)) the town also learns how much each town system sends to it, from the same dependency table: the query returns one row for each caller and address over the last `shareWindow` with `calls` summed from the sampling-corrected count (`sum(ItemCount)` in KQL). The rest is outside traffic:

> outside = the API's measured total, less what the town systems that call it send (never below zero)

The callers' calls are counted over the whole `shareWindow`, so the town compares them with the API's own rate averaged over that same window (it keeps a rolling mean of it). To be steady from the first minute after a start, the town asks once, when it starts, for each API's average rate over the share window. It asks the environment's own telemetry query again with `{window}` set to the share window, so there is nothing new to write. That average stands in until the town has ten minutes of its own history. A source that cannot answer (a recording, or a failed read) leaves the split on the current rate until then, and the town asks again on its next read. The outside share is worked out from that mean and applied to the current rate. Otherwise an API with few calls, whose last few minutes jump about, would show a steady caller as outside traffic whenever a busy few minutes came along.

- Every API gets its own outside part, not only the ones marked `external`: whatever the town does not explain arrives at the airport. A caller is only known when it is a town system whose own calls the query sees, so a system with `discoverLinks: false` looks like an outside caller.
- If the callers would add up to more than the API receives (the two are measured differently), they are scaled down together.
- Below `minCalls` observed calls to an API the share is too noisy: the last good share stands and the inspector marks it "estimated". There is no setting for a share; every number is measured.
- Without a `traffic` block nothing is measured: each API's rate is shared evenly between the systems that declare a call to it (and the outside, when it is marked `external` or an outside caller reaches it).

### Logs tab: failed and slow requests, warnings, exceptions

A system's inspector has a Logs tab. In a live town it is empty of everything until you write a `logs:` block in the environment file (see `logs` in [config-reference.md](config-reference.md)); without it the tab says logs are not set up. With it, opening the tab sends one query for that system's telemetry name over the last `window` (4 hours by default) to the source you name: one whose kind can read logs (with the Azure adapter, a `loganalytics` source). Nothing is polled, nothing is stored, and the tab never changes a building's colour: health comes from your unsampled metrics.

The query is yours (which table, which columns, which status counts as a failure). It returns one row for each kind of entry, already grouped by the store, with a `section` column saying which of four lists it belongs to:

- `failed`: requests that answered with a 5xx.
- `slow`: requests over the system's own latency line, passed to the query as `{slaMs}` (the `slaP99Ms` of the defaults cascade).
- `logs`: warnings and errors, including start-up.
- `exceptions`: exceptions.

Repeats come back as one row with a `count`, and the tab shows them newest first. A worker (or anything that does not answer requests) is shown only `logs` and `exceptions`. `links` put a link in the header of a section (say `failed` or `exceptions`) that opens your telemetry store's own search, already filtered to the system and the window. Each link names a `scope.assets` rule (for example the rule that finds your telemetry store's resources; on Azure, Application Insights); every resource the rule finds gets its own link, so a primary and a standby store both show. The address is a template that you write out in full (`{resourceId}`, `{resourceIdTwice}` (the id percent-encoded twice, for portals that nest it), `{resourceName}`, `{role}`, `{from}`, `{to}`, `{windowMs}`). If you later move to another logging store, only the adapter behind the source changes.

### Function apps and regions

A system with role `function` (`cron` still works as an alias) stands as a function building. Three things in the environment file make it say more:

- **App state.** Give the resource rule a `state` expression (a query expression that reads the app's state as text) and `running` (the values that mean it runs). A running app is lit; a stopped one stands under construction; a system the inventory has no such app for is grey, "not found in the inventory". The core knows no state words.
- **Jobs.** A `functionjobs` source runs a query that summarises the function apps' logs into one row per app and job, with the columns `resourceId`, `job`, `lastRun`, `succeeded` and `next` (and `region` where it matters). Point `signals: { jobs: <source> }` at it. Each job shows as succeeded, failed or overdue (now later than `next` plus the source's `lateAfterSeconds`, which defaults to, and is never less than, the source's freshness of twice its poll interval), and the building's beacon follows: amber when a job failed or is late (the app runs and the other jobs may be fine), red only when every job failed. How your logs word a run is yours to say in the query:

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

  Which services each job starts work for is said in the pillar file, under `scheduler:`: an entry names a function system of that pillar and, for each job (as the logs name it), the services of the same pillar it feeds, for example `scheduler: [{ system: statement-cron, jobs: { nightly-run: [statements] } }]`. `validate` checks that the system is a function of the pillar and that the services are the pillar's. A job not listed sends no boats.

- **Regions.** A service that runs in two or more regions shows its worst region (by processor and memory) on the building; the drawer can switch between the worst region and each region in turn. The `scope.regions` block names where a region is read from (`tag`), how it is labelled (`names`), and how lopsided a split of requests may be before it is flagged (`skew`).
  - **Where each region's share comes from.** Give the `loganalytics` source a `regionQuery` that returns one row per app role and region with the number of `calls`. Counts are enough, even sampled ones, since only their proportions are used. The sign and the drawer show the split ("East 90% · EU 10%"), and a region over `skew` (0.9 by default; 1 never flags) gets a warning while another region still runs instances. Without a `regionQuery` there is no split and nothing is shown for it.
  - **The switch.** The building shows one region at a time: the worst one, or the one picked in the drawer. There is no combined view, since adding up two regions' instances and averaging their processors would hide the one that is in trouble. A region the cloud does not report an instance count for adds nothing and is never shown as "unknown".

### The cloud's own word on a resource's health

A `resourcehealth` source reads the cloud's health reports (on Azure, the activity log's ResourceHealth entries) for the resource providers you list, and shows them where the resource is found. The program names no provider; you do:

```yaml
sources:
  health:
    kind: resourcehealth
    providers: [<Namespace.Service>]   # the providers whose reports to read, as the cloud names them
    window: 3d                         # how far back the log is read (default 3d, so a problem that lasts days is still listed)
    keepResolvedFor: 4h                # how long a resolved report stays listed, in green (default 4h)
    pollSeconds: 300
```

The source fills no signal, so nothing else is wired. It asks each subscription the scope found, once for each provider that the inventory shows has resources in that subscription (a subscription with no resource of a provider is not asked for it), and ties a report to the building that owns the resource through `scope.resources` (the resource id, case aside). What it shows:

- **Open reports** (Degraded or Unavailable) put a red exclamation mark above the building, a line in the Overview tab of its drawer (state, since when, what it was before, the cause), a red "<cloud> incident" label on its row of the dashboard (the name from `scope.cloud`, else "Cloud"; open reports only), and an entry in the top bar's **Incidents** list that goes to the building. They count in the incident number. A report no building owns is still listed, and goes nowhere.
- **A report ends** when the log says it resolved or the resource is Available again, and also when the cloud's current status for the resource says Available even though no resolution reached the log. It then stays listed for `keepResolvedFor`, in green, with when it began and when it ended; the mark on the building goes away at once and it no longer counts as an incident.
- **The dashboard's Incidents card** lists each report with the system's own name as the service table shows it (and the tenant, for a store kept per tenant), its state, the cause the cloud gave and when it began and ended.
- **Dismiss** (a button in the list and in the drawer) hides one report, open or resolved, for everyone until the server restarts.
- If the log cannot be read at all, the last good list stays and a notice says so. If only some reads fail (a slow subscription, a denied one), the reports from the reads that worked are shown, the reports of the failed subscription and provider are kept from the last good round, and the notice says how many reads failed, so the list may be incomplete. The notice goes away after the next round where every read works.
- Each round writes one line to the server log, for example `health read: 12 reads, 0 failed, 3 reports (1 open)`, so a slow or half-empty round can be seen.
- At startup the source needs the inventory to know where to look. Until the inventory is read, it tries again every 30 seconds instead of waiting a whole `pollSeconds`, so reports show soon after the inventory arrives. A round may take up to `timeoutSeconds` (60 by default); raise it if your subscriptions are many or slow.

Needs the sign-in to be allowed to read the activity log of each subscription (Monitoring Reader or the like) and the resource's own health status.

### Basic buildings (secrets stores, storage, config stores) and the cloud's name

`scope.assets` lists rules for resources that have no health of their own but belong in the town. Each rule has a `name`, the `label` shown on its card, a `shape` (`vault`, `store`, `settings` or `box`), the resource `types` it matches and a `pattern` that names the pillar (and the service, when the resource belongs to one) with the same groups as the system rules. A resource tied to a service stands behind that service's pad; the others stand in the pillar's back yard. Clicking one opens a card with its name, type, owner and the portal links from `scope.links`. The inventory query includes the rules' types, so no other change is needed.

Shared resources that belong to no pillar (a telemetry workspace, say) stand on the hub island: give the rule `island: hub` and a `group`, the name of the cluster they stand in, shown on a sign (rules with the same group share a cluster). If they live in an account of their own, add `account: { nameLike: "..." }` (or `tag`; Azure name `subscription`), a template over your `variables` and `{environment}`. The card has no health, only the portal links.

The hub's own systems (the gateway, the message broker) get their portal links the same way as any system: give the system a `serviceCode` in `hub.yaml`, and add a `scope.resources` rule for its resource type with `roles: [gateway]` or `roles: [broker]` and a `pattern` whose `service` group matches that code. The hub is not a pillar, so say where the rule looks with its own `account` (`nameLike` or `tag`; Azure name `subscription`); a rule that finds several resources (one for each region) gives the system one link for each. When the hub holds buildings of its own (`island: hub`), the hub island grows just enough to give each group a place.

`scope.cloud` is the name of your cloud as the town should say it (for example `Azure`, `AWS` or `Cumulus`). It is used in the words "not found in <cloud>" and "<cloud> incident", and nowhere else; the core assumes no cloud.

A demo town needs no cloud for any of this: `fake.yaml` takes `regions: { <name>: <weight>, ... }` on a service, and `fake-assets.yaml` lists the buildings by pillar, name, label, shape and service.


### What each adapter's runbook section contains

An adapter's section says the permission the login needs, the `connection` value, the `pollSeconds` and `timeoutSeconds` that suit it, and what it fills. `resourcegraph`, `loganalytics`, `azuremonitor` and `servicebus` have that table above; `functionjobs` and `resourcehealth` are described in prose, with their permissions in [step 2](#azure-adapter). What `--sources` reports for each kind is in [step 5](#5-run-the-check). `prometheus` and `grafana-irm` have no section because nothing reads them yet: the core knows the names, and no module has an adapter for them.

## 5. Run the check

```
dotnet run --project backend/tools/ObservabilityCity.Validate -- --sources <company-config>
```

For each environment and signal it makes one cheap read with the source's own login (for Azure sources, your Azure login) and says one of:

| Result | Means | What to do |
| --- | --- | --- |
| connected | It answered with data | Nothing |
| no permission | Refused (401/403), or no login or token | Sign in (Azure: `az login`), check the role, set the token variable (`GRAFANA_TOKEN`) |
| query returned nothing | It answered but had no data | Wrong workspace or endpoint, or nothing is reporting yet. Not a failure unless you pass `--strict` |
| unreachable | No answer, an error, or a timeout | Check the address, VPN, firewall |
| not configured | The environment has no source for this signal, or (for `servicebus`) the source has no `connection` | Fine; the town leaves an unset signal out |
| unknown kind | The kind is spelt wrong or has no probe | The message lists the kinds it knows |
| no probe yet | A loaded module knows the kind but the check has no probe for it (`resourcegraph`, `azuremonitor`, `functionjobs`, `resourcehealth`) | Nothing; not a failure. Check it in the town |

The exit code is 1 when anything is *no permission*, *unreachable* or *unknown kind* (and, with `--strict`, *empty*), so you can run it in a pipeline.

A `loganalytics` source with no `connection` is probed with the workspace its environment's scope names as its telemetry store: `scope.telemetryStoreId` (or `workspaceId`) as it is, else `scope.telemetryStore` (or `workspace`; an id as it is; a name or wildcard is looked up through Resource Graph, and none or several matches are reported with the names).

The Azure login keeps each token until shortly before it expires, and asks for one at a time per scope, so a login that starts a process for every request (`az login`) is not started once per read.

The normal registry check (`-- <company-config>`) validates the files, including source names, kinds, logins and signal choices, and warns about a signal pointed at a source the environment does not define. `--sources` reads the environment files directly and reports every source you defined. Only `fake`, `prometheus`, `loganalytics`, `servicebus` and `grafana-irm` have a probe; `resourcegraph`, `azuremonitor`, `functionjobs` and `resourcehealth` report *no probe yet*. A `servicebus` source set up the way the adapter wants it (no `connection`) reports *not configured*. So a clean `--sources` does not prove that the inventory, `azuremonitor` or `servicebus` reads work: check those in the town and the server log.

## 6. Watch the town

```
dotnet run --project backend/src/ObservabilityCity.AppHost
```

Open http://localhost:5173, pick your town in the top bar, then the environment. Check a few buildings against the tool you trust today. Use **Break things** on the fake sample town to learn what each light, floor and beacon means before you read your own.

An environment polls its sources only while a browser views it, and for 2 minutes after the last one leaves; link discovery and the traffic read pause with it. So a town opened cold starts from the readings saved at the last poll (stale if they are older than the source's freshness) and fills in over the first poll. `Polling:AlwaysOn=true` (`Polling__AlwaysOn`) keeps every environment polling whether or not anyone looks.

### Hosting

Hosting with sign-in is a later phase (see the [plan](observability-city-plan.md)). Until then, if you run it anywhere but your own machine:

- **No authentication.** No endpoint asks who you are, including the ones that write (the Unknown hosts panel saves into the town folder). Put the app behind your own sign-in and network rules.
- **Host names.** `AllowedHosts` in the host's `appsettings.json` allows only `localhost`, `127.0.0.1` and `[::1]`; set `AllowedHosts` to the name the app is served on.
- **Browser origins.** A request from a browser page whose origin is not this machine is refused unless that origin is listed in `Security:AllowedOrigins` (`Security__AllowedOrigins__0`).
- **A writable `_discovered/`.** The process must be able to write `<town>/_discovered/` (saved readings, found links, `third-parties.yaml`).
- **The login.** With the Azure adapter, define a `default` credential of kind `managed-identity` in each environment file, or the server tries the Azure CLI login (see [step 2](#azure-adapter)).
- **Polling.** Set `Polling:AlwaysOn=true` if the town should be warm when someone opens it.

## 7. Then the next environment, the next signal

Repeat steps 4 to 6 for the next signal, then copy the environment file for staging and prod. Commit your town folder in its own private repository (or on a branch of your private copy), never in a public one.

## Send a generic fix upstream

If you found a bug or a missing capability that is not specific to your company:

```
git fetch upstream
git checkout -b fix/short-description upstream/main
# make the change in core, with tests on both sides (backend xUnit, frontend Vitest / Playwright)
git push -u <your-public-fork> fix/short-description
gh pr create --repo dcarles/ObservabilityCity --base main
```

Rules for the upstream pull request: no company names, tenant ids, hostnames or screenshots of your town; examples use generic names; tests use fakes and recorded fixtures, never live services. Once it is merged, `git fetch upstream && git merge upstream/main` brings it into your copy. A fix that only makes sense at your company stays in your town folder or `extensions/`. For an upstream pull request, push the branch to a separate public fork that never holds company files, and open the pull request from it.

## When something goes wrong

- **No login** (`no permission`): sign in again. With the Azure adapter (the message says "run az login"): `az login`, then `az account show` to confirm the subscription.
- **Everything unreachable:** try the address in a browser or with `curl`; a corporate proxy or VPN is the usual cause.
- **The town is empty or grey:** grey means configured but no fresh data; run `--sources` and fix whatever is not *connected*.
- **The status says "No update for over 45 s" and the page is grey:** the browser has received no snapshot for 45 seconds, though the server sends one at least every 15. The connection may look open, but the town's data cannot be trusted. The page recovers by itself when snapshots arrive again; if not, look at the Aspire log for the host.
- **Registry errors:** the message names the file, line and rule. The README lists every rule.
