using System.Collections.Concurrent;

namespace ObservabilityCity.Core.Sources;

/// <summary>
/// The newest reading per node id and per source. Sources write, the snapshot builder reads. Keeping each source's reading apart is what lets a
/// building take its instance count from one source and its error rate from another (see <see cref="ReadingMerge"/>).
/// </summary>
public sealed class LatestState
{
    /// <summary>The name a reading is kept under when its writer does not say which source it is.</summary>
    public const string Unnamed = "";

    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, NodeReading>> _readings = new();

    public void Update(IReadOnlyDictionary<string, NodeReading> readings) => Update(Unnamed, readings);

    public void Update(string source, IReadOnlyDictionary<string, NodeReading> readings)
    {
        foreach (var (id, reading) in readings)
            _readings.GetOrAdd(id, _ => new(StringComparer.Ordinal))[source] = reading;
    }

    /// <summary>The newest reading of the node from any source, or null.</summary>
    public NodeReading? Get(string id) =>
        _readings.TryGetValue(id, out var bySource) ? bySource.Values.MaxBy(r => r.At) : null;

    /// <summary>Every source's newest reading of the node, by source name; empty when none has reported.</summary>
    public IReadOnlyDictionary<string, NodeReading> GetAll(string id) =>
        _readings.TryGetValue(id, out var bySource) ? new Dictionary<string, NodeReading>(bySource) : new Dictionary<string, NodeReading>();
}
