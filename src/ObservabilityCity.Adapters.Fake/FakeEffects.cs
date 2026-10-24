namespace ObservabilityCity.Adapters.Fake;

public enum FakeEffectKind
{
    /// <summary>Request rate multiplied by 1 + 4 x intensity.</summary>
    Traffic,
    /// <summary>Error rate raised to 3% + 30% x intensity.</summary>
    Errors,
    /// <summary>p99 multiplied by 1 + 9 x intensity.</summary>
    Latency,
    /// <summary>Share of instances that are unhealthy (0 to 1).</summary>
    UnhealthyInstances,
    /// <summary>Every instance down. Intensity is ignored.</summary>
    Down,
    /// <summary>CPU raised by up to 55 points.</summary>
    HighCpu,
    /// <summary>Memory raised by up to 50 points, like a leak.</summary>
    HighMemory,
    /// <summary>A data store's utilisation pushed up by up to 60 points, so it starts throttling.</summary>
    Saturate,
}

/// <summary>A scenario effect layered on the baseline. Target is a node id, a group id (a whole island) or "*".</summary>
public sealed record FakeEffect(string Id, string Target, FakeEffectKind Kind, double Intensity);

/// <summary>How the app (and later the Break things panel) steers the generator.</summary>
public interface IFakeControl
{
    bool Calm { get; set; }
    IReadOnlyList<FakeEffect> Effects { get; }
    FakeEffect Add(string target, FakeEffectKind kind, double intensity);
    bool Remove(string id);
    void Clear();
}
