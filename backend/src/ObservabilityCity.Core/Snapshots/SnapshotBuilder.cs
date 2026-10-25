using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>Joins the registry with the latest readings and applies the rules that decide each node's state.</summary>
public sealed class SnapshotBuilder(IRegistryProvider registries, LatestState state, TimeProvider clock)
{
    /// <summary>A builder for a registry that never changes.</summary>
    public SnapshotBuilder(Registry.Registry registry, LatestState state, TimeProvider clock)
        : this(new RegistryHolder(registry), state, clock)
    {
    }

    /// <summary>Readings older than this are shown as stale, never as healthy.</summary>
    public TimeSpan StaleAfter { get; init; } = TimeSpan.FromSeconds(30);

    public string Environment { get; init; } = "demo";

    public Func<double> DayFraction { get; init; } = () => 0.5;

    /// <summary>Where open incidents come from. Without a source, the sky is clear.</summary>
    public IReadOnlyList<IIncidentSource> IncidentSources { get; init; } = [];

    public Snapshot Build()
    {
        var now = clock.GetUtcNow();
        var registry = registries.Current;
        var incidents = OpenIncidents(registry);
        var groups = registry.Groups
            .Select(g => new GroupSnapshot(g.Id, g.DisplayName, g.Color, g.IsHub, g.IsLostFound, g.ConfigError,
                incidents.GetValueOrDefault(g.Id) ?? [], g.Nodes.Select(n => ToNode(n, now)).ToList()))
            .ToList();
        var vendors = registry.Vendors.Select(v => new VendorSnapshot(ToNode(v.Node, now), v.CalledBy)).ToList();

        var nodes = groups.SelectMany(g => g.Nodes).ToList();
        var live = nodes.Where(n => n.State != HealthState.Stale).ToList();
        var rps = live.Sum(n => n.RequestsPerSecond);
        // vendors count toward degraded and down (they have buildings and sit in the lists), but not toward the town's own traffic
        var liveVendors = vendors.Select(v => v.Node).Where(n => n.State != HealthState.Stale).ToList();
        var totals = new TownTotals(
            rps,
            rps > 0 ? live.Sum(n => n.RequestsPerSecond * n.ErrorRate) / rps : 0,
            RequestWeightedP99(live),
            live.Concat(liveVendors).Count(n => n.State == HealthState.Degraded),
            live.Concat(liveVendors).Count(n => n.State == HealthState.Down),
            groups.Sum(g => g.Incidents.Count));

        var byId = nodes.Concat(vendors.Select(v => v.Node)).ToDictionary(n => n.Id);
        return new Snapshot(registry.Town.Id, registry.Town.Name, registry.Town.GroupLabel, Environment, now, DayFraction(), totals, registries.Notices, groups,
            vendors, ExternalCallers(registry, byId), Dependencies(registry, byId), registry.RingCapacity);
    }

    /// <summary>Open incidents per group, worst first. Incidents for a group the registry lacks are dropped.</summary>
    private Dictionary<string, IReadOnlyList<IncidentSnapshot>> OpenIncidents(Registry.Registry registry)
    {
        var known = registry.Groups.Select(g => g.Id).ToHashSet();
        return IncidentSources
            .SelectMany(src => src.Current(registry))
            .Where(i => known.Contains(i.GroupId))
            .GroupBy(i => i.GroupId)
            .ToDictionary(
                g => g.Key,
                g => (IReadOnlyList<IncidentSnapshot>)g.OrderBy(i => i.Severity).ThenBy(i => i.StartedAt)
                    .Select(i => new IncidentSnapshot(i.Id, i.Title, Math.Clamp(i.Severity, 1, 4), i.StartedAt)).ToList());
    }

    /// <summary>
    /// What each outside caller brings in. An external system's rate is shared evenly between the outside callers that reach it, until a
    /// source reports who the callers are.
    /// </summary>
    private static List<ExternalCallerSnapshot> ExternalCallers(Registry.Registry registry, Dictionary<string, NodeSnapshot> byId)
    {
        var reached = registry.ExternalCallers.SelectMany(c => c.Calls).GroupBy(id => id).ToDictionary(g => g.Key, g => g.Count());
        return registry.ExternalCallers
            .Select(c => new ExternalCallerSnapshot(c.Id, c.Name, c.Calls.Sum(id => byId.TryGetValue(id, out var n) ? n.RequestsPerSecond / reached[id] : 0), c.Calls))
            .ToList();
    }

    /// <summary>
    /// Traffic between groups, and from groups to vendors, for the dependency overlay. A system's rate is shared evenly between the systems that
    /// call it, until a source reports each link's own rate. Calls within a group are not listed.
    /// </summary>
    private static List<DependencySnapshot> Dependencies(Registry.Registry registry, Dictionary<string, NodeSnapshot> byId)
    {
        var links = new Dictionary<(string From, string To), double>();
        var callers = new Dictionary<string, List<RegistryNode>>(); // callee id to the systems that call it
        foreach (var n in registry.AllNodes)
            foreach (var callee in n.Calls.Concat(n.GatewayCalls))
                (callers.TryGetValue(callee, out var l) ? l : callers[callee] = []).Add(n);
        var groupOf = registry.AllNodes.ToDictionary(n => n.Id, n => n.GroupId);
        foreach (var v in registry.Vendors)
            foreach (var caller in v.CalledBy)
                if (groupOf.ContainsKey(caller))
                    (callers.TryGetValue(v.Node.Id, out var l) ? l : callers[v.Node.Id] = []).Add(registry.AllNodes.First(n => n.Id == caller));

        foreach (var (callee, from) in callers)
        {
            if (!byId.TryGetValue(callee, out var snap) || snap.State == HealthState.Stale) continue;
            var to = groupOf.GetValueOrDefault(callee, callee); // a vendor stands on its own
            var share = snap.RequestsPerSecond / from.Count;
            foreach (var caller in from)
            {
                if (caller.GroupId == to) continue;
                links[(caller.GroupId, to)] = links.GetValueOrDefault((caller.GroupId, to)) + share;
            }
        }
        return links.OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key.From, StringComparer.Ordinal).ThenBy(kv => kv.Key.To, StringComparer.Ordinal)
            .Select(kv => new DependencySnapshot(kv.Key.From, kv.Key.To, kv.Value)).ToList();
    }

    /// <summary>Headline latency: p99 averaged over request-serving nodes, weighted by traffic. Workers and crons are left out.</summary>
    private static double RequestWeightedP99(List<NodeSnapshot> live)
    {
        var serving = live.Where(n => n.Kind is NodeKind.Api or NodeKind.Gateway).ToList();
        var rps = serving.Sum(n => n.RequestsPerSecond);
        return rps > 0 ? serving.Sum(n => n.P99Ms * n.RequestsPerSecond) / rps : 0;
    }

    private NodeSnapshot ToNode(RegistryNode n, DateTimeOffset now)
    {
        var r = state.Get(n.Id);
        if (r is null || now - r.At > StaleAfter)
        {
            // No fresh data: keep the last numbers out of it. Grey, never green.
            return new NodeSnapshot(n.Id, n.Name, n.Kind, n.Service, n.External, HealthState.Stale, 0, 0, 0, null, null, null, null, null, null, null, 0, 0, 0,
                n.SlaP99Ms, n.ErrorAmber, n.ErrorRed, n.ResourceAmber, n.ResourceRed, n.ThrottleAmber, n.ThrottleRed, n.BacklogAmber, n.BacklogRed, n.Calls, n.GatewayCalls, r?.At);
        }

        // Degraded: errors, slow, unhealthy instances, a resource running hot, a data store turning requests away, or a consumer running late.
        var hot = Math.Max(Math.Max(r.Cpu ?? 0, r.Memory ?? 0), r.Utilisation ?? 0) >= n.ResourceAmber;
        var health = !r.Up ? HealthState.Down
            : r.ErrorRate >= n.ErrorAmber || r.P99Ms > n.SlaP99Ms || r.InstancesHealthy < r.InstancesTotal || hot || (r.Throttled ?? 0) >= n.ThrottleAmber || (r.OldestMessageSeconds ?? 0) >= n.BacklogAmber
                ? HealthState.Degraded
                : HealthState.Healthy;

        return new NodeSnapshot(n.Id, n.Name, n.Kind, n.Service, n.External, health, r.InstancesTotal, r.InstancesHealthy,
            r.Load, r.Cpu, r.Memory, r.Utilisation, r.Throttled, r.QueueDepth, r.OldestMessageSeconds, r.DeadLetters, r.RequestsPerSecond, r.ErrorRate, r.P99Ms, n.SlaP99Ms, n.ErrorAmber, n.ErrorRed,
            n.ResourceAmber, n.ResourceRed, n.ThrottleAmber, n.ThrottleRed, n.BacklogAmber, n.BacklogRed, n.Calls, n.GatewayCalls, r.At);
    }
}
