using System.Text.Json.Serialization;

namespace ObservabilityCity.Contracts;

// The C# records in this file are the source of truth for the wire format.
// contracts/openapi.json and frontend/src/contracts.ts are generated from them (see README).

/// <summary>What a building is. The renderer maps each kind to a model through the active theme.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum NodeKind
{
    Api,
    Worker,
    Database,
    Cache,
    Cron,
    Gateway,
    Broker,
    Egress,
}

/// <summary>Who a tenant is: a paying customer, a test tenant (smoke tests, QA, sandboxes), or one the data shows that the environment does not list.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TenantKind
{
    Customer,
    Test,
    Unknown,
}

/// <summary>Overall state after the rules ran. Stale means no fresh data and is never shown as healthy.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum HealthState
{
    Healthy,
    Degraded,
    Down,
    Stale,
}

/// <summary>
/// One building: a system or a hub resource, with the numbers the renderer turns into visuals.
/// Service names the group of buildings that belong together (for example an API, its worker and its database), so they are drawn side by side.
/// External marks systems that outside callers reach, which the renderer draws as a different kind of traffic.
/// Calls lists the ids of the systems this one calls directly, as declared in the registry. GatewayCalls lists systems on other islands it reaches through the API gateway.
/// Load is the share of capacity in use (0 idle, 1 full, above 1 saturated); each source works it out its own way.
/// Cpu and Memory are the share in use across a service's instances (0 to 1). Utilisation is the share of provisioned capacity a data store
/// uses (for example request units consumed against the maximum set), and Throttled is the share of requests it turned away. A source leaves out
/// what it cannot measure (null), and the renderer shows only what is there.
/// ErrorRate is the share of failed requests: 5xx responses, timeouts and unhandled exceptions. Client errors (4xx) are not failures, and 429 is counted as throttling.
/// For a message consumer, QueueDepth is the messages waiting, OldestMessageSeconds the age of the oldest one (how late the consumer is), and DeadLetters the
/// messages parked in the dead-letter queue. Sources that cannot tell leave them null.
/// Tenants is set only for a data store that keeps one database per tenant (its registry entry has a tenantPattern): one unit for each tenant, and null
/// for every other system. Utilisation and Throttled of such a store are the worst of its tenants' that count: customers and unknown tenants, and
/// test tenants only when there are no others, held below the red thresholds, so a test tenant's trouble shows amber on its own unit and never turns the building red.
/// Absent lists the signals no source is configured for (requests, errors, latency, instances, cpu, memory, utilisation, throttled, backlog, deadLetters). They are not
/// zero and not grey: the number in the matching field means nothing, health ignores it and the renderer shows nothing for it. A system whose signals are all absent has no
/// source at all; it is Stale in State, but it is not grey and it is not counted as missing data.
/// </summary>
public sealed record NodeSnapshot(
    string Id,
    string Name,
    NodeKind Kind,
    string? Service,
    bool External,
    HealthState State,
    int InstancesTotal,
    int InstancesHealthy,
    double Load,
    double? Cpu,
    double? Memory,
    double? Utilisation,
    double? Throttled,
    double? QueueDepth,
    double? OldestMessageSeconds,
    double? DeadLetters,
    double RequestsPerSecond,
    double ErrorRate,
    double P99Ms,
    double SlaP99Ms,
    double ErrorAmber,
    double ErrorRed,
    double ResourceAmber,
    double ResourceRed,
    double ThrottleAmber,
    double ThrottleRed,
    double BacklogAmber,
    double BacklogRed,
    IReadOnlyList<string> Calls,
    IReadOnlyList<string> GatewayCalls,
    DateTimeOffset? LastUpdated,
    IReadOnlyList<TenantUnitSnapshot>? Tenants,
    IReadOnlyList<string> Absent);

/// <summary>
/// One tenant's database of a multi-tenant data store. Database is its real name (the store's tenantPattern with the tenant id put in).
/// State is Healthy, Degraded (amber: running hot or throttling), Down (red: past the red thresholds, never for a test tenant) or Stale (no database found, or no fresh data).
/// Utilisation and Throttled are this database's own share of provisioned capacity in use and share of requests turned away.
/// Kind Unknown is a tenant the data shows that the environment does not list.
/// </summary>
public sealed record TenantUnitSnapshot(
    string Id,
    string Name,
    TenantKind Kind,
    string Database,
    HealthState State,
    double? Utilisation,
    double? Throttled,
    double RequestsPerSecond);

/// <summary>A town the server can show (Galactic Credit, Droid Shop). Each has its own registry, its own environments and its own stream of snapshots.</summary>
public sealed record TownSummary(string Id, string Name, bool IsDefault);

/// <summary>An environment the server can show (dev, staging, prod). Each has its own sources, its own tenants and its own stream of snapshots.</summary>
public sealed record EnvironmentInfo(string Id, string Name, bool IsDefault);

/// <summary>
/// A tenant of this environment. Share is the part of the environment's tenant traffic it brings (0 to 1, all tenants add up to 1),
/// which decides how many of the cars carry its name.
/// </summary>
public sealed record TenantInfo(string Id, string Name, TenantKind Kind, double Share);

/// <summary>
/// An open incident assigned to a group. Severity runs from 1 (worst) to 4 (minor), as in the incident tool. The renderer turns the worst
/// open incident of a group into weather over its island.
/// </summary>
public sealed record IncidentSnapshot(
    string Id,
    string Title,
    int Severity,
    DateTimeOffset StartedAt);

/// <summary>A Service Bus topic: Name is the full topic name, Service the service (or hub resource name) that publishes it.</summary>
public sealed record TopicSnapshot(string Name, string Service);

/// <summary>
/// A worker reading a topic. Publisher is the id of the island that owns the topic, Consumer the id of the worker. Legacy marks a pillar reading
/// the hub's egress topic, the old way, which the renderer flags with an amber pennant.
/// </summary>
public sealed record SubscriptionSnapshot(string Topic, string Publisher, string Consumer, bool Legacy);

/// <summary>The topics an island publishes and the subscriptions its workers hold. Both empty means the island has no messaging, and no pier.</summary>
public sealed record MessagingSnapshot(
    IReadOnlyList<TopicSnapshot> Topics,
    IReadOnlyList<SubscriptionSnapshot> Subscriptions);

/// <summary>
/// An island (a pillar, a team, ...) or the hub island. IsLostFound marks the island that collects systems no group owns.
/// ConfigError is set when the group's registry file is broken and was skipped: the island is drawn as a "config error" island
/// with no buildings, and the text says what is wrong. It is null for every healthy island.
/// Incidents are the open incidents assigned to this group (empty when the sky is clear).
/// HasBridge says whether a bridge joins the island to the hub: in a hub-and-spoke town it has an API, or a call link crosses its coast; in a town
/// whose islands call each other directly, a call link to or from the hub's shared resources. HasRingBridge says whether a bridge joins the island's
/// back gate to the outer ring road: a third party to reach and, in a direct town, every call that does not involve the hub. Without a bridge the
/// island is reached only by boat (or by nothing at all). Messaging lists its topics and subscriptions; an island with neither has no pier. The renderer
/// builds only the connectors that these say exist.
/// </summary>
public sealed record GroupSnapshot(
    string Id,
    string DisplayName,
    string Color,
    bool IsHub,
    bool IsLostFound,
    string? ConfigError,
    IReadOnlyList<IncidentSnapshot> Incidents,
    bool HasBridge,
    bool HasRingBridge,
    MessagingSnapshot Messaging,
    IReadOnlyList<NodeSnapshot> Nodes);

/// <summary>
/// A third party outside the town (a credit bureau, a data warehouse). Node carries its health, worked out from our own calls to it:
/// request rate, error rate and p99 of the calls that go out, with the vendor's own thresholds. CalledBy lists the ids of our systems that call it.
/// </summary>
public sealed record VendorSnapshot(
    NodeSnapshot Node,
    IReadOnlyList<string> CalledBy);

/// <summary>
/// Someone outside the town (an app, a partner) and the external systems it reaches. RequestsPerSecond is the traffic it brings in, the
/// share of each external system's rate that falls to it when several outside callers reach the same system.
/// </summary>
public sealed record ExternalCallerSnapshot(
    string Id,
    string Name,
    double RequestsPerSecond,
    IReadOnlyList<string> Calls);

/// <summary>
/// Traffic that crosses from one group to another (or to a vendor): the dependency overlay draws an arc for each.
/// From is a group id. To is a group id or a vendor id. RequestsPerSecond adds up the calls between the two; until a source reports each link's own rate,
/// a system's rate is shared evenly between the systems that call it.
/// </summary>
public sealed record DependencySnapshot(
    string From,
    string To,
    double RequestsPerSecond);

/// <summary>The town's headline numbers. DeadLetters adds up the dead-letter queues of every consumer that reports one.</summary>
public sealed record TownTotals(
    double RequestsPerSecond,
    double ErrorRate,
    double P99Ms,
    int Degraded,
    int Down,
    int Incidents,
    double DeadLetters);

/// <summary>
/// The whole town at one moment. This is what is pushed to the browser.
/// Notices are problems with the configuration that did not stop the town: a reload that failed (the last good registry is still shown),
/// a call link that points nowhere and was dropped. The renderer lists them in the top bar.
/// RingCapacity is how many islands stand on the first ring (layout.yaml), which the renderer lays the two rings out from.
/// Vendors are the third parties, ExternalCallers feed the airport, and Dependencies are the cross-group traffic the overlay draws.
/// Environment is the id of the environment this snapshot shows (EnvironmentName its display name); Environments lists every environment the server
/// serves. Tenants are the tenants of this environment, the unknown ones the data shows included; it is empty for an environment without tenants.
/// Topology says how islands reach each other: "hub-and-spoke" (every call between islands goes through the hub's gateway) or "direct".
/// Mode is "demo" (fake data, with the Break things panel and the story bar) or "live" (real sources; nothing to break).
/// View says which islands this snapshot shows. Without a filter it is empty and the whole town is here; with one, the groups, vendors, totals,
/// callers and dependencies hold only what is on screen, and View lists what was left out and the traffic that crosses the edge.
/// IncidentFreeSince is when the islands shown last had an open incident (or, when they never did, when the server started watching); it is null while
/// one of them has one open. IncidentsSeen says whether any of them has had one since the server started, so "N hours since the last incident" is
/// not claimed for a town that has simply not been watched for long.
/// </summary>
public sealed record Snapshot(
    string TownId,
    string TownName,
    string GroupLabel,
    string Environment,
    DateTimeOffset GeneratedAt,
    double DayFraction,
    TownTotals Totals,
    IReadOnlyList<string> Notices,
    IReadOnlyList<GroupSnapshot> Groups,
    IReadOnlyList<VendorSnapshot> Vendors,
    IReadOnlyList<ExternalCallerSnapshot> ExternalCallers,
    IReadOnlyList<DependencySnapshot> Dependencies,
    int RingCapacity,
    string EnvironmentName,
    IReadOnlyList<EnvironmentInfo> Environments,
    IReadOnlyList<TenantInfo> Tenants,
    string Topology,
    string Mode,
    ViewInfo View,
    DateTimeOffset? IncidentFreeSince,
    bool IncidentsSeen);

/// <summary>An island the island filter left out.</summary>
public sealed record HiddenIsland(string Id, string DisplayName);

/// <summary>
/// Traffic between a system on screen and an island the filter left out. NodeId is the system on screen. Incoming is false when it calls a system on
/// the hidden island and true when a system there calls it. RequestsPerSecond is the traffic on the link (the callee's rate, shared evenly between its callers).
/// </summary>
public sealed record OffscreenLink(string NodeId, string IslandId, string IslandName, bool Incoming, double RequestsPerSecond);

/// <summary>
/// Which islands a snapshot shows. Islands is the filter that was asked for and found (empty when there is none and the whole town is shown),
/// Unknown the ids it named that the town does not have (they are ignored), Hidden the islands left out, and Links the traffic that crosses the
/// edge of the screen. The hub is always shown.
/// </summary>
public sealed record ViewInfo(
    IReadOnlyList<string> Islands,
    IReadOnlyList<string> Unknown,
    IReadOnlyList<HiddenIsland> Hidden,
    IReadOnlyList<OffscreenLink> Links);

/// <summary>Where a setting's value comes from: the system's own entry, its pillar's defaults, the app-wide defaults.yaml, or the built-in default.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SettingLayer
{
    System,
    Pillar,
    App,
    BuiltIn,
}

/// <summary>
/// One effective setting of a system. Key is its name in the YAML (errors.amber), Value what the app uses, formatted for people (5%, 300 ms),
/// Layer which file layer it came from and Source that layer in words (pillars/cl.yaml, defaults for api).
/// </summary>
public sealed record ConfigValue(string Key, string Value, SettingLayer Layer, string Source);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LinkKind
{
    System,
    Vendor,
}

/// <summary>A system (or third party) another system is linked to, with the island it stands on.</summary>
public sealed record LinkRef(string Id, string Name, LinkKind Kind, string IslandId, string IslandName);

/// <summary>
/// What the inspector shows beyond the live numbers: the system's links and its effective settings with where each came from.
/// Calls holds the systems it calls directly (third parties included) and CalledBy the systems that call it; GatewayCalls and GatewayCalledBy are
/// the same through the API gateway. OutsideCallers names the outside callers that reach it. ServiceTopics are the topics its service publishes.
/// File is the registry file the system is declared in.
/// </summary>
public sealed record SystemDetail(
    string Id,
    string Name,
    NodeKind Kind,
    string? Service,
    string IslandId,
    string IslandName,
    string File,
    IReadOnlyList<ConfigValue> Config,
    IReadOnlyList<LinkRef> Calls,
    IReadOnlyList<LinkRef> CalledBy,
    IReadOnlyList<LinkRef> GatewayCalls,
    IReadOnlyList<LinkRef> GatewayCalledBy,
    IReadOnlyList<string> OutsideCallers,
    IReadOnlyList<string> ServiceTopics,
    IReadOnlyList<SubscriptionSnapshot> Subscriptions);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LogLevel
{
    Info,
    Warn,
    Error,
}

/// <summary>One line of a system's recent logs, newest first in a list.</summary>
public sealed record LogLine(DateTimeOffset At, LogLevel Level, string Message);
