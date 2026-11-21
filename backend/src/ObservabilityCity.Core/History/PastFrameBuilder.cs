using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.History;

/// <summary>A clock that stands still, so the readings of a past time are fresh when the frame for it is built.</summary>
public sealed class FixedClock(DateTimeOffset at) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => at;
}

/// <summary>A list of health reports given outright, for the frame of a past time.</summary>
public sealed class FrozenHealth(string name, IReadOnlyList<ResourceHealthEvent> events) : IHealthEventSource
{
    public string Name => name;
    public IReadOnlyList<ResourceHealthEvent> Current() => events;
    public string? Problem => null;
    public bool Dismiss(string id) => false;
}

/// <summary>
/// Builds the town as it was at a past time, with the same rules as the live town: the readings of every source that can read the past (<see cref="IPastMetricSource"/>) asked for that time,
/// the cloud's health reports that were open then (<see cref="IPastHealthSource"/>), and, for the rest, what the live town last read. The rest is the inventory in practice: the instance
/// counts of a rebuilt frame are today's (the cloud's change history of the instance count is not read), which the frame says by being marked rebuilt. A source that cannot read the
/// past and is not the inventory leaves its signals absent. A source that fails fails the frame: nothing is invented and nothing partial is saved.
/// </summary>
public sealed class PastFrameBuilder(SnapshotBuilder live, LatestState liveState, Registry.IRegistryProvider registries, IReadOnlyList<IMetricSource> sources)
{
    /// <summary>Whether the environment has anything to rebuild a past from.</summary>
    public bool CanRebuild => sources.Any(s => s is IPastMetricSource { CanReadPast: true } || s is IPastHealthSource);

    /// <summary>
    /// The town at <paramref name="at"/>. <paramref name="health"/> is the reports of every health source, read once for the whole stretch (see <see cref="IPastHealthSource.ReadSinceAsync"/>),
    /// keyed by the source's name.
    /// </summary>
    public async Task<Snapshot> BuildAsync(DateTimeOffset at, IReadOnlyDictionary<string, Func<DateTimeOffset, IReadOnlyList<ResourceHealthEvent>>> health, CancellationToken ct)
    {
        var registry = registries.Current;
        var state = new LatestState();
        foreach (var source in sources)
        {
            if (source is IPastMetricSource { CanReadPast: true } past)
                state.Update(source.Name, await past.PollAtAsync(registry, at, ct));
            else if (source is not IPastMetricSource && source is not IHealthEventSource)
                state.Update(source.Name, liveState.Of(source.Name)); // the inventory: today's instance counts
        }
        var reports = health.Select(h => (IHealthEventSource)new FrozenHealth(h.Key, h.Value(at))).ToList();
        var builder = live.For(state, new FixedClock(at), reports, () => at.ToLocalTime().TimeOfDay.TotalDays);
        return builder.Build();
    }
}
