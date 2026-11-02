using System.Globalization;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>
/// The short line that says why a system is amber or red. It is built from the same readings and the same thresholds that decided the state in
/// <see cref="SnapshotBuilder"/>, so the words and the colour can never disagree. Nothing here knows a company's names.
/// </summary>
internal static class HealthReasons
{
    private static string Pct(double share, int digits = 0) => (share * 100).ToString("F" + digits, CultureInfo.InvariantCulture) + "%";

    public static string? For(RegistryNode n, NodeReading r, HealthState state, IReadOnlyList<JobSnapshot>? jobs, double? utilisation, double? throttled, IReadOnlyList<TenantUnitSnapshot>? tenants)
    {
        var parts = new List<string>();
        if (!r.Up) parts.Add("no responses");
        foreach (var j in jobs?.Where(j => j.Status == JobStatus.Failed) ?? []) parts.Add($"job {j.Name} failed");
        foreach (var j in jobs?.Where(j => j.Status == JobStatus.Overdue) ?? []) parts.Add($"job {j.Name} late");
        if (r.ErrorRate >= n.ErrorAmber) parts.Add($"error rate {Pct(r.ErrorRate, 1)}");
        if (r.P99Ms > n.SlaP99Ms) parts.Add($"p99 {Math.Round(r.P99Ms).ToString(CultureInfo.InvariantCulture)} ms");
        if (r.InstancesHealthy < r.InstancesTotal) parts.Add($"{r.InstancesHealthy} of {r.InstancesTotal} instances healthy");
        if ((r.Cpu ?? 0) >= n.ResourceAmber) parts.Add($"CPU {Pct(r.Cpu!.Value)}");
        if ((r.Memory ?? 0) >= n.ResourceAmber) parts.Add($"memory {Pct(r.Memory!.Value)}");
        if ((r.OldestMessageSeconds ?? 0) >= n.BacklogAmber) parts.Add($"oldest message {Math.Round(r.OldestMessageSeconds!.Value / 60).ToString(CultureInfo.InvariantCulture)} min");
        if (n.BacklogCountAmber is { } waiting && (r.QueueDepth ?? 0) >= waiting) parts.Add($"backlog {Math.Round(r.QueueDepth!.Value).ToString(CultureInfo.InvariantCulture)}");

        var hotStore = (utilisation ?? 0) >= n.ResourceAmber || (throttled ?? 0) >= n.ThrottleAmber;
        if (hotStore)
        {
            // a store with a database for each tenant names the tenant that is in trouble
            var worst = tenants?.Where(t => t.State is HealthState.Degraded or HealthState.Down).OrderByDescending(t => t.Utilisation ?? 0).FirstOrDefault();
            var text = new List<string>();
            if (worst is not null) text.Add($"tenant {worst.Name}");
            if ((utilisation ?? 0) >= n.ResourceAmber) text.Add($"{Pct((worst?.Utilisation ?? utilisation)!.Value)} RU");
            if ((throttled ?? 0) >= n.ThrottleAmber) text.Add($"{Pct((worst?.Throttled ?? throttled)!.Value, 1)} throttled");
            parts.Add(string.Join(" · ", text));
        }
        return parts.Count == 0 ? null : string.Join(", ", parts);
    }
}
