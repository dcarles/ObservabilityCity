# Config reference

Every key you can write in a town folder, file by file. For the order to do things in, read [Connect your company](connect-your-company.md) first; this page is the lookup.

Your editor can check most of this as you type: each sample file starts with a `# yaml-language-server: $schema=` line that points at the files in `schema/`. `dotnet run --project backend/tools/ObservabilityCity.Validate -- <folder>` checks the whole folder, including the rules an editor cannot see.

**Required** means the file is rejected without the key. **Optional** keys can be left out; the default says what happens then. Keys are written in camelCase. A key the loader does not know is an error, so a typo never passes silently.

A town folder looks like this:

```
town.yaml          required   the town's name and kind
defaults.yaml      optional   thresholds per role
layout.yaml        optional   where the islands stand
hub.yaml           optional   shared resources in the middle
third-parties.yaml optional   vendors outside the town
pillars/<id>.yaml  required   one island each (at least one)
environments/<id>.yaml        one per environment (live towns)
fake.yaml, fake-assets.yaml, stories/   demo towns only (mode: demo)
```

Thresholds cascade: `defaults.yaml` (per role) → the pillar's `defaults` → the system's own keys. The nearest one wins.

## town.yaml
<!-- file: TownFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `id` | yes | | Short id of the town. |
| `name` | yes | | Name shown in the top bar. |
| `groupLabel` | no | `Group` | What one island is called in the interface (for example Pillar, Domain, Team). |
| `topology` | no | `direct` | `direct`: islands are linked by an outer ring road. `hub-and-spoke`: islands call each other through a gateway on the hub. |
| `mode` | no | `live` | `demo` gives the town a fake source, the Break things panel and the story bar. `live` never does. |
| `trafficDensity` | no | `1` | How many cars appear, as a multiple of the usual number: `1` is the usual look, `2` twice as many, `0.5` half. From `0.25` to `10`. A weak PC still lowers it with the quality setting, and the town never shows more than 420 cars at once. |
| `expectedWarnings` | no | none | Warnings the validator should expect, for a test folder that shows a rule on purpose. |

<!-- file: ExpectedWarningFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `rule` | yes | | The name of the rule that warns. |
| `file` | no | any file | Limit the expectation to one file. |

## defaults.yaml and a pillar's `defaults`
A map from a role name (`api`, `worker`, `db`, `cache`, `cron`, `gateway`, `broker`, `egress`, or one of your own) to the values below.

<!-- file: RoleDefaultsFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `slaP99Ms` | no | none | The 99th-percentile latency (ms) the role should stay under. |
| `errors` | no | none | `amber` and `red` share of failed requests (0 to 1). |
| `resources` | no | none | `amber` and `red` for CPU, memory or a data store's utilisation (0 to 1). |
| `throttle` | no | none | `amber` and `red` for the share of throttled requests (0 to 1). |
| `backlog` | no | none | `amber` and `red` for the age of the oldest waiting message, in seconds. |
| `minCalls` | no | none | The fewest calls in a window that make the error share and latency worth judging. With fewer the system is quiet, not red. |
| `discoverLinks` | no | `true` | Whether link discovery looks for the calls systems of this role make. Only an `api` or a `worker` makes calls worth finding; it does nothing in an environment without a `links` block. |

<!-- file: ErrorThresholdsFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `amber` | no | none | Value at which the light turns amber. |
| `red` | no | none | Value at which the light turns red. |

## pillars/&lt;id&gt;.yaml
One island. The file name is the pillar id.

<!-- file: PillarFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `pillar` | yes | | The pillar id. System ids are `<pillar>.<system>`. |
| `displayName` | yes | | Name on the island's sign. |
| `color` | no | `#8ab4ff` | Island colour. |
| `external` | no | `false` | The pillar is outside the company (a vendor island). |
| `defaults` | no | none | Role thresholds for this pillar (same shape as `defaults.yaml`). |
| `signals` | no | none | Signal → source name (or `none`) for every system of the pillar. |
| `systems` | yes | | The pillar's systems, below. |
| `messaging` | no | none | Outboxes it publishes and topics it consumes, below. |
| `scope` | no | none | How the pillar is spelt in an environment's scope rules. |

<!-- file: PillarScopeFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `code` | no | the pillar id | What `{pillar}` stands for in scope rules. |

### A system (pillar `systems`, hub `resources`)
<!-- file: SystemFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `id` | yes | | Id within the pillar. |
| `name` | no | the id after the dot | Name on the building. |
| `role` | yes | | `api`, `worker`, `db`, `cache`, `cron`, `gateway`, `broker`, `egress` or your own; picks the defaults and the building. |
| `service` | no | none | Systems with the same service are drawn together as one block. |
| `tenantPattern` | no | none | For a store with one database per tenant: its name with `{tenant}` where the tenant id goes. |
| `external` | no | `false` | The system belongs to someone outside the company. |
| `slaP99Ms` | no | role default | Latency target for this system. |
| `errors` | no | role default | Error thresholds. |
| `resources` | no | role default | Resource thresholds. |
| `throttle` | no | role default | Throttling thresholds. |
| `backlog` | no | role default | Backlog thresholds. |
| `minCalls` | no | role default | See above. |
| `discoverLinks` | no | pillar or role default | See above. Set `false` on a system whose calls should only be the declared ones. |
| `signals` | no | none | Signal → source name (or `none`) for this system alone. |
| `serviceCode` | no | the service | The name its cloud resources carry for the service. |
| `telemetry` | no | none | What the telemetry calls it. |
| `calls` | no | none | Ids of the systems this one calls. Cars drive only along declared links. |
| `gatewayCalls` | no | none | Systems on other islands reached through the gateway (hub-and-spoke towns). |
| `aliases` | no | none | Former ids of this system, so other files may still use them. |

<!-- file: TelemetryFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `role` | no | the environment's `scope.telemetryRole` | The name the telemetry gives this system. |

### messaging (pillar or hub)
<!-- file: MessagingFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `topics` | no | none | Pillar: service names, each published as `<pillar>-<service>-outbox`. Hub: free names, each published as `hub-<name>`. |
| `subscriptions` | no | none | The topics this pillar's workers consume. |

<!-- file: SubscriptionFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `topic` | yes | | Full topic name. |
| `consumer` | yes | | A worker in this pillar. |
| `legacy` | no | `false` | A read of the hub's egress topic, the old way. Drawn with an amber pennant. |

## hub.yaml
<!-- file: HubFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `displayName` | no | `Hub` | Name of the middle island. |
| `color` | no | `#f5c26b` | Its colour. |
| `resources` | no | none | Shared systems (same shape as a pillar system). |
| `externalCallers` | no | none | Who calls in from outside, drawn at the airport. |
| `messaging` | no | none | The hub's own topics. |

<!-- file: ExternalCallerFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `id` | yes | | Id of the outside caller. |
| `name` | no | the id | Name shown. |
| `calls` | no | none | Ids of the systems it calls. |

## layout.yaml
<!-- file: LayoutFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `islands` | no | file order | Island ids in the order round the hub. |
| `ringCapacity` | no | built-in | Islands on the first ring. The second ring holds one fewer, since the airport takes a place there. |

## third-parties.yaml
<!-- file: ThirdPartiesFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `vendors` | no | none | The vendors outside the town. |

<!-- file: VendorFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `id` | yes | | Vendor id. |
| `name` | no | the id | Name shown. |
| `calledBy` | no | none | Ids of our systems that call it. Its health is read from those calls. |
| `slaP99Ms` | no | none | Latency target. |
| `errors` | no | none | Error thresholds. |
| `domains` | no | none | Host names (and everything under them) that belong to this vendor. Link discovery recognises a call to one as a vendor call instead of reporting it as unresolved. |
| `internal` | no | false | The company's own services outside the monitored platform, not a third party. The island and its buildings carry an "internal" label. |
| `services` | no | none | The vendor stands on one island with a building for each service (a vendor with services needs no `calledBy`; put it on each service). Without services the vendor is one building on its own island. A service's building id is the vendor id, a dash and the service id. |

<!-- file: VendorServiceFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `id` | yes | | Short id of the service. |
| `name` | no | the id | Name shown. |
| `match` | yes | | The addresses that mean a call to this service: entries with a `host` and an optional `path`. A call matching any entry belongs to it; the first service that matches wins. Link discovery draws the callers it finds from those calls. |
| `calledBy` | no | none | Ids of our systems that call it, besides the ones link discovery finds. |
| `slaP99Ms` | no | the vendor's | Latency target. |
| `errors` | no | the vendor's | Error thresholds. |

<!-- file: VendorMatchFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `host` | yes | | A host name. The host itself and everything under it match. |
| `path` | no | any | A regular expression the call's path must match. |

## environments/&lt;id&gt;.yaml
One file per environment. The pillar and system files are shared; this file says what differs: where the numbers come from, which tenants exist, which systems are not deployed.

<!-- file: EnvironmentFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `name` | no | the id | Name in the environment picker. |
| `order` | no | 100 | Place in the picker, lowest first; ties go by id. |
| `default` | no | `false` | The environment shown when none is asked for. Without one, the first. |
| `sources` | no | none | Where numbers come from, by source name. `metrics`, `incidents` and `messaging` are the defaults for those groups; any other kebab-case name can be pointed at by a signal. |
| `credentials` | no | Azure CLI login | How sources sign in, by name. |
| `signals` | no | none | Signal → source name (or `none`) for the environment. |
| `tenants` | no | none | The tenants listed here. Others are found from the cloud when a scope allows. |
| `exclude` | no | none | Ids of systems not deployed in this environment. |
| `fake` | no | none | Settings for the fake source only. |
| `links` | no | none | How the calls the systems make are found in the telemetry (see `links` below). |
| `logs` | no | none | Where a system's Logs tab reads from (see `logs` below). Without it the tab says logs are not set up. |
| `scope` | no | none | How pillars and systems map onto the cloud. |

<!-- file: TenantFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `id` | yes | | Tenant id as it appears in database names. |
| `name` | no | the id | Name shown. |
| `kind` | no | `customer` | `customer` or `test`. A test tenant is amber at worst. |

<!-- file: EnvironmentFakeFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `undeclaredTenants` | no | none | Tenants the fake source finds that the list does not name. |

### sources
<!-- file: SourceFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `regionQuery` | no | none | `loganalytics`: the query that says how a service's requests divide between regions: one row per telemetry name and region with the columns `role`, `region` and `calls`. Sampled counts are fine, only the proportions are used. Same template holes as `query`. With it each region shows its share of the requests. |
| `kind` | yes | | `fake`, `resourcegraph`, `loganalytics`, `azuremonitor`, `functionjobs`, `servicebus`, `prometheus` or `grafana-irm`. |
| `connection` | no | from `scope` | How to reach it (a workspace id, an endpoint). Not used by `fake`. |
| `credential` | no | Azure CLI login | A name from `credentials`. Azure sources only. |
| `pollSeconds` | no | 30 | How often the source is asked. Above 0. |
| `timeoutSeconds` | no | 10 | How long one ask may take. Above 0. |
| `query` | no | none | `loganalytics`: the query to send, a template; `functionjobs`: the query that summarises the function apps' logs into one row per app and job (columns `resourceId`, `job`, `lastRun`, `succeeded`, `next`, `region`). `{window}`, `{windowSeconds}`, `{roles}`, scope variables and `{environment}` work. |
| `window` | no | `5m` | `loganalytics` and `azuremonitor`: how far back one answer looks. |
| `metrics` | no | none | `azuremonitor`: which metric of which resources fills which signal. |

### metrics entries (`azuremonitor`)
<!-- file: MetricGroupFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `resources` | yes | | Name of a `scope.resources` rule. The resources it finds for a system are the ones asked. |
| `namespace` | no | none | Metric namespace, for a resource type with more than one. |
| `interval` | no | `1m` | Time grain: `1m`, `5m`, `15m`, `30m`, `1h`, `6h`, `12h` or `24h`. Some metrics do not support a minute. |
| `window` | no | the source's `window` | How far back this entry looks. Must hold at least two points of the interval. |
| `cpu` | no | none | CPU share used. |
| `memory` | no | none | Memory share used. |
| `utilisation` | no | none | Capacity used (a store's request units, for example). |
| `throttled` | no | none | Share of requests refused for lack of capacity. |
| `requests` | no | none | Request rate, shown per tenant database. |
| `limit` | no | none | Provisioned capacity as a plain number, shown beside each tenant database. Not a health signal. |

<!-- file: MetricSignalFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `metric` | yes | | The metric's name as the cloud spells it. |
| `aggregation` | no | `average` | `average`, `total`, `count`, `maximum` or `minimum`: how the points of the window are added up. |
| `filter` | no | none | A dimension filter, for example `StatusCode eq '429'`. |
| `scale` | no | 1 | Multiplies the value. The town reads fractions, so a percentage needs `0.01`. |
| `perSecond` | no | `false` | Divide a total by the window's seconds, to get a rate. |
| `over` | no | none | Another metric to divide by (capacity, all requests), to give a share. |
| `orElse` | no | none | Another metric to read when this one gives no number or 0. It cannot have its own `over` or `orElse`. |

Example (a database account with an autoscale ceiling, falling back to fixed throughput):

```yaml
sources:
  platform:
    kind: azuremonitor
    window: 15m
    metrics:
      - resources: accounts
        interval: 5m
        window: 1h
        utilisation: { metric: NormalizedRUConsumption, aggregation: maximum, scale: 0.01 }
        limit:
          metric: AutoscaleMaxThroughput
          aggregation: maximum
          orElse: { metric: ProvisionedThroughput, aggregation: maximum }
```

### links
Finds the calls the systems really make, from the dependency data in the telemetry, and adds them to the declared `calls` and `gatewayCalls`. Without this block an environment has only the declared links.

<!-- file: LinksFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `source` | yes | | Name of a `loganalytics` source of this file. Its workspace and login are used. |
| `query` | yes | | The query to send, a template. Holes: `{roles}` (the telemetry names of the systems asked about, double-quoted, separated by commas), `{from}` and `{to}` (UTC, ISO 8601), `{environment}` and your `scope.variables`. It returns one row for each caller and address with the columns `caller` (a telemetry name), `host` and `days` (an array of the days it was seen on); `path` and `calls` may be left out. Azure does the counting; no raw rows come back. |
| `interval` | no | `1h` | How often it reads, for example `30m`. A number and `s`, `m`, `h` or `d`. |
| `firstRead` | no | `7d` | How far back the first read looks, and the longest gap a later read covers. After that each read starts where the last ended. |
| `minDays` | no | `2` | The fewest different days a call must be seen on to be drawn. |
| `keepFor` | no | `30d` | How long a link stays after it was last seen. |
| `ignoreHosts` | no | none | Regular expressions for addresses that are platform noise. |
| `rules` | no | none | The ways an address becomes a system, tried in order. |
| `aliases` | no | none | Words the address uses that the registry spells differently, applied to every captured group. |
| `traffic` | no | none | Measures how much each town system sends to each API, so the outside traffic can be told from the rest (see below). Without it the split is not measured. |

<!-- file: LinkRuleFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `host` | yes | | A regular expression over the host, with named groups `(?<name>...)`. |
| `path` | no | none | A regular expression over the path, for a gateway that names the destination in it. |
| `target` | yes | | The system id, written with `{name}` holes for the named groups and `{callerPillar}` for the pillar of the caller. A rule whose result is not a system of the town is skipped. A captured group named `service` may hold the service's name or its `serviceCode` (in the pillar the address names, else the caller's): when it is not a service name, the pillar's `serviceCode` finds the service, so one rule serves addresses written with short codes. An entry in `aliases` wins over that lookup; a code shared by two services of a pillar is never guessed. |
| `gateway` | no | `false` | The call goes through the API gateway, so it is drawn as one (to a system on another island). |

<!-- file: TrafficFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `query` | yes | | The query, a template with the same holes as the links query. It returns one row for each caller and address over the window with the columns `caller`, `host` and `calls` (the estimated calls, corrected for sampling); `path` for a gateway. No `days` column is needed. |
| `shareWindow` | no | `1h` | How far back each read looks. A longer window gives steadier shares. |
| `minCalls` | no | `20` | Below this many observed calls to an API the share is too noisy to trust: the last good share stands and is marked estimated. |
| `interval` | no | `5m` | How often it reads. |

Found links are saved under `_discovered/links/<environment>/` in the town's folder (one file for each pillar, plus `state.yaml`), never in a pillar file, and are meant to stay out of version control. Addresses no rule explains, no ignore pattern covers and no vendor `domains` entry names are listed under Notices.

```yaml
links:
  source: logs
  query: |
    AppDependencies
    | where TimeGenerated between (datetime({from}) .. datetime({to}))
    | where AppRoleName in~ ({roles})
    | extend u = parse_url(Data)
    | summarize days = make_set(startofday(TimeGenerated)), calls = sum(ItemCount)
        by caller = AppRoleName, host = tostring(u.Host), path = tostring(u.Path)
  ignoreHosts: ['^169\.254\.']
  rules:
    - { host: '^(?<service>[a-z-]+)\.services\.example\.test$', target: '{callerPillar}.{service}' }
    - { host: '^gateway\.example\.test$', path: '^/(?<pillar>[a-z]+)/(?<service>[a-z-]+)/', target: '{pillar}.{service}', gateway: true }
  aliases: { pay: payments }
  traffic:
    shareWindow: 1h
    query: |
      AppDependencies
      | where TimeGenerated between (datetime({from}) .. datetime({to}))
      | where AppRoleName in~ ({roles})
      | extend u = parse_url(Data)
      | summarize calls = sum(ItemCount)
          by caller = AppRoleName, host = tostring(u.Host), path = tostring(u.Path)
```

### logs
What a system's Logs tab shows in a live town. Nothing is polled: when someone opens the tab, one query for that system's telemetry name goes to the named source, over the last `window`, and the answer is not kept. It never affects health. The tab has four separate sections so a flood in one never hides another: 5xx requests, slow requests (over the system's own `slaP99Ms`), warnings and errors, and exceptions. Repeats are one line with a count, newest first, and each entry that has an operation id links to its full trace. A worker, a function or anything else that does not answer requests gets only the logs and exceptions sections. A demo town makes its own entries and needs none of this.

<!-- file: LogsFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `source` | yes | | Name of a `loganalytics` source of this file. Its workspace and login are used. |
| `query` | yes | | The query to send, a template. Holes: `{roles}` (the system's telemetry name, double-quoted), `{from}` and `{to}` (UTC, ISO 8601), `{window}` (for example `4h`), `{windowSeconds}`, `{slaMs}` (the system's own p99 SLA), `{kind}` (`api`, `worker` and so on), `{environment}` and your `scope.variables`. It returns one row for each kind of entry with the columns `section` (`failed`, `slow`, `logs` or `exceptions`), `at` (the newest time) and `text`; `count` (default 1), `level` (`info`, `warn` or `error`, or a number where 2 is a warning and 3 and up an error), `durationMs` and `result` (a status code, say) may be left out. Azure does the grouping; no raw rows come back, and none are cut off. |
| `window` | no | `4h` | How far back it looks, for example `30m`. |
| `links` | no | none | Links in the header of a section that open the telemetry store's own search already filtered to the system, 0 to n, each `{ name, section, resources, url }`. `section` is `failed`, `slow`, `logs` or `exceptions`; `resources` names a `scope.assets` rule, and each resource it finds gets its own link (its name is added to the link's name when there is more than one). The url starts with `https://` (or `http://`) written out and may use `{resourceId}`, `{resourceIdTwice}` (the id percent-encoded twice, as the Azure portal's blade addresses want it), `{resourceName}`, `{role}`, `{from}`, `{to}`, `{windowMs}`, `{environment}` and your `scope.variables`; every value is percent-encoded. |

Each entry of `logs.links`:

<!-- file: LogLinkFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | | The words on the link. |
| `section` | yes | | The section whose header carries it: `failed`, `slow`, `logs` or `exceptions`. |
| `resources` | yes | | The name of a `scope.assets` rule; each resource it finds gets its own link. |
| `url` | yes | | The address template, starting with `https://` or `http://` written out. |

```yaml
logs:
  source: logs
  window: 4h
  query: |
    union
      (AppRequests | where TimeGenerated between (datetime({from}) .. datetime({to})) and AppRoleName in~ ({roles})
        | where toint(resultCode) >= 500
        | summarize count = count(), at = max(TimeGenerated), durationMs = max(DurationMs)
            by section = "failed", text = strcat(name), result = resultCode),
      (AppTraces | where TimeGenerated between (datetime({from}) .. datetime({to})) and AppRoleName in~ ({roles}) and SeverityLevel >= 2
        | summarize count = count(), at = max(TimeGenerated), level = max(SeverityLevel)
            by section = "logs", text = Message)
  links:
    - { name: 5xx in search, section: failed, resources: app-insights, url: "https://search.example.test/{resourceIdTwice}?service={role}&from={from}&to={to}" }
```

### credentials
<!-- file: CredentialFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `kind` | yes | | `azure-cli`, `default`, `managed-identity` or `service-principal`. |
| `tenantId` | no | the login's own | Directory to sign in to. |
| `clientId` | no | none | App registration (service principal) or user-assigned identity (managed identity). |
| `clientSecretEnv` | no | none | Name of the environment variable that holds a service principal's secret. The secret itself never goes in a file. |

### scope
<!-- file: ScopeFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `inventory` | no | none | Name of the `resourcegraph` source that lists resources. |
| `workspace` | no | none | Log Analytics workspace by name or wildcard (a template), looked up in the inventory. An id or resource id is used as given. |
| `workspaceId` | no | none | The workspace's id (GUID or resource id), a template. Wins over `workspace`. |
| `variables` | no | none | Your own names for use in templates. |
| `subscription` | no | none | Which subscriptions belong to the environment. |
| `pillars` | no | none | Pillar id → the id of the subscription that holds its resources. `hub` is accepted too, so the hub's gateway and broker find their resources and portal links. |
| `resources` | no | none | Rules that find a system's cloud resources. |
| `telemetryRole` | no | none | Template for a system's telemetry name when it gives none. |
| `links` | no | none | Addresses that open a resource in a portal or console, shown beside each resource in the Config tab. |
| `cloud` | no | none | What the cloud is called in your words (for example `Azure`). A system whose app the inventory cannot find reads "not found in <cloud>"; without it, "not found in the inventory". |
| `assets` | no | none | Resources that are not systems but stand as small buildings without health (a key vault, a storage account). See below. |
| `regions` | no | location, as is | How a service's region is read and named, and when a lopsided split of requests is flagged. |
| `queries` | no | built-in | Replace the inventory queries. |

<!-- file: SubscriptionRuleFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `nameLike` | no | none | Subscription name pattern (a template). |
| `tag` | no | none | Match by tag instead. |

<!-- file: TagRuleFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `key` | yes | | Tag name. |
| `value` | no | any | Tag value (a template). |

<!-- file: ResourceRuleFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | | Name that `metrics` entries refer to. |
| `types` | yes | | Cloud resource types the rule looks at, for example a plan or an account type. |
| `pattern` | yes | | A regular expression over a resource's name with named groups: `service` (required), and optionally `role`, `pillar`, `region`, `tenant`. |
| `roles` | no | all roles | Limit the rule to systems of these roles. |
| `serviceTag` | no | none | Tag that carries the service. |
| `tenantNameTag` | no | none | Tag that carries a tenant's friendly name. |
| `instances` | no | none | Query expression for how many instances a resource runs. |
| `state` | no | none | Query expression that reads a resource's app state as text. A system whose rule has it shows Running, Stopped (a building under construction) or, when the inventory has no such app, Missing (grey, "not found in" the `cloud` you name). |
| `running` | with `state` | | The values of `state` that mean the app runs; any other value is shown as stopped. The core knows no state words. |
| `subscription` | no | the system's pillar's | Which subscriptions this rule looks in, by `nameLike` (a template over your `variables` and `{environment}`) or by `tag` (`key`, `value`). For resources that live apart from their pillar, such as the hub's gateway or Service Bus. |

<!-- file: AssetRuleFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | | Names the rule (lowercase kebab-case). |
| `label` | yes | | What the resource is, in the drawer's words (for example `Key vault`). |
| `shape` | no | `box` | How the building looks: `box`, `vault`, `store`, `settings` or `observatory`. |
| `types` | yes | | The resource types it applies to. They are looked for in each pillar's subscription (or, with `island: hub`, in the subscriptions `subscription` names). |
| `pattern` | yes | | Regular expression over the resource's name. Optional named groups: `service` (matched with a system's `serviceCode`; a match stands the building beside that service's pad, otherwise it stands in the pillar's back yard), `pillar` (another pillar's resource is left out) and `region`. On the hub only `region` is allowed. |
| `island` | no | the pillar it is found in | `hub` stands the building on the hub island, in the cluster `group` names. It belongs to no pillar and no service. |
| `group` | with `island: hub` | | The cluster of buildings it stands in on the hub, named on a sign (for example `Monitoring`). Rules with the same group share a cluster. |
| `subscription` | no | the pillars' subscriptions | With `island: hub`: which subscriptions to look in, by `nameLike` (a template over your `variables` and `{environment}`) or by `tag` (`key`, `value`). Use it when the shared resources live in a subscription of their own. |

<!-- file: RegionsFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `tag` | no | none | Tag of a resource that says its region. Without it, the `region` group of the rule's pattern, else the location the cloud gives. |
| `names` | no | none | Region value → the label to show (for example `northeurope: North`). A value without a label is shown as it is. |
| `skew` | no | `0.9` | The share of a service's requests one region may take, while another region runs instances, before the town flags it. `1` never flags. Needs the source's `regionQuery`. |

<!-- file: ResourceLinkFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | | The words on the link, for example `Cloud portal`. |
| `url` | yes | | A template that starts with `https://` (or `http://`) written out. Holes: `{resourceId}`, `{name}`, `{type}`, `{region}`, `{subscriptionId}`, `{tenantId}`, `{tenantName}`, `{environment}` and your `variables`. Values are percent-encoded (a resource id keeps its slashes). An address that does not come out as a valid `http`/`https` address is dropped for that resource. The app never calls it. |
| `types` | no | all types | Only resources of these types get the link. |

<!-- file: ScopeQueriesFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `subscriptions` | no | built-in | Query that lists subscriptions. |
| `resources` | no | built-in | Query that lists resources. |
| `workspaces` | no | built-in | Query that finds the workspace. |

## fake.yaml and stories/
Used only by a town with `mode: demo`; the validator rejects them in a live town. They script the fake source and the story bar (`fake.yaml` also takes `regions: { name: weight }` per service; `fake-assets.yaml` lists the basic buildings) and are described in the sample folders (`config/galactic-credit/fake.yaml`, `config/galactic-credit/stories/`).
