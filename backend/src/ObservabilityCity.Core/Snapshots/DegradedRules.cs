using System.Globalization;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>What the rules look at for one system: its thresholds, its merged reading, and the jobs, utilisation, throttling and tenants worked out from it.</summary>
internal sealed record RuleInput(RegistryNode Node, NodeReading Reading, IReadOnlyList<JobSnapshot>? Jobs, double? Utilisation, double? Throttled, IReadOnlyList<TenantUnitSnapshot>? Tenants);

/// <summary>One reason a system is not healthy: a name, when it applies and the words that say so. The same rule decides the colour and writes the reason, so the two cannot disagree.</summary>
internal sealed record DegradedRule(string Id, Func<RuleInput, bool> Trips, Func<RuleInput, string> Words);

/// <summary>
/// Every rule that makes a system amber (or says why it is down), in the order the reason lists them. <see cref="SnapshotBuilder"/> asks <see cref="Tripped"/> for the state and
/// <see cref="HealthReasons"/> asks <see cref="Reasons"/> for the line; a rule added here does both. Each rule has a case in <c>shared-test-data/degraded-rules/</c>, which the
/// backend tests prove and the browser's tests read to prove the panel can explain it (the rule's id is the case's name).
/// </summary>
internal static class DegradedRules
{
    private static string Pct(double share, int digits = 0) => (share * 100).ToString("F" + digits, CultureInfo.InvariantCulture) + "%";
    private static string Whole(double value) => Math.Round(value).ToString(CultureInfo.InvariantCulture);

    public static readonly IReadOnlyList<DegradedRule> All =
    [
        new("no-response", i => !i.Reading.Up, _ => "no responses"),
        new("job-failed", i => i.Jobs?.Any(j => j.Status == JobStatus.Failed) == true, i => string.Join(", ", i.Jobs!.Where(j => j.Status == JobStatus.Failed).Select(j => $"job {j.Name} failed"))),
        new("job-late", i => i.Jobs?.Any(j => j.Status == JobStatus.Overdue) == true, i => string.Join(", ", i.Jobs!.Where(j => j.Status == JobStatus.Overdue).Select(j => $"job {j.Name} late"))),
        new("error-rate", i => i.Reading.ErrorRate >= i.Node.ErrorAmber, i => $"error rate {Pct(i.Reading.ErrorRate, 1)}"),
        new("p99", i => i.Reading.P99Ms > i.Node.SlaP99Ms, i => $"p99 {Whole(i.Reading.P99Ms)} ms"),
        new("instances", i => i.Reading.InstancesHealthy < i.Reading.InstancesTotal, i => i.Reading.InstancesTotal > 0 && i.Reading.InstancesHealthy == 0 ? $"no healthy instances (0 of {i.Reading.InstancesTotal})" : $"{i.Reading.InstancesHealthy} of {i.Reading.InstancesTotal} instances healthy"),
        new("cpu", i => (i.Reading.Cpu ?? 0) >= i.Node.ResourceAmber, i => $"CPU {Pct(i.Reading.Cpu!.Value)}"),
        new("memory", i => (i.Reading.Memory ?? 0) >= i.Node.ResourceAmber, i => $"memory {Pct(i.Reading.Memory!.Value)}"),
        new("oldest-message", i => (i.Reading.OldestMessageSeconds ?? 0) >= i.Node.BacklogAmber, i => $"oldest message {Whole(i.Reading.OldestMessageSeconds!.Value / 60)} min"),
        new("waiting-count", i => i.Node.BacklogCountAmber is { } waiting && (i.Reading.QueueDepth ?? 0) >= waiting, i => $"{Whole(i.Reading.QueueDepth!.Value)} waiting (line {Whole(i.Node.BacklogCountAmber!.Value)})"),
        new("store", i => (i.Utilisation ?? 0) >= i.Node.ResourceAmber || (i.Throttled ?? 0) >= i.Node.ThrottleAmber, StoreWords),
    ];

    /// <summary>Whether any rule applies: the system is not healthy by its own numbers.</summary>
    public static bool Tripped(RuleInput input) => All.Any(r => r.Trips(input));

    /// <summary>The words of every rule that applies, in order.</summary>
    public static IEnumerable<string> Reasons(RuleInput input) => All.Where(r => r.Trips(input)).Select(r => r.Words(input));

    // a store with a database for each tenant names the tenant that is in trouble
    private static string StoreWords(RuleInput i)
    {
        var n = i.Node;
        var worst = i.Tenants?.Where(t => t.State is HealthState.Degraded or HealthState.Down).OrderByDescending(t => t.Utilisation ?? 0).FirstOrDefault();
        var text = new List<string>();
        if (worst is not null) text.Add($"tenant {worst.Name}");
        if ((i.Utilisation ?? 0) >= n.ResourceAmber) text.Add($"{Pct((worst?.Utilisation ?? i.Utilisation)!.Value)} capacity");
        if ((i.Throttled ?? 0) >= n.ThrottleAmber) text.Add($"{Pct((worst?.Throttled ?? i.Throttled)!.Value, 1)} throttled");
        return string.Join(" · ", text);
    }
}
