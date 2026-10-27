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
fake.yaml, stories/           demo towns only (mode: demo)
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
| `kind` | yes | | `fake`, `resourcegraph`, `loganalytics`, `azuremonitor`, `servicebus`, `prometheus` or `grafana-irm`. |
| `connection` | no | from `scope` | How to reach it (a workspace id, an endpoint). Not used by `fake`. |
| `credential` | no | Azure CLI login | A name from `credentials`. Azure sources only. |
| `pollSeconds` | no | 30 | How often the source is asked. Above 0. |
| `timeoutSeconds` | no | 10 | How long one ask may take. Above 0. |
| `query` | no | none | `loganalytics`: the query to send, a template. `{window}`, `{windowSeconds}`, `{roles}`, scope variables and `{environment}` work. |
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
| `pillars` | no | none | Pillar id → the id of the subscription that holds its resources. |
| `resources` | no | none | Rules that find a system's cloud resources. |
| `telemetryRole` | no | none | Template for a system's telemetry name when it gives none. |
| `links` | no | none | Addresses that open a resource in a portal or console, shown beside each resource in the Config tab. |
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
Used only by a town with `mode: demo`; the validator rejects them in a live town. They script the fake source and the story bar and are described in the sample folders (`config/galactic-credit/fake.yaml`, `config/galactic-credit/stories/`).
