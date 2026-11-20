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
    /// <summary>
    /// A data store's utilisation pushed up by up to 60 points, so it starts throttling. On a store with a database for each tenant it hits every tenant's
    /// database, unless the target names one tenant: "ldg.ledger-db#acme" (or "*#acme" for that tenant in every store).
    /// </summary>
    Saturate,
    /// <summary>A consumer slows to a crawl, so its queue grows and its oldest message ages.</summary>
    Backlog,
    /// <summary>Poison messages: up to 8 a second go to the dead-letter queue.</summary>
    Poison,
    /// <summary>The source stops answering for the target, so its readings age into the stale state. Intensity is ignored.</summary>
    Stale,
    /// <summary>
    /// An incident assigned to the target's island (a group id, a system's group, or "*" for every island, the hub too). Intensity sets the
    /// severity: 0.85 or more is sev 1, 0.6 sev 2, 0.35 sev 3, below that sev 4. Down, Errors and the other effects on a vendor
    /// show up in the calls our systems make to it, which is how a real third party's health would be read.
    /// </summary>
    Incident,
}

/// <summary>
/// A scenario effect layered on the baseline. Target is a node id, a group id (a whole island) or "*". A Saturate effect may add "#tenant" to
/// hit one tenant's database only, and "/part" to hit one part of a database that has parts (see <c>parts</c> in fake.yaml): "ldg.ledger-db/audit-log" or
/// "ldg.ledger-db#acme/audit-log".
/// </summary>
public sealed record FakeEffect(string Id, string Target, FakeEffectKind Kind, double Intensity)
{
    private int Cut => Target.IndexOfAny(['#', '/']);

    /// <summary>The node, group or "*" the effect is aimed at, without the tenant and the part.</summary>
    public string Scope => Cut < 0 ? Target : Target[..Cut];

    /// <summary>The one tenant it is aimed at, or null for all of them.</summary>
    public string? Tenant
    {
        get
        {
            var at = Target.IndexOf('#');
            if (at < 0) return null;
            var end = Target.IndexOf('/', at);
            return end < 0 ? Target[(at + 1)..] : Target[(at + 1)..end];
        }
    }

    /// <summary>The one part of a database it is aimed at, or null for the whole database.</summary>
    public string? Part => Target.IndexOf('/') is var at and >= 0 ? Target[(at + 1)..] : null;
}

/// <summary>How the app (the Break things panel and the story player) steers the generator.</summary>
public interface IFakeControl
{
    bool Calm { get; set; }
    IReadOnlyList<FakeEffect> Effects { get; }
    FakeEffect Add(string target, FakeEffectKind kind, double intensity);
    bool Remove(string id);
    void Clear();
    /// <summary>Removes every effect, stops the story, and forgets the backlog, dead letters and autoscaling the effects left behind, back to a calm baseline.</summary>
    void Reset();
    /// <summary>Changes how strong an effect set by hand is. False when there is no such effect.</summary>
    bool SetIntensity(string id, double intensity);
    /// <summary>The story player: timelines of the same effects, layered beside the ones set by hand.</summary>
    StoryPlayer Story { get; }
    /// <summary>Real seconds one simulated day takes. Changing it keeps the time of day where it is.</summary>
    double DayLengthSeconds { get; set; }
}
