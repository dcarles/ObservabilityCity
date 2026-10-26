# Azure source reference

What each real-data adapter reads and what shape comes back. This is for whoever builds or configures an adapter (a person or an agent). It is deliberately generic: it describes signals, sources and the config an adapter needs, and contains no company names, ids, screenshots or copied dashboard queries. The queries, metric names, tag keys and name patterns for a real deployment live in that company's `config/<company>/` or `extensions/`, never in core (see [connect-your-company.md](connect-your-company.md)).

Authentication for all Azure sources is the developer's `az login` by default. The credential method is a config option, so a service principal can replace it. No secret, subscription id or tenant id belongs in the repo.

## Principles

1. **Health only from unsampled sources.** Application Insights request, trace and dependency tables are usually sampled, so a count from them under-reports. Use pre-aggregated span metrics and platform metrics instead.
2. **Signals are source-neutral.** Core knows request rate, error rate, latency, instances, CPU, memory, RU, backlog. Each adapter fills them. A Prometheus adapter later fills the same signals.
3. **A signal with no configured source is absent**, not grey.
4. **Discovery proposes, config decides.** Anything inferred from telemetry (for example links between services) is a suggestion; config owns truth.
5. **Nothing company-specific in core.** Query text, metric names, property keys, tag keys and naming patterns are config templates with variables. A test runs each adapter against two differently shaped sample configs.

## Sources at a glance

| Source | Gives | Caveat |
| --- | --- | --- |
| Azure Resource Graph | Instance count, resource-to-service mapping, tenant names, subscription lookup | Instance count is the configured worker count, not live autoscale |
| Log Analytics, span metrics table | Request rate, errors, latency, per tenant and route | Only services that emit span metrics have data; averages only unless percentiles are emitted |
| Azure Monitor metrics API | Plan CPU and memory, Cosmos RU and throttling, Service Bus backlog and dead letters | Needs no diagnostic settings |
| Log Analytics, dependency table | Hints for service-to-service links only | Sampled: never use for health |

A workspace's platform-metrics table is often only a partial export of what Azure Monitor holds. Prefer the metrics API.

## Scope: pillar to subscription

Each pillar (island) is scoped to one Azure subscription per environment. Config resolves it from either an explicit subscription id (kept in local env config) or a rule, such as a display-name pattern with pillar and environment variables. Resource Graph can list subscriptions for the rule. Every other query is then scoped to the resolved subscription ids. Tag keys, if any, are config and used only to cross-check or sub-group.

## Signals and the config each needs

| Signal | Source kind | Config the adapter needs |
| --- | --- | --- |
| Request rate | Span metrics | Table and metric name for calls, telemetry role name per service, server-span filter, time bin |
| Error rate | Span metrics | Status property key, which status ranges count as errors (and whether 404 or 499 do) |
| Latency | Span metrics | Duration metric name; computed as total duration over call count |
| Tenant split | Span metrics | Tenant property key; friendly name from a resource tag |
| Instances | Resource Graph | Resource type for the plans, worker-count fields, region field |
| CPU and memory | Metrics API | Resource type and metric names for the plan, one query per region |
| %RU and throttling | Metrics API | Cosmos metrics for total and provisioned throughput and the status-code split; %RU is used RU over (provisioned RU per second times the bin seconds) |
| Backlog and dead letters | Metrics API | Service Bus metric names, entity-name dimension, entity-name prefix |

Each signal's query is an overridable template with variables (scope, service, bin, lookback, tenant). Core ships a generic default and an empty-by-default company layer.

## Service mapping

A resource name belongs to a service through a config regex with named groups (for example service, pillar, region, tenant). The same idea covers plans, web apps, Cosmos accounts and Service Bus entities. A fallback is a tag whose value matches the telemetry role name. Per-tenant data accounts map a tenant id in the name to a friendly tenant name from a tag.

## Link discovery (optional, parked)

Dependency telemetry shows which hosts a service calls. It is sampled, so it can propose links but never judge health. If built, config supplies an internal-host regex with named groups, an ignore list for platform noise, a third-party list and a rule for reading the destination from a gateway path. Unresolved calls are shown as unresolved, never guessed.

## Recorded fixtures

An adapter is built and tested against recorded results, not live Azure. For each query, keep a small synthetic sample of its result (same columns, invented names and ids) under `shared-test-data/`. Tests run each adapter against two differently shaped sample configs, so a hardcoded convention fails a test.

## Company-specific, therefore config

- Subscription naming rule or ids, environment codes.
- Tag keys and values for pillar, product and service.
- Resource-name regexes for plans, apps, data accounts and Service Bus entities.
- Span-metric names, property keys and the telemetry role name for each service.
- Error-status rules, query templates per source kind, and the credential method.
