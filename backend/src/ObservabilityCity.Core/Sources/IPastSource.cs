using ObservabilityCity.Contracts;

namespace ObservabilityCity.Core.Sources;

/// <summary>
/// A source that can also say how things were at a past time, so the history of a town that was not being recorded can be rebuilt. It answers with the same readings, built by the same
/// rules, as a live poll would have at that moment. A source that cannot read the past (a recording, a cloud with no history) simply does not offer this, and the rebuilt frame has nothing
/// from it: absent, never invented. A read that fails throws, so a frame made from only some of its sources is never saved as if it were whole.
/// </summary>
public interface IPastMetricSource : IMetricSource
{
    /// <summary>False when this source cannot read the past (it replays a recording): the rebuild leaves it out, so its signals are absent from rebuilt frames.</summary>
    bool CanReadPast { get; }

    /// <summary>The readings as of <paramref name="at"/>, from the window that ended then. Many frames of one day may be asked in a row: a source may keep what it read to answer the next one.</summary>
    Task<IReadOnlyDictionary<string, NodeReading>> PollAtAsync(Registry.Registry registry, DateTimeOffset at, CancellationToken ct);
}

/// <summary>
/// A source of the cloud's own health reports that can say which were open at a past time. <see cref="ReadSinceAsync"/> reads what the cloud logged from a time until now once; the list for
/// each frame is then worked out from it with no more reads.
/// </summary>
public interface IPastHealthSource : IHealthEventSource
{
    /// <summary>Reads the cloud's log from <paramref name="from"/> and returns a function that gives the reports open at any time from then on.</summary>
    Task<Func<DateTimeOffset, IReadOnlyList<ResourceHealthEvent>>> ReadSinceAsync(Registry.Registry registry, DateTimeOffset from, CancellationToken ct);
}
