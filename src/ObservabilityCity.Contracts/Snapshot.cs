using System.Text.Json.Serialization;

namespace ObservabilityCity.Contracts;

// The C# records in this file are the source of truth for the wire format.
// contracts/openapi.json and web/src/contracts.ts are generated from them (see README).

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
/// Calls lists the ids of the systems this one calls directly, as declared in the registry.
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
    DateTimeOffset? LastUpdated);

/// <summary>
/// An island (a pillar, a team, ...) or the hub island. IsLostFound marks the island that collects systems no group owns.
/// ConfigError is set when the group's registry file is broken and was skipped: the island is drawn as a "config error" island
/// with no buildings, and the text says what is wrong. It is null for every healthy island.
/// </summary>
public sealed record GroupSnapshot(
    string Id,
    string DisplayName,
    string Color,
    bool IsHub,
    bool IsLostFound,
    string? ConfigError,
    IReadOnlyList<NodeSnapshot> Nodes);

public sealed record TownTotals(
    double RequestsPerSecond,
    double ErrorRate,
    double P99Ms,
    int Degraded,
    int Down);

/// <summary>
/// The whole town at one moment. This is what is pushed to the browser.
/// Notices are problems with the configuration that did not stop the town: a reload that failed (the last good registry is still shown),
/// a call link that points nowhere and was dropped. The renderer lists them in the top bar.
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
    IReadOnlyList<GroupSnapshot> Groups);
