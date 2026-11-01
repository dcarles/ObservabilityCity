using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Sources;

/// <summary>
/// What one source knows about one node at one moment. <c>Calls</c> is how many requests the rate, error share and latency were measured over (a source
/// that counts them over a window says so here); the town compares it with the system's <c>minCalls</c> and calls a system with fewer quiet. Null: the
/// source does not count, so nothing is ever quiet.
/// </summary>
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
    IReadOnlyList<TenantReading>? Tenants = null,
    double? Calls = null,
    AppState? App = null,
    IReadOnlyList<JobReading>? Jobs = null,
    IReadOnlyList<RegionReading>? Regions = null);

/// <summary>
/// What one region of a service reports: how many instances it runs, and how busy its plan is, and Share is the part of the service's requests it took (0 to 1, the regions add up to 1; null when nothing measures it). Region is the label the scope rules gave (see <c>scope.regions</c>).
/// A field the source cannot tell is null.
/// </summary>
public sealed record RegionReading(string Region, int? Instances, double? Cpu, double? Memory, double? Share = null);

/// <summary>
/// One scheduled job as a log source saw it in one region: when it last ran, whether that run succeeded (null: unknown) and when its schedule says it runs
/// next (null: the logs did not say). The town works out from these whether the job is overdue.
/// </summary>
public sealed record JobReading(string Name, string? Region, DateTimeOffset? LastRun, bool? Succeeded, DateTimeOffset? Next);

/// <summary>
/// One tenant's database of a data store that keeps one per tenant: how much of its provisioned capacity it uses, how much it turns away and the
/// request rate it sees. TenantId is whatever the source found in the database name; the environment may not list it. Name is what the source
/// knows the tenant as (a tag on the database, say), so a tenant the environment does not list can still be shown by name. Limit is the capacity
/// provisioned for the database as a plain number in the store's unit (request units per second), when the source is asked to read it.
/// </summary>
public sealed record TenantReading(string TenantId, double? Utilisation, double? Throttled, double RequestsPerSecond, string? Name = null, double? Limit = null);

/// <summary>
/// One data source behind the town. The renderer never knows which one produced a number.
/// A source answers for every node it can, in a single batched call, and leaves out the rest.
/// </summary>
public interface IMetricSource
{
    string Name { get; }
    TimeSpan PollInterval { get; }

    /// <summary>How long one poll may take before the poller gives up on it. A real source takes it from its definition in the environment file.</summary>
    TimeSpan Timeout => TimeSpan.FromSeconds(Registry.RegistrySource.DefaultTimeoutSeconds);
    Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(Registry.Registry registry, CancellationToken ct);
}

/// <summary>
/// A source that reads many things one by one can hand over each node's reading as soon as it has it, instead of all of them at the end, so the town fills
/// in as the reads finish. The poller uses this when a source offers it. <c>PollAsync</c> with a callback may still end in an error after it has published
/// what it could, and the poller counts that as a failed poll for the log only.
/// </summary>
public interface IProgressiveMetricSource : IMetricSource
{
    Task PollAsync(Registry.Registry registry, Action<IReadOnlyDictionary<string, NodeReading>> publish, CancellationToken ct);
}
