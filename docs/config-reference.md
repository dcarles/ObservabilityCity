# Config reference

Every key you can write in a town folder, file by file. For the order to do things in, read [Connect your company](connect-your-company.md) first; this page is the lookup.

Your editor can check most of this as you type: each sample file starts with a `# yaml-language-server: $schema=` line that points at the files in `schema/`. `dotnet run --project backend/tools/ObservabilityCity.Validate -- <folder>` checks the whole folder, including the rules an editor cannot see.

**Required** means the file is rejected without the key. **Optional** keys can be left out; the default says what happens then. Keys are written in camelCase. A key the loader does not know is an error, so a typo never passes silently.

A town folder looks like this:

```
town.yaml          required   the town's name and kind, and where the islands stand
defaults.yaml      optional   thresholds per role
hub.yaml           required   shared resources in the middle
third-parties.yaml optional   vendors outside the town
pillars/<id>.yaml             one island each
environments/<id>.yaml        one per environment (live towns)
fake.yaml, fake-assets.yaml, stories/   demo towns only (mode: demo)
```

Thresholds cascade: `defaults.yaml` (per role) → the pillar's `defaults` → the system's own keys, then built-in values when no layer sets one. The nearest one wins.

## town.yaml
<!-- file: TownFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `id` | yes | | Short id of the town. |
| `name` | yes | | Name shown in the top bar. |
| `groupLabel` | no | `Group` | What one island is called in the interface (for example Pillar, Domain, Team). Every label that names a group uses it; `pillar` in key and file names means the same group. |
| `topology` | no | `direct` | `direct`: islands are linked by an outer ring road. `hub-and-spoke`: islands call each other through a gateway on the hub. |
| `mode` | no | `live` | `demo` gives the town a fake source, the Break things panel and the story bar. `live` never does. |
| `trafficDensity` | no | `1` | How many cars appear, as a multiple of the usual number: `1` is the usual look, `2` twice as many, `0.5` half. From `0.25` to `10`. A weak PC still lowers it with the quality setting, and the town never shows more than 420 cars at once. |
| `islands` | no | file order | Pillar ids in the order the islands stand round the hub. Pillars not listed follow in file order, and Lost & found always comes last. Once the list is given, every pillar except Lost & found must be in it, or `validate` fails; with no list it only warns. |
| `ringCapacity` | no | `12` | Islands on the first ring, from `6` to `18`. The second ring holds one fewer, since the airport takes a place there, so a town holds at most `2 × ringCapacity − 1` pillars. Lost & found counts. |
| `databaseEngines` | no | none | The database engines this company uses, by id (see below). A database writes `engine: <id>`. |
| `messaging` | no | see below | How the town names its message topics, and which topics are on a route you are moving off (see below). |
| `labels` | no | see below | The words the town uses for things the app has no fixed name for (see below). |
| `wall` | no | see below | The town's defaults for wall mode: how long the tour stays at each stop, how long the overview lasts and the light (see below). |
| `expectedWarnings` | no | none | Warnings the validator should expect, for a test folder that shows a rule on purpose. |

<!-- file: DatabaseEngineFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | | The engine as it is shown, for example `Cosmos DB`. |
| `type` | yes | | The kind of database it is: `relational`, `document`, `key-value`, `wide-column`, `graph`, `time-series`, `analytical` or `vector`. The list is fixed. Every engine belongs to exactly one type. |

Each entry of `databaseEngines` is keyed by an id in lowercase kebab-case, for example `cosmos`:

```yaml
databaseEngines:
  cosmos:    { name: Cosmos DB,  type: document }
  sqlserver: { name: SQL Server, type: relational }
```

A database (`role: db`) in a pillar file or the hub then writes `engine: cosmos` and shows "Cosmos DB" with its type, Document, in the inspector, the tooltip and on the sign of its building in the 3D town. An engine that is not in the list is an error with a "did you mean" hint, so two teams cannot spell one engine two ways. A database without `engine` keeps the generic sign of its building and shows no label, and the validator warns about it once the town lists engines.

<!-- file: TownMessagingFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `topicTemplate` | no | `{service}` | The name of the topic a pillar's service publishes. `{pillar}` and `{service}` are replaced; it must contain `{service}` (a current limit: every topic is named after a service). Two topics with the same name are a problem. |
| `hubTopicTemplate` | no | `{service}` | The name of a topic of the hub. `{service}` is replaced by the name the hub gives it; it must contain `{service}`. |
| `legacyFrom` | no | none | The owners whose topics are a route you are moving off. Only `hub` can be listed (a current limit). A subscription to such a topic must say `legacy: true` and is drawn with an amber pennant; with `legacy: true` on any other topic, the validator reports a problem. |

For a town that names topics `<service>.events` and `shared.<name>`, and is moving off reading the hub's topics:

```yaml
messaging:
  topicTemplate: "{service}.events"
  hubTopicTemplate: "shared.{service}"
  legacyFrom: [hub]
```

The sample Galactic Credit uses `{pillar}-{service}-outbox` instead, and Droid Shop `{service}.events`.

<!-- file: LabelsFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `internalVendors` | no | `Internal services` | What the town calls its own services outside the monitored platform (third parties with `internal: true`): the dashboard section and the note in the Unknown hosts panel. |

<!-- file: WallFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `holdSeconds` | no | `20` | Seconds the wall tour stays at each stop. `0.5` or more. |
| `overviewSeconds` | no | `3` | Seconds the overview shows the whole town when something is wrong. The tour opens with the overview and comes back to it after the last stop. `0` for no overview. |
| `overviewIslandSeconds` | no | `3` | After the whole town, the overview visits each pillar island in the order they stand round the hub (the hub is left out), seen from its front, and stays this many seconds at each. `0` to show only the whole town. The dashboard wall does the same with its pillars: the closed list, then each pillar opened in turn. |
| `light` | no | `dusk` | The light a wall opens in: `dusk` or `day`. |

Every key is a default for the whole town. An address parameter on one screen wins over it: `?wall=1&hold=30&overview=5&overviewIsland=4&light=day`. Without the address parameter or the key, the default in this table applies. A value out of range stops the load and says the range.

```yaml
wall:
  holdSeconds: 30
  overviewSeconds: 5
  overviewIslandSeconds: 4
  light: day
```

<!-- file: ExpectedWarningFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `rule` | yes | | The name of the rule that warns. |
| `file` | no | any file | Limit the expectation to one file. |

## defaults.yaml and a pillar's `defaults`
A map from a role name (`api`, `worker`, `db`, `cache`, `function` (old spelling `cron`), `gateway`, `broker`, `egress`) to the values below. Any other role name is an error.

<!-- file: RoleDefaultsFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `slaP99Ms` | no | `1000` | The 99th-percentile latency (ms) the role should stay under. |
| `errors` | no | `0.01` / `0.05` | `amber` and `red` share of failed requests (0 to 1). |
| `resources` | no | `0.80` / `0.95` | `amber` and `red` for CPU, memory or a data store's utilisation (0 to 1). |
| `throttle` | no | `0.001` / `0.02` | `amber` and `red` for the share of throttled requests (0 to 1). |
| `backlog` | no | `60` / `300` | `amber` and `red` for the age of the oldest waiting message, in seconds. |
| `backlogCount` | no | none | `amber` and `red` for the number of messages waiting for a consumer, for a broker that reports counts and not ages (`servicebus`). Without it the count is shown but not judged. |
| `minCalls` | no | `1` | The fewest calls in a window that make the error share and latency worth judging. With fewer the system is quiet, not red. |
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
| `signals` | no | none | Signal → source name (or `none`) for every system of the pillar. Signal names are listed under the environment's `signals`. |
| `systems` | no | none | The pillar's systems, below. The validator warns when there are none. |
| `messaging` | no | none | Topics it publishes and topics it consumes, below. |
| `scheduler` | no | none | Which services each scheduled job of a function starts work for, below. |
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
| `role` | yes | | `api`, `worker`, `db` (or `database`), `cache`, `function` (old spelling `cron`), `gateway`, `broker` or `egress`; picks the defaults and the building. Any other role is an error. |
| `service` | no | none | Systems with the same service are drawn together as one block. |
| `tenantPattern` | no | none | For a store with one database per tenant: its name with `{tenant}` where the tenant id goes. |
| `engine` | no | none | For a database (`role: db`): the engine it runs on, an id from `databaseEngines` in `town.yaml`. |
| `external` | no | the pillar's `external` | The system belongs to someone outside the company. |
| `slaP99Ms` | no | role default | Latency target for this system. |
| `errors` | no | role default | Error thresholds. |
| `resources` | no | role default | Resource thresholds. |
| `throttle` | no | role default | Throttling thresholds. |
| `backlog` | no | role default | Backlog thresholds. |
| `backlogCount` | no | role default | Thresholds for the number of messages waiting for this system. |
| `minCalls` | no | role default | See above. |
| `discoverLinks` | no | pillar or role default | See above. Set `false` on a system whose calls should only be the declared ones. |
| `signals` | no | none | Signal → source name (or `none`) for this system alone. Signal names are listed under the environment's `signals`. |
| `serviceCode` | no | the service | The name its cloud resources carry for the service. |
| `environments` | no | all | Ids of the environments (the file names in `environments/`) this system is deployed in, for a service that exists only in some of them, such as a test simulator. In any other environment it is left out, with the calls that lead to it. Without it, the system is in every environment. |
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
| `topics` | no | none | Pillar: service names (a current limit: a topic must be one of the pillar's services), each published under the name `messaging.topicTemplate` in `town.yaml` makes of them. Hub: free names, named by `messaging.hubTopicTemplate`. |
| `subscriptions` | no | none | The topics this pillar's workers consume. |

<!-- file: SubscriptionFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `topic` | yes | | Full topic name. |
| `consumer` | yes | | A system of this pillar with role `worker`, by its full id. |
| `legacy` | no | `false` | A read of a topic of an owner the town lists in `messaging.legacyFrom`, a route you are moving off. Drawn with an amber pennant. |

### scheduler (pillar)
A function's jobs are found in its logs, and nothing in the logs says which service a job starts work for, so the pillar file says it. A job that is not listed sends no boats, and the town shows a "Job not mapped" notice naming it. A job's boats sail from the function's island to the services' islands; for the services of the same pillar that is a short out-and-back lane from the harbour.

<!-- file: SchedulerFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `jobs` | yes | | Job name (as the logs name it) → the services of this pillar it starts work for. |
| `system` | yes | | The function, by its id within the pillar. |

## hub.yaml
<!-- file: HubFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `displayName` | no | `Hub` | Name of the middle island. |
| `color` | no | `#f5c26b` | Its colour. |
| `resources` | no | none | Shared systems (same shape as a pillar system), for example a gateway and a broker. Only the roles gateway, broker, egress (an outbound proxy, if you have one) and database, and today at most one of each (a current limit). |
| `externalCallers` | no | none | Who calls in from outside, drawn at the airport. |
| `messaging` | no | none | The hub's own topics, in lowercase kebab-case. The hub takes `topics` only: `subscriptions` here is an error. |

<!-- file: ExternalCallerFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `id` | yes | | Id of the outside caller. |
| `name` | no | the id | Name shown. |
| `calls` | no | none | Ids of the systems it calls. Each must be a system marked `external`. |

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
| `calledBy` | yes, unless the vendor has `services` | | Ids of our systems that call it. Its health is read from those calls. |
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
| `roles` | no | none | The telemetry names this service's own calls are recorded under (list every instance name). Link discovery reads their calls like those of a town system: calls through the gateway are resolved by the same `links.rules`, drawn from this building to the town system, taken out of that system's outside traffic, and driven by cars from this island through the airport and the hub gateway. For hub-and-spoke towns with a gateway. |
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
| `default` | no | `false` | The environment shown when none is asked for. At most one environment may be the default; without one, the first by `order`. |
| `sources` | no | none | Where numbers come from, by source name. A signal no `signals` entry points elsewhere reads `messaging` (`backlog` and `deadLetters`), `jobs` (`jobs`) or `metrics` (the rest); any other kebab-case name can be pointed at by a signal. `incidents` is reserved: no live adapter reads it yet, and a source of that name is skipped. |
| `credentials` | no | none | How sources sign in, by name. A source that names none uses the credential called `default` if there is one, else the usual login of its adapter (Azure adapter: the Azure CLI login). |
| `signals` | no | none | Signal → source name (or `none`) for the environment. The signals are `requests`, `errors`, `latency`, `instances`, `cpu`, `memory`, `utilisation`, `throttled`, `backlog`, `deadLetters` and `jobs` (a function only). |
| `tenants` | no | none | The tenants listed here. Others are found from the cloud when a scope allows. |
| `exclude` | no | none | Ids of systems not deployed in this environment. Not hub resources: the hub is the same everywhere. |
| `fake` | no | none | Settings for the fake source only. |
| `links` | no | none | How the calls the systems make are found in the telemetry (see `links` below). |
| `logs` | no | none | Where a system's Logs tab reads from (see `logs` below). Without it the tab says logs are not set up. |
| `scope` | no | none | How pillars and systems map onto the cloud provider. |

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
Keys marked **Azure adapter setting** belong to the Azure adapter. The core registry holds and checks them for now, so another adapter cannot add keys of its own yet.

<!-- file: SourceFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `regionQuery` | no | none | **Azure adapter setting.** `loganalytics`: the query that says how a service's requests divide between regions: one row per telemetry name and region with the columns `role`, `region` and `calls`. Sampled counts are fine, only the proportions are used. Same template holes as `query`. With it each region shows its share of the requests. |
| `typesQuery` | no | none | **Azure adapter setting.** `servicebus`: a Log Analytics query that says which kinds of message each queue handled: one row per queue and message type with the columns `queue` (the entity's name, as the broker names it), `type` and `calls` (how many were handled over the window). Same template holes as `query`. With it each queue row of a reading system's drawer lists the kinds with their messages a second, highest first, up to 200 kinds per queue; the quietest beyond that are counted, not listed. The source needs the workspace the environment's scope gives (`scope.workspaceId`). Without it no kinds are shown. |
| `kind` | yes | | `fake`, `resourcegraph`, `loganalytics`, `azuremonitor`, `functionjobs`, `servicebus`, `resourcehealth`, `prometheus` or `grafana-irm`. |
| `connection` | no | from `scope` | How to reach it (a workspace id, an endpoint). Not used by `fake`. |
| `credential` | no | `default` if defined, else the adapter's usual login (Azure: the Azure CLI login) | A name from `credentials`. Azure adapter sources only. |
| `pollSeconds` | no | 30 (300 for `resourcehealth`) | How often the source is asked. Above 0. |
| `timeoutSeconds` | no | 10 (60 for `resourcehealth`) | How long one ask may take. Above 0. |
| `lateAfterSeconds` | no | twice `pollSeconds` | `functionjobs`: how long after its schedule says a job should run it may go without a newer run before it counts as late (amber). A value below the default is ignored, since a reading may lag that much anyway. Lets a log that arrives late stay quiet without polling slower. Above 0. |
| `query` | for `functionjobs` (unless a recording) | none | `loganalytics`: the query to send, a template; `functionjobs`: the query that summarises the function apps' logs into one row per app and job (columns `resourceId`, `job`, `lastRun`, `succeeded`, `next`, `region`). `{window}`, `{windowSeconds}`, `{roles}`, scope variables and `{environment}` work. |
| `window` | no | `5m` (`3d` for `resourcehealth`) | `loganalytics`, `azuremonitor`, `servicebus`, `functionjobs` and `resourcehealth`: how far back one answer looks. A unit is `s`, `m`, `h` or `d`. |
| `metrics` | no | none | **Azure adapter setting.** `azuremonitor`: which metric of which resources fills which signal. Required for an `azuremonitor` source. |
| `providers` | no | none | **Azure adapter setting.** `resourcehealth`: the resource providers whose health reports are read, as the cloud names them (`Namespace.Service`, for example the data store's). Required for a `resourcehealth` source. A subscription is asked for a provider only when the inventory has a resource of that provider in it. A resource's report is matched to the system that owns it by the resource's id, through `scope.resources`. |
| `keepResolvedFor` | no | `4h` | `resourcehealth`: how long a report stays listed, in green, after the resource recovered (a number and a unit: `4h`, `90m`, `1d`). The marker on the building goes away at once; the list entry and the drawer lines say resolved. A report can be dismissed earlier (the Dismiss button); a dismissal lasts until the server restarts. |
| `entities` | no | none | **Azure adapter setting.** `servicebus`: which namespaces to read, which metrics are the backlog and the dead letters, and how an entity's name says whose it is. Required for a `servicebus` source. |

### metrics entries (`azuremonitor`, Azure adapter)
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

An entry needs at least one signal other than `limit`.

<!-- file: MetricSignalFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `metric` | yes | | The metric's name as the cloud spells it. |
| `aggregation` | no | `average` | `average`, `total`, `count`, `maximum` or `minimum`: how the points of the window are added up. |
| `filter` | no | none | A dimension filter, for example `StatusCode eq '429'`. |
| `scale` | no | 1 | Multiplies the value, above 0. The town reads fractions, so a percentage needs `0.01`. |
| `perSecond` | no | `false` | Divide a total by the window's seconds, to get a rate. |
| `over` | no | none | Another metric to divide by (capacity, all requests), to give a share. It is used as it is, so it may not carry `scale` or `perSecond`. |
| `orElse` | no | none | Another metric to read when this one gives no number or 0. It cannot have its own `over` or `orElse`. |
| `whenEmpty` | no | `unknown` | What a read that worked but returned no number means: `unknown` (the system shows no data) or `idle` (nothing happened, so the signal is 0 and the tenant's row says "no activity reported"). A failed read is always unknown. Only on the signal itself, not on its `over` or `orElse`. |

Azure adapter example (a Cosmos DB account with an autoscale ceiling, falling back to fixed throughput):

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

### entities (`servicebus`, Azure adapter)
Reads the backlog and the dead letters of a message broker from the platform metrics of its namespaces, split by entity (queue or topic) name, and gives each entity's numbers to the system that consumes it. The program knows no metric name and no naming convention: this block says them. A system's backlog is what waits in all its entities, in every namespace the rule finds (one for each region); a namespace that cannot be read fails the poll, so a number made from only some of them never shows. An entity no pattern claims, or that no system consumes, is left out.

```yaml
sources:
  messaging:
    kind: servicebus
    pollSeconds: 60
    window: 15m
    entities:
      resources: broker                       # a rule of scope.resources that finds the namespaces
      backlog: { metric: ActiveMessages, aggregation: average }
      deadLetter: { metric: DeadletteredMessages, aggregation: last }   # last = the newest point: what is dead-lettered now, so a replayed queue clears at once. maximum would keep the peak of the whole window
      throughput: { metric: IncomingMessages, aggregation: total }
      patterns:                               # the first that matches decides; (?<service>) is the service code of the reader, (?<pillar>) the pillar code of the reader (left out: any pillar)
        - { match: '^(?<pillar>[a-z]+)\.(?<service>[a-z]+)\.in$' }
        # the name also says who publishes it, so the town builds the topic and the subscription itself: no `messaging:` block in a pillar file
        - { match: '^(?<producerPillar>[a-z]+)\.(?<producer>[a-z]+)\.to\.(?<service>[a-z]+)$' }
      flows:                                  # what a whole group sends and receives, for example one topic it publishes everything on and one it receives on
        - { match: '^(?<pillar>[a-z]+)\.outbound$', direction: sent }
        - { match: '^(?<pillar>[a-z]+)\.inbound$', direction: received }
signals: { backlog: messaging, deadLetters: messaging }
```

<!-- file: EntitiesFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `resources` | yes | | The name of a rule of `scope.resources`; the resources it finds (the broker's namespaces) are the ones asked. |
| `dimension` | no | `EntityName` | The metric dimension that carries the entity's name. |
| `interval` | no | one minute | The time grain the metrics are asked at, for example `5m`. |
| `backlog` | no | none | The metric of the messages waiting in an entity. |
| `deadLetter` | no | none | The metric of the dead-lettered messages of an entity. |
| `throughput` | no | none | The metric of the messages that arrive in an entity, usually incoming messages added up by `total`. Their rate (per second over the window) sets how many boats sail to the consumer; without it the boats follow the consumer's request rate. |
| `deadLetterLink` | no | none | `{ name, url }`: an address that opens one queue's dead letters in your queue explorer, shown for each queue in its consumer's drawer. The url is a template over `{queue}`, `{pillar}`, `{service}` (the codes of the scope rules), `{system}` and `{environment}`. Without it, no link. |
| `deadLetterLinks` | no | none | A list of `{ region, name, url }`: one queue-explorer address for each region, for a broker whose namespaces are in more than one region and a tool for each. A queue's dead letters in a region open the entry of that region (the region is matched ignoring case against the region of the namespace that holds them, as `scope.regions` and the resource rule give it). A region with no entry uses `deadLetterLink`. Each region may be given once. |
| `flows` | no | none | Entities that carry a whole pillar's traffic, a list of `{ match, direction }`: the rate of their `throughput` (messages a second over the source's `window`) is what that pillar sends to other pillars (`sent`) or receives from them (`received`). Several entities of one pillar (the same name in each region) add up. The name says only the pillar, never the other end, so these are totals per pillar, not pairs. They need `throughput`. The dashboard and the town show them; without `flows` neither shows a flow. |
| `patterns` | yes | | The shapes of entity names, tried in order: a regular expression with the group `service` (the code of the system that reads the entity; it must belong to one system of the kind only, or the entity is left out), optionally `pillar` (the code or id of the reader's pillar; without it the reader may be in any pillar), and optionally both `producerPillar` and `producer` (the code of the pillar and of the service that publish it). An entity whose name says its publisher is a route: the town adds that service's topic and the reader's subscription to what the pillar files say, on every poll, so queues teams add later appear without a config change. A queue Azure Monitor sends nothing for in one poll keeps its place with no numbers. |

At least one of `backlog`, `deadLetter` or `throughput` is required.

<!-- file: EntityLinkFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | | The words the link shows (for example `Open in queue explorer`). |
| `url` | yes | | An `http://` or `https://` address, a template over `{queue}` (the queue's name), `{pillar}`, `{service}`, `{system}` and `{environment}`. A system with no code for a word it uses gets no link. |
| `region` | no | | Only in `deadLetterLinks`: the region the address is for (required there, and not used in `deadLetterLink`). |

<!-- file: EntityMetricFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `metric` | yes | | The metric's name. |
| `aggregation` | no | `average` | How its points over the window are added up: `average`, `total`, `count`, `maximum` or `minimum`. `backlog` and `deadLetter` may also use `last`, the newest point of the window (what is there now, not the worst of the last minutes). Azure Monitor has no such aggregation, so the maximum of each grain is asked for and the newest grain is read. `throughput` cannot use `last`. |

<!-- file: EntityPatternFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `match` | yes | | A regular expression with the group `service` (required: the code of the system that reads the entity), optionally `pillar` (the code or id of the reader's pillar), and optionally both `producerPillar` and `producer` (never one alone), as in `patterns` above. |
| `consumer` | no | `worker` | The role of the system that reads the entity (`worker`, `api`, ...). |

<!-- file: EntityFlowFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `match` | yes | | A regular expression with the named group `pillar`: the pillar's code (or id). |
| `direction` | yes | | `sent` (what arrives in this entity is what the pillar sends to the other pillars) or `received` (what the other pillars send to it). |

The thresholds that turn a waiting count amber and red are `backlogCount` in the defaults.

### links
Finds the calls the systems really make, from the dependency data in the telemetry, and adds them to the declared `calls` and `gatewayCalls`. Without this block an environment has only the declared links.

<!-- file: LinksFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `source` | yes | | Name of a source of this file whose kind can read dependencies (with the Azure adapter, a `loganalytics` source). Its connection and login are used. The adapter of each kind says what its sources can do; `validate` names the kinds that can. |
| `query` | yes | | The query to send, a template. Holes: `{roles}` (the telemetry names of the systems asked about, double-quoted, separated by commas), `{from}` and `{to}` (UTC, ISO 8601), `{environment}` and your `scope.variables`. It returns one row for each caller and address with the columns `caller` (a telemetry name), `host` and `days` (an array of the days it was seen on); `path` and `calls` may be left out. The store does the counting; no raw rows come back. |
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

Azure adapter example, in KQL:

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
What a system's Logs tab shows in a live town. Nothing is polled: when someone opens the tab, one query for that system's telemetry name goes to the named source, over the last `window`, and the answer is not kept. It never affects health. The tab has four separate sections so a flood in one never hides another: 5xx requests, slow requests (over the system's own `slaP99Ms`), warnings and errors, and exceptions. Repeats are one line with a count, newest first. A worker, a function or anything else that does not answer requests gets only the logs and exceptions sections. A demo town makes its own entries and needs none of this.

<!-- file: LogsFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `source` | yes | | Name of a source of this file whose kind can read logs (with the Azure adapter, a `loganalytics` source). Its connection and login are used. The adapter of each kind says what its sources can do; `validate` names the kinds that can. |
| `query` | yes | | The query to send, a template. Holes: `{roles}` (the system's telemetry name, double-quoted), `{from}` and `{to}` (UTC, ISO 8601), `{window}` (for example `4h`), `{windowSeconds}`, `{slaMs}` (the system's own p99 SLA), `{kind}` (`api`, `worker` and so on), `{environment}` and your `scope.variables`. It returns one row for each kind of entry with the columns `section` (`failed`, `slow`, `logs` or `exceptions`), `at` (the newest time) and `text`; `count` (default 1), `level` (`info`, `warn` or `error`, or a number where 2 is a warning and 3 and up an error), `durationMs` and `result` (a status code, say) may be left out. The store does the grouping; no raw rows come back, and none are cut off. |
| `window` | no | `4h` | How far back it looks, for example `30m`. |
| `links` | no | none | Links in the header of a section that open the telemetry store's own search already filtered to the system, 0 to n, each `{ name, section, resources, url }`. `section` is `failed`, `slow`, `logs` or `exceptions`; `resources` names a `scope.assets` rule, and each resource it finds gets its own link (its name is added to the link's name when there is more than one). The url starts with `https://` (or `http://`) written out and may use `{resourceId}`, `{resourceIdTwice}` (the id percent-encoded twice, for portals that nest it), `{resourceName}`, `{role}`, `{from}`, `{to}`, `{windowMs}`, `{environment}` and your `scope.variables`; every value is percent-encoded. |

Each entry of `logs.links`:

<!-- file: LogLinkFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | | The words on the link. |
| `section` | yes | | The section whose header carries it: `failed`, `slow`, `logs` or `exceptions`. |
| `resources` | yes | | The name of a `scope.assets` rule; each resource it finds gets its own link. |
| `url` | yes | | The address template, starting with `https://` or `http://` written out. |

Azure adapter example, in KQL:

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
    - { name: 5xx in search, section: failed, resources: telemetry-store, url: "https://search.example.test/{resourceIdTwice}?service={role}&from={from}&to={to}" }
```

### credentials
<!-- file: CredentialFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `kind` | yes | | A login kind of a loaded adapter. The Azure adapter's kinds are `azure-cli`, `default`, `managed-identity` and `service-principal`. |
| `tenantId` | no | the login's own | Directory to sign in to. |
| `clientId` | no | none | App registration (service principal) or user-assigned identity (managed identity). |
| `clientSecretEnv` | no | none | Name of the environment variable that holds a service principal's secret. The secret itself never goes in a file. |

### scope
How pillars and systems map onto the cloud provider. `inventory`, `workspace`, `workspaceId`, `subscription`, `pillars` and `queries` are **Azure adapter settings** (on Azure the account is a subscription and the telemetry store a Log Analytics workspace); the core registry holds them for now.

<!-- file: ScopeFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `inventory` | no | none | Name of the source that lists resources: one whose kind can read an inventory (with the Azure adapter, a `resourcegraph` source). Without it, any such source of the file. |
| `workspace` | no | none | **Azure adapter setting.** The telemetry store: a Log Analytics workspace by name or wildcard (a template), looked up in the inventory. An id or resource id is used as given. |
| `workspaceId` | no | none | **Azure adapter setting.** The workspace's id (GUID or resource id), a template. Wins over `workspace`. |
| `variables` | no | none | Your own names for use in templates. |
| `subscription` | no | none | **Azure adapter setting.** Which subscriptions (accounts) belong to the environment, by exactly one of `nameLike` or `tag`. |
| `pillars` | no | none | **Azure adapter setting.** Pillar id → the id of the subscription that holds its resources. `hub` is accepted too, so the hub's gateway and broker find their resources and portal links. |
| `resources` | no | none | Rules that find a system's cloud resources. |
| `telemetryRole` | no | none | Template for a system's telemetry name when it gives none. Holes: `{system}`, `{service}`, `{name}`, `{role}`, `{pillar}`, `{pillarId}`, your `variables` and `{environment}`. |
| `links` | no | none | Addresses that open a resource in a portal or console, shown beside each resource in the Config tab. |
| `cloud` | no | none | What the cloud is called in your words (for example `Azure`). A system whose app the inventory cannot find reads "not found in <cloud>"; without it, "not found in the inventory". A provider health report on the dashboard reads "<cloud> incident" ("Cloud incident" without it). |
| `assets` | no | none | Resources that are not systems but stand as small buildings without health (a secrets store, a storage account). See below. |
| `regions` | no | location, as is | How a service's region is read and named, and when a lopsided split of requests is flagged. |
| `queries` | no | built-in | **Azure adapter setting.** Replace the inventory queries. |

<!-- file: SubscriptionRuleFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `nameLike` | no | none | Subscription name pattern (a template, for example `{pillar}-{env}`). Give exactly one of `nameLike` and `tag`. |
| `tag` | no | none | Match by tag instead. Give exactly one of `nameLike` and `tag`. |

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
| `subscription` | no | the system's pillar's | Which subscriptions this rule looks in, by `nameLike` (a template over your `variables` and `{environment}`) or by `tag` (`key`, `value`), exactly one of the two. For resources that live apart from their pillar, such as the hub's gateway or message broker. |

<!-- file: AssetRuleFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | | Names the rule (lowercase kebab-case). |
| `label` | yes | | What the resource is, in the drawer's words (for example `Secrets store`). |
| `shape` | no | `box` | How the building looks: `box`, `vault`, `store`, `settings` or `observatory`. |
| `types` | yes | | The resource types it applies to. They are looked for in each pillar's subscription (or, with `island: hub`, in the subscriptions `subscription` names). |
| `pattern` | yes | | Regular expression over the resource's name. Optional named groups: `service` (matched with a system's `serviceCode`; a match stands the building beside that service's pad, otherwise it stands in the pillar's back yard), `pillar` (another pillar's resource is left out) and `region`. On the hub only `region` is allowed. |
| `island` | no | the pillar it is found in | `hub` stands the building on the hub island, in the cluster `group` names. It belongs to no pillar and no service. |
| `group` | with `island: hub` | | The cluster of buildings it stands in on the hub, named on a sign (for example `Shared telemetry`). Rules with the same group share a cluster. |
| `subscription` | no | the pillars' subscriptions | With `island: hub`: which subscriptions to look in, by `nameLike` (a template over your `variables` and `{environment}`) or by `tag` (`key`, `value`), exactly one of the two. Use it when the shared resources live in a subscription of their own. |

<!-- file: RegionsFile -->
| Key | Required | Default | Meaning |
|---|---|---|---|
| `tag` | no | none | Tag of a resource that says its region. Without it, the `region` group of the rule's pattern, else the location the cloud gives. |
| `names` | no | none | Region value → the label to show (for example `us-east-1: East` or `eu-west: EU`). A value without a label is shown as it is. |
| `skew` | no | `0.9` | The share of a service's requests one region may take, while another region runs instances, before the town flags it. Above `0.5` and at most `1`; `1` never flags. Needs the source's `regionQuery`. |

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
