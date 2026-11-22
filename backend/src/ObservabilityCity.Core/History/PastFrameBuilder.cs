using System.Diagnostics;
using Microsoft.Extensions.Logging;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.History;

/// <summary>A clock that stands still, so the readings of a past time are fresh when the frame for it is built.</summary>
public sealed class FixedClock(DateTimeOffset at) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => at;
}

/// <summary>
/// Builds the town as it was at a past time, with the same rules as the live town: the readings of every source that can read the past (<see cref="IPastMetricSource"/>) asked for that time
/// and, for the rest, what the live town last read. The rest is the inventory in practice: the instance counts of a rebuilt frame are today's (the cloud's change history of the instance
/// count is not read), which the frame says by being marked rebuilt. The cloud's own health reports (the red "!" on a building) are not rebuilt: a rebuilt frame has none. A source that cannot
/// read the past and is not the inventory leaves its signals absent. A source that fails fails the frame: nothing is invented and nothing partial is saved.
/// </summary>
public sealed class PastFrameBuilder(SnapshotBuilder live, LatestState liveState, Registry.IRegistryProvider registries, IReadOnlyList<IMetricSource> sources, ILogger? log = null)
{
    /// <summary>A read of the past that takes longer than this is written to the log, so a slow source can be seen.</summary>
    public static readonly TimeSpan SlowRead = TimeSpan.FromSeconds(30);

    /// <summary>Whether the environment has anything to rebuild a past from.</summary>
    public bool CanRebuild => sources.Any(s => s is IPastMetricSource { CanReadPast: true });

    /// <summary>The town at <paramref name="at"/>.</summary>
    public async Task<Snapshot> BuildAsync(DateTimeOffset at, CancellationToken ct)
    {
        var registry = registries.Current;
        var state = new LatestState();
        foreach (var source in sources)
        {
            if (source is IPastMetricSource { CanReadPast: true } past)
                state.Update(source.Name, await ReadAsync(past, registry, at, ct));
            else if (source is not IPastMetricSource && source is not IHealthEventSource)
                state.Update(source.Name, liveState.Of(source.Name)); // the inventory: today's instance counts
        }
        var builder = live.For(state, new FixedClock(at), [], () => at.ToLocalTime().TimeOfDay.TotalDays);
        return builder.Build();
    }

    private async Task<IReadOnlyDictionary<string, NodeReading>> ReadAsync(IPastMetricSource source, Registry.Registry registry, DateTimeOffset at, CancellationToken ct)
    {
        var clock = Stopwatch.StartNew();
        try
        {
            var readings = await source.PollAtAsync(registry, at, ct);
            if (clock.Elapsed > SlowRead)
                log?.LogWarning("History: the source {Source} was slow reading {At}: {Seconds:0} s", source.Name, at.ToString("O"), clock.Elapsed.TotalSeconds);
            return readings;
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            log?.LogWarning("History: the source {Source} failed reading {At} after {Seconds:0} s: {Reason}", source.Name, at.ToString("O"), clock.Elapsed.TotalSeconds, e.Message);
            throw;
        }
    }
}
