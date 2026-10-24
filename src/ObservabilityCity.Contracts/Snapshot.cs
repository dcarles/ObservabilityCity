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
/// Load is the share of capacity in use (0 idle, 1 full, above 1 saturated); each source works it out its own way.
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
    double RequestsPerSecond,
    double ErrorRate,
    double P99Ms,
    double SlaP99Ms,
    double ErrorAmber,
    double ErrorRed,
    DateTimeOffset? LastUpdated);

/// <summary>An island (a pillar, a team, ...) or the hub island.</summary>
public sealed record GroupSnapshot(
    string Id,
    string DisplayName,
    string Color,
    bool IsHub,
    IReadOnlyList<NodeSnapshot> Nodes);

public sealed record TownTotals(
    double RequestsPerSecond,
    double ErrorRate,
    double P99Ms,
    int Degraded,
    int Down);

/// <summary>The whole town at one moment. This is what is pushed to the browser.</summary>
public sealed record Snapshot(
    string TownId,
    string TownName,
    string GroupLabel,
    string Environment,
    DateTimeOffset GeneratedAt,
    double DayFraction,
    TownTotals Totals,
    IReadOnlyList<GroupSnapshot> Groups);
