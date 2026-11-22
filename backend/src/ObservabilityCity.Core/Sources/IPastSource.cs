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

    /// <summary>
    /// What the last <see cref="PollAtAsync"/> could not say, for the log (never for the town): a source that leaves some signal out of a past frame instead of failing it (the cloud has no history
    /// of it) says why here. Null when it said everything it was asked.
    /// </summary>
    string? PastNote => null;
}
