using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Sources;

/// <summary>What one source knows about one node at one moment.</summary>
public sealed record NodeReading(
    DateTimeOffset At,
    bool Up,
    int InstancesTotal,
    int InstancesHealthy,
    double Load,
    double RequestsPerSecond,
    double ErrorRate,
    double P99Ms,
    double? Cpu = null,
    double? Memory = null,
    double? Utilisation = null,
    double? Throttled = null,
    double? QueueDepth = null,
    double? OldestMessageSeconds = null,
    double? DeadLetters = null,
    IReadOnlyList<TenantReading>? Tenants = null);

/// <summary>
/// One tenant's database of a data store that keeps one per tenant: how much of its provisioned capacity it uses, how much it turns away and the
/// request rate it sees. TenantId is whatever the source found in the database name; the environment may not list it.
/// </summary>
public sealed record TenantReading(string TenantId, double? Utilisation, double? Throttled, double RequestsPerSecond);

/// <summary>
/// One data source behind the town. The renderer never knows which one produced a number.
/// A source answers for every node it can, in a single batched call, and leaves out the rest.
/// </summary>
public interface IMetricSource
{
    string Name { get; }
    TimeSpan PollInterval { get; }
    Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(Registry.Registry registry, CancellationToken ct);
}
