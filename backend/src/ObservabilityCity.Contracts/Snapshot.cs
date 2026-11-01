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
    Function,
    Gateway,
    Broker,
    Egress,
}

/// <summary>
/// Whether the cloud runs a system's app: Running, Stopped (switched off on purpose, drawn as a building under construction) or Missing (the inventory was
/// read and has no such app, drawn grey as "not found in Azure"). A system whose environment does not read an app state has none (null).
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AppState
{
    Running,
    Stopped,
    Missing,
}

/// <summary>How one scheduled job of a function building stands: Ok (ran and succeeded, or not due yet), Failed (its last run failed) or Overdue (it should have run by now and has not).</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum JobStatus
{
    Ok,
    Failed,
    Overdue,
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
/// OutsideRequestsPerSecond and Inbound say where an API's traffic comes from, once the environment measures it (links.traffic): the part no town system explains,
/// which arrives at the airport, and the part each town system sends. Both are null while nothing measures it; the renderer then shares the rate evenly between the
/// declared callers. InboundEstimated says the share stands on too few calls and is the last good one.
/// App says whether the cloud runs the app (see <see cref="AppState"/>); Jobs lists the scheduled jobs of a function building; Regions lists a service's regions
/// when it runs in two or more, and the instances, Cpu and Memory above are then those of its worst region. A count of instances of 0 is never sent: it is not known, so
/// "instances" is in Absent.
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
    IReadOnlyList<string> Absent,
    bool Quiet = false,
    double? OutsideRequestsPerSecond = null,
    IReadOnlyList<InboundLinkSnapshot>? Inbound = null,
    bool InboundEstimated = false,
    AppState? App = null,
    IReadOnlyList<JobSnapshot>? Jobs = null,
    IReadOnlyList<RegionSnapshot>? Regions = null);

/// <summary>
/// A resource that is not a system but stands in the town as a small building without health (a key vault, a storage account). Label is what it is
/// ("Key vault"), Shape how it is drawn, Service the service whose pad it stands beside (null: it belongs to the pillar and stands in its back yard),
/// Region where it lives when the cloud says. Links are the addresses that open it somewhere else.
/// On the hub island Group names the cluster of buildings it stands in (for example "Monitoring"); it is null on a pillar's island.
/// </summary>
public sealed record AssetSnapshot(string Id, string Name, string Label, string Shape, string? Service, string? Region, IReadOnlyList<ResourceLink>? Links, string? Group = null);

/// <summary>
/// One scheduled job of a function building in one region: Status, when it last ran (LastRun) and when its schedule says it runs next (Next); both null
/// when the logs gave none. Region is the region label of the app that runs it, null when the system runs in one region only.
/// </summary>
public sealed record JobSnapshot(string Name, string? Region, JobStatus Status, DateTimeOffset? LastRun, DateTimeOffset? Next);

/// <summary>
/// One region of a service that runs in two or more (see the region view). Label is the region as the town names it. Instances, Cpu and Memory are that region's
/// own, each null when nothing reports it. Share is the part of the service's requests the region took (0 to 1, null when nothing measures it); Skewed marks the region that takes more than the environment allows (scope.regions.skew) while another region runs instances. The building's own numbers are those of its worst region, the one with the highest CPU or memory.
/// </summary>
public sealed record RegionSnapshot(string Region, string Label, int? Instances, double? Cpu, double? Memory, double? Share = null, bool Skewed = false);

/// <summary>What one town system sends to an API, in requests per second.</summary>
public sealed record InboundLinkSnapshot(string From, double RequestsPerSecond);

/// <summary>
/// One tenant's database of a multi-tenant data store. Database is its real name (the store's tenantPattern with the tenant id put in).
/// State is Healthy, Degraded (amber: running hot or throttling), Down (red: past the red thresholds, never for a test tenant) or Stale (no database found, or no fresh data).
/// Utilisation and Throttled are this database's own share of provisioned capacity in use and share of requests turned away.
/// Limit is the capacity provisioned for it as a number in the store's own unit (request units per second for Cosmos), when the source reads one;
/// null for a serverless database or a source that is not asked for it.
/// Idle is true when the source got no number for its utilisation and the town was told to read that as no use (whenEmpty: idle); the 0 shown is then an assumption.
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
    double RequestsPerSecond,
    double? Limit = null,
    bool? Idle = null);

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
/// builds only the connectors that these say exist. Assets are the island's resources that stand as basic buildings (see <see cref="AssetSnapshot"/>); null or empty: none.
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
    IReadOnlyList<NodeSnapshot> Nodes,
    IReadOnlyList<AssetSnapshot>? Assets = null);

/// <summary>
/// A third party outside the town (a credit bureau, a data warehouse). Node carries its health, worked out from our own calls to it:
/// request rate, error rate and p99 of the calls that go out, with the vendor's own thresholds. CalledBy lists the ids of our systems that call it.
/// A vendor with several services has one VendorSnapshot for each, all with the same IslandId (and IslandName): they stand on one island. Without IslandId the
/// vendor is its own island. Internal marks the company's own services outside the monitored platform. Calls lists the ids of the town systems the building was
/// seen calling through the API gateway (null when none).
/// </summary>
public sealed record VendorSnapshot(
    NodeSnapshot Node,
    IReadOnlyList<string> CalledBy,
    string? IslandId = null,
    string? IslandName = null,
    bool Internal = false,
    IReadOnlyList<string>? Calls = null);

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
/// OutsideRequestsPerSecond is the traffic no town system explains, summed over the APIs on screen: what reaches the airport. It is null while the environment
/// does not measure it (links.traffic), and the airport then adds up what the outside callers bring.
/// Cloud is what the environment calls its cloud (scope.cloud), for the words "not found in ..."; null: the renderer says "the inventory".
/// TrafficDensity is the town's trafficDensity setting: how many cars appear, as a multiple of the usual number (1).
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
    bool IncidentsSeen,
    double? OutsideRequestsPerSecond = null,
    string? Cloud = null,
    double TrafficDensity = 1,
    IReadOnlyList<string>? Notes = null);

/// <summary>An island the island filter left out.</summary>
public sealed record HiddenIsland(string Id, string DisplayName);

/// <summary>
/// Traffic between a system on screen and an island the filter left out. NodeId is the system on screen. Incoming is false when it calls a system on
/// the hidden island and true when a system there calls it. RequestsPerSecond is the traffic on the link (the callee's rate, shared evenly between its callers).
/// </summary>
/// <summary>
/// One host that calls from the town go to and no rule explains: how many calls over the days link discovery remembers, which town systems made them,
/// and on how many different days it was seen. Hosts that are a third party's or on the ignore list are never listed. Calls are sampling-corrected estimates.
/// </summary>
public sealed record UnknownHostSnapshot(string Host, double Calls, IReadOnlyList<string> Callers, int Days, bool Gateway = false, IReadOnlyList<UnknownPathSnapshot>? Paths = null, bool VendorsOnly = false);

/// <summary>
/// An entry of the town's _discovered/third-parties.yaml: Kind is vendor (a third party), internal (the company's own service) or ignore. Id is what Remove
/// asks for (the vendor's id, or the ignore pattern); Name is the name shown; Host is the host it stands for. CalledBy is who calls a vendor.
/// </summary>
public sealed record AddedHostSnapshot(string Id, string Name, string Host, string Kind, IReadOnlyList<string> CalledBy);

/// <summary>What the panel sends to add a rule for a path on a gateway host: the system that path belongs to.</summary>
public sealed record AddRuleRequest(string Host, string Path, string Target);

/// <summary>What the panel sends to add a host. The server works out who called it from what link discovery saw.</summary>
public sealed record AddHostRequest(string Host, string Kind);

/// <summary>
/// One path on a gateway host that no rule explains, with its calls. VendorsOnly is true when only vendor buildings (such as Digital Services) made them.
/// A gateway host is one a links rule reads the path of; it is not a service, so it is listed by these paths.
/// </summary>
public sealed record UnknownPathSnapshot(string Path, double Calls, bool VendorsOnly);

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

/// <summary>
/// A system (or third party) another system is linked to, with the island it stands on. Found is true for a link only link discovery knows (no file
/// declares it) and LastSeen is then the last day the telemetry showed it (yyyy-MM-dd); a declared link has neither.
/// </summary>
public sealed record LinkRef(string Id, string Name, LinkKind Kind, string IslandId, string IslandName, bool Found = false, string? LastSeen = null);

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
    IReadOnlyList<SubscriptionSnapshot> Subscriptions,
    ScopeInfo? Scope = null);

/// <summary>
/// Where a system lives and what its telemetry calls it, as the environment's scope rules resolve it. Null on a system when the environment has no
/// scope rules. Subscription and Workspace are null when the rules do not give one (WorkspaceVia: "id" when it was given as an id, "name" when it was found by its name); InventoryState is "none" (no inventory source), "waiting" (not read yet),
/// "read" or "failed". Problems are things the rules could not settle for this system.
/// </summary>
public sealed record ScopeInfo(
    string? Subscription,
    string? SubscriptionVia,
    string? Workspace,
    string? WorkspaceVia,
    string? ServiceCode,
    string? TelemetryRole,
    string? TelemetryRoleVia,
    IReadOnlyList<ScopeResource> Resources,
    int? Instances,
    IReadOnlyList<string> Problems,
    string InventoryState);

/// <summary>
/// A resource that belongs to a system. Tenant is the tenant's friendly name when the rules found one, else its id. Links are the addresses the
/// environment's <c>scope.links</c> make for it (a portal page, a runbook); null when the environment has none for this resource.
/// </summary>
public sealed record ScopeResource(string Name, string Type, string? Region, string? Tenant, int? Instances, IReadOnlyList<ResourceLink>? Links = null);

/// <summary>An address that opens a resource somewhere else (a cloud portal, a console), already filled in. The browser only shows it as a link.</summary>
public sealed record ResourceLink(string Name, string Url);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LogLevel
{
    Info,
    Warn,
    Error,
}

/// <summary>
/// What a system's Logs tab shows, read on demand and never part of its health: up to four separate sections (see <see cref="LogSection"/>) over the last
/// <see cref="Window"/>. Configured is false when the environment says nowhere to read from, so the tab says so instead of showing empty sections.
/// SlowOverMs is the latency line the slow requests are measured against (the system's own p99 SLA). At is when it was read.
/// </summary>
public sealed record SystemLogs(DateTimeOffset At, bool Configured, string Window, double SlowOverMs, IReadOnlyList<LogSection> Sections);

/// <summary>
/// One section of the Logs tab. Id is "failed" (5xx requests), "slow" (requests over the SLA), "logs" (warnings and errors) or "exceptions", so that a flood
/// in one never hides another. Groups are newest first; a repeat is one group with a count. Links open the telemetry store's own search for this section,
/// already filtered to the system, from the environment's <c>logs.links</c> (one for each store); null when the environment has none for the section.
/// </summary>
public sealed record LogSection(string Id, IReadOnlyList<LogGroup> Groups, IReadOnlyList<ResourceLink>? Links = null);

/// <summary>Entries that say the same thing, grouped: Count of them, the newest at At. DurationMs and Result (a status code, say) are those of the newest entry, when the source has them.</summary>
public sealed record LogGroup(DateTimeOffset At, LogLevel? Level, string Text, int Count, double? DurationMs, string? Result);
