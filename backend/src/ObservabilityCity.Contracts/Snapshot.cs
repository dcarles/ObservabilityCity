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
    DateTimeOffset? LastUpdated);

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
/// HasBridge says whether a bridge joins the island to the hub: it has an API, or a call link crosses its coast. Without one the island is
/// reached only by boat (or by nothing at all). Messaging lists its topics and subscriptions; an island with neither has no pier. The renderer
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
    int RingCapacity);
