using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
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
/// and, for the rest, what the live town last read. The rest is the inventory in practice: the instance counts of a rebuilt frame are worked out from the cloud's change history (see the resource graph source); where the history has nothing they are left out. The cloud's own health reports (the red "!" on a building) are not rebuilt: a rebuilt frame has none. A source that cannot
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

    private readonly ConcurrentDictionary<string, double> _spent = new();

    /// <summary>
    /// What the frames built since the last call cost, for the log of a rebuilt hour: for each source the seconds spent reading it and, when it can say, how much it asked the cloud
    /// (answers read, their size, frames answered from what was already read, reads that were too big and were made again in smaller pieces). Reading it resets it.
    /// </summary>
    public string TakeSummary()
    {
        var parts = new List<string>();
        foreach (var source in sources)
        {
            if (source is not IPastMetricSource) continue;
            var seconds = _spent.TryRemove(source.Name, out var s) ? s : 0;
            var text = $"{source.Name} {seconds:0.0} s";
            if (source is IPastReadStats stats && stats.TakeStats() is { } r)
                text += $" ({r.Calls} reads, {r.Megabytes:0.0} MB, {r.CacheHits} from what was already read{(r.Splits > 0 ? $", {r.Splits} too big and read in pieces" : "")}" +
                        $"{(r.Batched > 0 ? $", {r.Batched} resources read in batches" : "")}{(r.Singly > 0 ? $", {r.Singly} read one by one" : "")}{(r.Note is not null ? $"; a batch failed: {r.Note}" : "")})";
            parts.Add(text);
        }
        return string.Join("; ", parts);
    }

    private async Task<IReadOnlyDictionary<string, NodeReading>> ReadAsync(IPastMetricSource source, Registry.Registry registry, DateTimeOffset at, CancellationToken ct)
    {
        var clock = Stopwatch.StartNew();
        try
        {
            var readings = await source.PollAtAsync(registry, at, ct);
            _spent.AddOrUpdate(source.Name, clock.Elapsed.TotalSeconds, (_, was) => was + clock.Elapsed.TotalSeconds);
            if (clock.Elapsed > SlowRead)
                log?.LogWarning("History: the source {Source} was slow reading {At}: {Seconds:0} s", source.Name, at.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture), clock.Elapsed.TotalSeconds);
            else
                log?.LogInformation("History: read {At} from the source {Source}: {Count} readings in {Seconds:0.0} s", at.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture), source.Name, readings.Count, clock.Elapsed.TotalSeconds);
            if (source.PastNote is { } note)
                log?.LogWarning("History: the source {Source} left something out of {At}: {Note}", source.Name, at.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture), note);
            return readings;
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            log?.LogWarning("History: the source {Source} failed reading {At} after {Seconds:0} s: {Reason}", source.Name, at.ToString("O"), clock.Elapsed.TotalSeconds, e.Message);
            throw;
        }
    }
}
