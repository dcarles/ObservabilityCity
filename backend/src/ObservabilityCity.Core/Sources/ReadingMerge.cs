namespace ObservabilityCity.Core.Sources;

/// <summary>
/// Joins what several sources reported about one node into the reading the town shows. Each signal is taken from the source the registry says it
/// comes from, so instances can come from the inventory while errors come from telemetry.
/// </summary>
public static class ReadingMerge
{
    /// <summary>
    /// With one source's reading, that reading as it is (the case of every town with a single source). With several, each signal from its own source
    /// (<paramref name="sourceFor"/> gives the name, or null for none); a signal whose source has not reported is left empty. The node is up only if
    /// every source that counts says so, and is as old as the oldest of them, so a stale source is never hidden behind a fresh one.
    /// </summary>
    public static NodeReading? Merge(IReadOnlyDictionary<string, NodeReading> bySource, Func<string, string?> sourceFor)
    {
        if (bySource.Count == 0) return null;
        if (bySource.Count == 1) return bySource.Values.First();

        var used = new Dictionary<string, NodeReading>(StringComparer.Ordinal);
        NodeReading? Of(string signal)
        {
            if (sourceFor(signal) is not { } name || !bySource.TryGetValue(name, out var reading)) return null;
            used[name] = reading;
            return reading;
        }

        var requests = Of(Signals.Requests);
        var errors = Of(Signals.Errors);
        var latency = Of(Signals.Latency);
        var instances = Of(Signals.Instances);
        var cpu = Of(Signals.Cpu);
        var memory = Of(Signals.Memory);
        var utilisation = Of(Signals.Utilisation);
        var throttled = Of(Signals.Throttled);
        var backlog = Of(Signals.Backlog);
        var dead = Of(Signals.DeadLetters);
        if (used.Count == 0) return bySource.Values.MaxBy(r => r.At);

        return new NodeReading(
            used.Values.Min(r => r.At),
            used.Values.All(r => r.Up),
            instances?.InstancesTotal ?? 0,
            instances?.InstancesHealthy ?? 0,
            requests?.Load ?? 0,
            requests?.RequestsPerSecond ?? 0,
            errors?.ErrorRate ?? 0,
            latency?.P99Ms ?? 0,
            cpu?.Cpu,
            memory?.Memory,
            utilisation?.Utilisation,
            throttled?.Throttled,
            backlog?.QueueDepth,
            backlog?.OldestMessageSeconds,
            dead?.DeadLetters,
            utilisation?.Tenants);
    }
}
