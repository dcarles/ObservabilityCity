using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>Joins the registry with the latest readings and applies the rules that decide each node's state.</summary>
public sealed class SnapshotBuilder(Registry.Registry registry, LatestState state, TimeProvider clock)
{
    /// <summary>Readings older than this are shown as stale, never as healthy.</summary>
    public TimeSpan StaleAfter { get; init; } = TimeSpan.FromSeconds(30);

    public string Environment { get; init; } = "demo";

    public Func<double> DayFraction { get; init; } = () => 0.5;

    public Snapshot Build()
    {
        var now = clock.GetUtcNow();
        var groups = registry.Groups
            .Select(g => new GroupSnapshot(g.Id, g.DisplayName, g.Color, g.IsHub, g.Nodes.Select(n => ToNode(n, now)).ToList()))
            .ToList();

        var live = groups.SelectMany(g => g.Nodes).Where(n => n.State != HealthState.Stale).ToList();
        var rps = live.Sum(n => n.RequestsPerSecond);
        var totals = new TownTotals(
            rps,
            rps > 0 ? live.Sum(n => n.RequestsPerSecond * n.ErrorRate) / rps : 0,
            RequestWeightedP99(live),
            live.Count(n => n.State == HealthState.Degraded),
            live.Count(n => n.State == HealthState.Down));

        return new Snapshot(registry.Town.Id, registry.Town.Name, registry.Town.GroupLabel, Environment, now, DayFraction(), totals, groups);
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
            return new NodeSnapshot(n.Id, n.Name, n.Kind, n.Service, n.External, HealthState.Stale, 0, 0, 0, 0, 0, 0,
                n.SlaP99Ms, n.ErrorAmber, n.ErrorRed, r?.At);
        }

        var health = !r.Up ? HealthState.Down
            : r.ErrorRate >= n.ErrorAmber || r.P99Ms > n.SlaP99Ms || r.InstancesHealthy < r.InstancesTotal
                ? HealthState.Degraded
                : HealthState.Healthy;

        return new NodeSnapshot(n.Id, n.Name, n.Kind, n.Service, n.External, health, r.InstancesTotal, r.InstancesHealthy,
            r.Load, r.RequestsPerSecond, r.ErrorRate, r.P99Ms, n.SlaP99Ms, n.ErrorAmber, n.ErrorRed, r.At);
    }
}
