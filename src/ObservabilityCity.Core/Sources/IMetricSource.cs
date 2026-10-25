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
    double? DeadLetters = null);

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
