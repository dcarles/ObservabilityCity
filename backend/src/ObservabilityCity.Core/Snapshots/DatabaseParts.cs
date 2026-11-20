using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>
/// The rules for a database a source splits into parts (the shared pool and the pieces with capacity of their own). Each part is judged on its own numbers with the
/// database's thresholds. The database is red when its shared pool is red, because everything on the pool is affected, or when every part is red. When only
/// dedicated parts are in trouble it is amber at most: it is partly affected, and the part that is named is the one to look at.
/// </summary>
internal static class DatabaseParts
{
    /// <summary>The state one part's own numbers give: red from the red thresholds, amber from the amber ones.</summary>
    public static HealthState StateOf(RegistryNode n, PartReading p)
    {
        var u = p.Utilisation ?? 0;
        var th = p.Throttled ?? 0;
        return u >= n.ResourceRed || th >= n.ThrottleRed ? HealthState.Down
            : u >= n.ResourceAmber || th >= n.ThrottleAmber ? HealthState.Degraded
            : HealthState.Healthy;
    }

    /// <summary>The parts as the snapshot shows them: the shared pool first, then the dedicated parts by name. A test tenant's parts are amber at most.</summary>
    public static List<PartSnapshot> Snapshots(RegistryNode n, IReadOnlyList<PartReading> parts, bool test) =>
        parts.OrderBy(p => p.Kind).ThenBy(p => p.Name, StringComparer.Ordinal)
            .Select(p =>
            {
                var state = StateOf(n, p);
                if (test && state == HealthState.Down) state = HealthState.Degraded;
                return new PartSnapshot(p.Name, p.Kind, state, p.Utilisation, p.Throttled, p.RequestsPerSecond, p.Limit, p.Idle);
            }).ToList();

    /// <summary>The database's state from its parts: red when the shared pool is red or every part is, amber when any part is not healthy, healthy otherwise.</summary>
    public static HealthState StateOf(IReadOnlyList<PartSnapshot> parts)
    {
        if (parts.Any(p => p.Kind == PartKind.Shared && p.State == HealthState.Down) || parts.All(p => p.State == HealthState.Down)) return HealthState.Down;
        return parts.Any(p => p.State is HealthState.Degraded or HealthState.Down) ? HealthState.Degraded : HealthState.Healthy;
    }

    /// <summary>The part in the most trouble: the one turning away the most requests, then the one using the most of its capacity. Null when every part is healthy.</summary>
    public static PartSnapshot? Worst(IReadOnlyList<PartSnapshot>? parts) =>
        parts?.Where(p => p.State is HealthState.Degraded or HealthState.Down)
            .OrderByDescending(p => p.Throttled ?? 0).ThenByDescending(p => p.Utilisation ?? 0).ThenBy(p => p.Kind).ThenBy(p => p.Name, StringComparer.Ordinal).FirstOrDefault();
}
