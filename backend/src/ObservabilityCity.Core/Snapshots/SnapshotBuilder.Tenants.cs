using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>The tenants of the town and the units of a tenanted data store. Part of <see cref="SnapshotBuilder"/>.</summary>
public sealed partial class SnapshotBuilder
{
    /// <summary>
    /// The environment's tenants with the share of traffic each brings: its share of the request rate its tenant databases see, or, until a tenant
    /// database reports anything, an even split in which a test tenant counts a tenth of a customer. Tenants the data shows that the environment does
    /// not list come last, as unknown.
    /// </summary>
    internal static List<TenantInfo> TenantsOf(RegistryEnvironment? env, IReadOnlyList<NodeSnapshot> nodes)
    {
        var declared = env?.Tenants ?? [];
        var declaredKeys = declared.Select(t => Scope.ScopeResolver.TenantKey(t.Id)).ToHashSet();
        var seen = new Dictionary<string, double>(); // tenant key to the request rate its databases see
        var reported = new HashSet<string>(); // tenants some database really reported (a unit that was not found is grey and does not count)
        var found = new SortedDictionary<string, (string Id, string Name, TenantKind Kind)>(StringComparer.Ordinal); // tenants the list lacks
        foreach (var unit in nodes.Where(n => n.State != HealthState.Stale).SelectMany(n => n.Tenants ?? []))
        {
            var key = Scope.ScopeResolver.TenantKey(unit.Id);
            seen[key] = seen.GetValueOrDefault(key) + unit.RequestsPerSecond;
            if (unit.State != HealthState.Stale) reported.Add(key);
            if (!declaredKeys.Contains(key)) found.TryAdd(key, (unit.Id, unit.Name, unit.Kind));
        }
        var all = declared.Select(t => (Key: Scope.ScopeResolver.TenantKey(t.Id), Id: t.Id, Name: t.Name, Kind: t.Kind))
            .Concat(found.Select(f => (Key: f.Key, Id: f.Value.Id, Name: f.Value.Name, Kind: f.Value.Kind))).ToList();
        if (all.Count == 0) return [];
        var total = all.Sum(t => seen.GetValueOrDefault(t.Key));
        double Weight(string key, TenantKind kind) => total > 0 ? seen.GetValueOrDefault(key) : kind == TenantKind.Test ? 0.1 : 1.0;
        var sum = all.Sum(t => Weight(t.Key, t.Kind));
        // a listed tenant nobody reports is "not found", but only when every tenant store is reporting and some tenant is: otherwise the data is not in yet
        var stores = nodes.Where(n => n.Tenants is { Count: > 0 }).ToList();
        var judge = stores.Count > 0 && stores.All(n => n.State != HealthState.Stale) && reported.Count > 0;
        return all.Select(t => new TenantInfo(t.Id, t.Name, t.Kind, sum > 0 ? Weight(t.Key, t.Kind) / sum : 0, judge && declaredKeys.Contains(t.Key) && !reported.Contains(t.Key))).ToList();
    }

    /// <summary>The units of a tenant store with no fresh data: every tenant the environment lists, grey.</summary>
    private static List<TenantUnitSnapshot> StaleUnits(RegistryNode n, RegistryEnvironment? env) =>
        (env?.Tenants ?? []).Select(t => new TenantUnitSnapshot(t.Id, t.Name, t.Kind, RegistryEnvironment.DatabaseName(n.TenantPattern!, t.Id), HealthState.Stale, null, null, 0)).ToList();

    /// <summary>
    /// One unit for each tenant: first the tenants the environment lists, in its order (grey when no database was found for one), then the ones the
    /// data shows that it does not list: a customer under the name the source gave it, or unknown when the source has no name for it. A unit is amber when its database runs hot or throttles and red when it is past the red
    /// thresholds; a test tenant is never red.
    /// </summary>
    private static List<TenantUnitSnapshot> TenantUnits(RegistryNode n, NodeReading r, RegistryEnvironment? env)
    {
        // a source finds a tenant id with or without dashes and in any case; the list may spell it either way
        var found = (r.Tenants ?? []).GroupBy(t => Scope.ScopeResolver.TenantKey(t.TenantId)).ToDictionary(g => g.Key, g => g.First());
        var units = new List<TenantUnitSnapshot>();
        foreach (var t in env?.Tenants ?? [])
            units.Add(found.TryGetValue(Scope.ScopeResolver.TenantKey(t.Id), out var reading)
                ? Unit(n, r, reading, t.Name, t.Kind)
                : new TenantUnitSnapshot(t.Id, t.Name, t.Kind, RegistryEnvironment.DatabaseName(n.TenantPattern!, t.Id), HealthState.Stale, null, null, 0));
        var listed = (env?.Tenants ?? []).Select(t => Scope.ScopeResolver.TenantKey(t.Id)).ToHashSet();
        foreach (var reading in found.Values.Where(t => !listed.Contains(Scope.ScopeResolver.TenantKey(t.TenantId))).OrderBy(t => t.TenantId, StringComparer.Ordinal))
            units.Add(reading.Name is { Length: > 0 } known ? Unit(n, r, reading, known, TenantKind.Customer) : Unit(n, r, reading, reading.TenantId, TenantKind.Unknown));
        return units;
    }

    private static TenantUnitSnapshot Unit(RegistryNode n, NodeReading r, TenantReading t, string name, TenantKind kind)
    {
        var u = t.Utilisation ?? 0;
        var th = t.Throttled ?? 0;
        var state = !r.Up || u >= n.ResourceRed || th >= n.ThrottleRed ? HealthState.Down
            : u >= n.ResourceAmber || th >= n.ThrottleAmber ? HealthState.Degraded
            : HealthState.Healthy;
        if (kind == TenantKind.Test && state == HealthState.Down) state = HealthState.Degraded; // test tenants raise amber at most
        return new TenantUnitSnapshot(t.TenantId, name, kind, RegistryEnvironment.DatabaseName(n.TenantPattern!, t.TenantId), state, t.Utilisation, t.Throttled, t.RequestsPerSecond, t.Limit, t.Idle);
    }

    /// <summary>
    /// The store's own utilisation and throttling: the worst of the customer and unknown tenants. With only test tenants to go by they are held just
    /// under the red thresholds, so a test tenant's trouble makes the store amber and never red.
    /// </summary>
    private static (double? Utilisation, double? Throttled) Aggregate(RegistryNode n, List<TenantUnitSnapshot> units, NodeReading r)
    {
        var live = units.Where(u => u.State != HealthState.Stale).ToList();
        if (live.Count == 0) return (r.Utilisation, r.Throttled); // no tenant database reported: the store's own numbers stand
        var real = live.Where(u => u.Kind != TenantKind.Test).ToList();
        var from = real.Count > 0 ? real : live;
        var utilisation = from.Max(u => u.Utilisation ?? 0);
        var throttled = from.Max(u => u.Throttled ?? 0);
        if (real.Count == 0)
        {
            utilisation = Math.Min(utilisation, n.ResourceRed * 0.999);
            throttled = Math.Min(throttled, n.ThrottleRed * 0.999);
        }
        return (utilisation, throttled);
    }
}
