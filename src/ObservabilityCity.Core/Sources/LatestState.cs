using System.Collections.Concurrent;

namespace ObservabilityCity.Core.Sources;

/// <summary>The newest reading per node id. Sources write, the snapshot builder reads.</summary>
public sealed class LatestState
{
    private readonly ConcurrentDictionary<string, NodeReading> _readings = new();

    public void Update(IReadOnlyDictionary<string, NodeReading> readings)
    {
        foreach (var (id, reading) in readings) _readings[id] = reading;
    }

    public NodeReading? Get(string id) => _readings.GetValueOrDefault(id);
}
