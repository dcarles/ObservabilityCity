using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>One system as a node: its state from the readings, its regions, jobs and staleness. Part of <see cref="SnapshotBuilder"/>.</summary>
public sealed partial class SnapshotBuilder
{
    private NodeSnapshot ToNode(RegistryNode n, DateTimeOffset now, Registry.Registry registry)
    {
        var absent = registry.AbsentSignals(n);
        var bySource = state.GetAll(n.Id);
        // A source that is late takes only its own signals out (they are left out and listed as absent) while a source of health signals is fresh; the building is grey when none is.
        // Instance counts and the queue numbers do not say how a building is doing, so a source that supplies only those cannot keep one alive.
        var ages = SourceAges(n, registry, bySource, now);
        var late = ages.Where(a => !a.Fresh).Select(a => a.Source).ToHashSet(StringComparer.Ordinal);
        if (late.Count > 0 && ages.Any(a => a.Fresh && a.Signals.Any(IsHealthSignal)))
        {
            bySource = bySource.Where(kv => !late.Contains(kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value);
            absent = [.. absent, .. ages.Where(a => !a.Fresh).SelectMany(a => a.Signals).Where(s => !absent.Contains(s)).Distinct()];
        }
        var r = ReadingMerge.Merge(bySource, signal => registry.SourceFor(n, signal));
        var env = registry.ActiveEnvironment;
        if (r is not null) r = WithoutAbsent(r, absent);
        // The inventory has been read and the app is not there: grey, and it says so. Nothing else about a missing app can be known.
        if (r?.App == AppState.Missing)
            return Stale(n, r, absent, env) with { App = AppState.Missing, Sources = ages.Count > 0 ? ages : null, Engine = EngineOf(registry, n) };
        if (r is null || absent.Count == Signals.For(n.Kind).Count || IsStale(n, registry, bySource, r, now))
            return Stale(n, r, absent, env) with { Sources = ages.Count > 0 ? ages : null, Engine = EngineOf(registry, n) }; // No fresh data: keep the last numbers out of it. Grey, never green.

        // A count of 0 instances is no count: the source did not say (a plan the cloud gives no worker count for), so the signal is absent rather than 0 of 0.
        if (r.InstancesTotal == 0 && r.InstancesHealthy == 0 && !absent.Contains(Signals.Instances)) absent = [.. absent, Signals.Instances];

        // A service in two or more regions is shown as its worst region; the others are listed beside it.
        var regions = RegionsOf(n, r, env);
        if (regions is not null)
        {
            var worst = WorstRegion(regions);
            var pressure = regions.Any(x => x.Cpu is not null || x.Memory is not null);
            r = r with
            {
                InstancesTotal = worst.Instances ?? r.InstancesTotal,
                InstancesHealthy = worst.Instances ?? r.InstancesHealthy,
                Cpu = pressure ? worst.Cpu : r.Cpu,
                Memory = pressure ? worst.Memory : r.Memory,
            };
        }

        // A function: its jobs, each in its region. A failed job or one that did not run when its schedule said it would is amber: the app runs and the rest
        // of its jobs may be fine. It is red only when every job failed. A stopped app runs nothing.
        var jobs = r.App == AppState.Stopped || r.Jobs is null ? null : Jobs(n, r.Jobs, registry, env, now);
        var jobHealth = jobs is { Count: > 0 } && jobs.All(j => j.Status == JobStatus.Failed) ? HealthState.Down
            : jobs?.Any(j => j.Status is JobStatus.Failed or JobStatus.Overdue) == true ? HealthState.Degraded
            : HealthState.Healthy;

        // Quiet: too few calls in the source's window for its error share and latency to mean anything. The numbers are left out (0 is no trouble to
        // any threshold), the rate stays, and nothing else about the building changes.
        var quiet = r.Calls is { } calls && calls < n.MinCalls;
        if (quiet) r = r with { ErrorRate = 0, P99Ms = 0 };

        var split = n.Kind == NodeKind.Api && !absent.Contains(Signals.Requests) ? Traffic?.Split(n.Id, r.RequestsPerSecond, now) : null;

        // A store with a database for each tenant: each unit gets its own state, and the store's numbers are the worst that count.
        var tenants = n.TenantPattern is null ? null : TenantUnits(n, r, env);
        var utilisation = r.Utilisation;
        var throttled = r.Throttled;
        if (tenants is not null) (utilisation, throttled) = Aggregate(n, tenants, r);

        // Down: no response, every job failed, or instances counted and not one healthy.
        // Degraded: errors, slow, unhealthy instances, a resource running hot, a data store turning requests away, or a consumer running late.
        var hot = Math.Max(Math.Max(r.Cpu ?? 0, r.Memory ?? 0), utilisation ?? 0) >= n.ResourceAmber;
        var noneHealthy = r.InstancesTotal > 0 && r.InstancesHealthy == 0;
        var health = !r.Up || jobHealth == HealthState.Down || noneHealthy ? HealthState.Down
            : jobHealth == HealthState.Degraded || r.ErrorRate >= n.ErrorAmber || r.P99Ms > n.SlaP99Ms || r.InstancesHealthy < r.InstancesTotal || hot || (throttled ?? 0) >= n.ThrottleAmber || (r.OldestMessageSeconds ?? 0) >= n.BacklogAmber || (n.BacklogCountAmber is { } waitingAmber && (r.QueueDepth ?? 0) >= waitingAmber)
                ? HealthState.Degraded
                : HealthState.Healthy;

        return new NodeSnapshot(n.Id, n.Name, n.Kind, n.Service, n.External, health, r.InstancesTotal, r.InstancesHealthy,
            r.Load, r.Cpu, r.Memory, utilisation, throttled, r.QueueDepth, r.OldestMessageSeconds, r.DeadLetters, r.RequestsPerSecond, r.ErrorRate, r.P99Ms, n.SlaP99Ms, n.ErrorAmber, n.ErrorRed,
            n.ResourceAmber, n.ResourceRed, n.ThrottleAmber, n.ThrottleRed, n.BacklogAmber, n.BacklogRed, n.Calls, n.GatewayCalls, r.At, tenants, absent, quiet)
        {
            // an API's traffic is its measured total less what town systems send: the rest is outside, whichever building it is
            OutsideRequestsPerSecond = split?.Outside,
            Inbound = split?.Callers,
            InboundEstimated = split?.Estimated ?? false,
            Sources = ages.Any(a => !a.Fresh) ? ages : null,
            Queues = r.Queues?.Select(q => new QueueSnapshot(q.Name, q.Backlog, q.DeadLetters, DeadLetterLinks.For(registry, n, q.Name), q.PerSecond, q.Types?.Select(t => new MessageTypeSnapshot(t.Type, t.PerSecond)).ToList(), q.TypesCut > 0 ? q.TypesCut : null,
                q.DeadLetterRegions?.Select(d => new DeadLetterRegionSnapshot(d.Region, d.Count, DeadLetterLinks.For(registry, n, q.Name, d.Region), Label(env, d.Region))).ToList())).ToList(),
            App = r.App,
            Jobs = jobs,
            Regions = regions?.Select(x => new RegionSnapshot(x.Region, Label(env, x.Region), x.Instances, x.Cpu, x.Memory, x.Share, Skewed(x, regions, env))).ToList(),
            Reason = health == HealthState.Healthy ? null : HealthReasons.For(n, r, health, jobs, utilisation, throttled, tenants),
            Engine = EngineOf(registry, n),
        };
    }

    /// <summary>The engine a database says it runs on, named from the town's list. Null for any other system, and for a database that says none.</summary>
    private static DatabaseEngineSnapshot? EngineOf(Registry.Registry registry, RegistryNode n) =>
        registry.EngineOf(n) is { } e ? new DatabaseEngineSnapshot(e.Id, e.Name, e.Type, DatabaseTypes.Names[e.Type]) : null;

    private static NodeSnapshot Stale(RegistryNode n, NodeReading? r, IReadOnlyList<string> absent, RegistryEnvironment? env) =>
        new(n.Id, n.Name, n.Kind, n.Service, n.External, HealthState.Stale, 0, 0, 0, null, null, null, null, null, null, null, 0, 0, 0,
            n.SlaP99Ms, n.ErrorAmber, n.ErrorRed, n.ResourceAmber, n.ResourceRed, n.ThrottleAmber, n.ThrottleRed, n.BacklogAmber, n.BacklogRed, n.Calls, n.GatewayCalls, r?.At,
            n.TenantPattern is null ? null : StaleUnits(n, env), absent);

    private static string Label(RegistryEnvironment? env, string region) => env?.Scope.Regions.Label(region) ?? region;

    /// <summary>
    /// The regions of a service when the region view applies to it: it runs in two or more. Null otherwise (the numbers then stand for the whole service, as they always did).
    /// </summary>
    private static IReadOnlyList<RegionReading>? RegionsOf(RegistryNode n, NodeReading r, RegistryEnvironment? env)
    {
        if (r.Regions is not { } regions || regions.Count(x => x.Instances is not null || x.Cpu is not null || x.Memory is not null) < 2) return null;
        return regions.OrderBy(x => Label(env, x.Region), StringComparer.Ordinal).ToList();
    }

    /// <summary>
    /// Whether this region takes more of the requests than the environment allows (scope.regions.skew) while another region runs instances: traffic sent
    /// to one region by a routing change, or left to it by a region that has died. Never without a measured share.
    /// </summary>
    private static bool Skewed(RegionReading region, IReadOnlyList<RegionReading> all, RegistryEnvironment? env) =>
        region.Share is { } share && share > (env?.Scope.Regions ?? RegionRules.Default).Skew && all.Any(o => o != region && o.Instances > 0);

    /// <summary>The region under the most pressure: the highest CPU or memory. With no number to go by, the first by name.</summary>
    private static RegionReading WorstRegion(IReadOnlyList<RegionReading> regions) =>
        regions.Select((x, i) => (Region: x, Index: i)).OrderByDescending(x => Math.Max(x.Region.Cpu ?? 0, x.Region.Memory ?? 0)).ThenBy(x => x.Index).First().Region;

    /// <summary>
    /// The state of each job. Failed: the last run failed. Overdue: the schedule said it runs next at a time that has passed, by more than the reading is
    /// allowed to lag (the jobs source's freshness), without a newer run to show for it. Anything else is Ok.
    /// </summary>
    private List<JobSnapshot> Jobs(RegistryNode n, IReadOnlyList<JobReading> jobs, Registry.Registry registry, RegistryEnvironment? env, DateTimeOffset now)
    {
        var grace = registry.SourceFor(n, Signals.Jobs) is { } source ? LateAfter(source) : StaleAfter;
        return jobs.Select(j =>
        {
            var status = j.Succeeded == false ? JobStatus.Failed
                : j.Next is { } next && now > next + grace && (j.LastRun is null || j.LastRun < next) ? JobStatus.Overdue
                : JobStatus.Ok;
            return new JobSnapshot(j.Name, j.Region is null ? null : Label(env, j.Region), status, j.LastRun, j.Next);
        }).ToList();
    }

    /// <summary>Whether a signal says how a building is doing, as opposed to how many instances it has or what waits in its queues.</summary>
    private static bool IsHealthSignal(string signal) => signal is not (Signals.Instances or Signals.Backlog or Signals.DeadLetters);

    /// <summary>The sources that have reported and that supply at least one signal of the system; a single source stands for everything.</summary>
    private static List<string> UsedSources(RegistryNode n, Registry.Registry registry, IReadOnlyDictionary<string, NodeReading> bySource) =>
        bySource.Count == 1 ? bySource.Keys.ToList()
            : Signals.For(n.Kind).Select(s => registry.SourceFor(n, s)).OfType<string>().Where(bySource.ContainsKey).Distinct().ToList();

    /// <summary>Each source that feeds the system, how old its last reading is, whether that is fresh, and the signals it supplies.</summary>
    private List<SourceAgeSnapshot> SourceAges(RegistryNode n, Registry.Registry registry, IReadOnlyDictionary<string, NodeReading> bySource, DateTimeOffset now) =>
        UsedSources(n, registry, bySource).Select(s => new SourceAgeSnapshot(s, (int)Math.Max(0, (now - bySource[s].At).TotalSeconds), now - bySource[s].At <= FreshFor(s),
            bySource.Count == 1 ? [] : Signals.For(n.Kind).Where(sig => registry.SourceFor(n, sig) == s).ToList())).ToList();

    /// <summary>
    /// Whether the reading is too old to show. Each source that supplies a signal has its own limit (see <see cref="FreshFor"/>). By the time this runs a
    /// late source has already been taken out when a source of health signals is fresh, so a late source left here means none is, and the building is grey.
    /// A single source's reading is judged by that source's limit.
    /// </summary>
    private bool IsStale(RegistryNode n, Registry.Registry registry, IReadOnlyDictionary<string, NodeReading> bySource, NodeReading merged, DateTimeOffset now)
    {
        var used = UsedSources(n, registry, bySource);
        return used.Count == 0 ? now - merged.At > StaleAfter : used.Any(s => now - bySource[s].At > FreshFor(s));
    }

    /// <summary>
    /// What a source reported, less the signals nothing is configured for. A source may well measure more than the environment asked it for; what was not
    /// asked for is not shown and plays no part in health. Errors and latency of nothing are 0, which no threshold treats as trouble.
    /// </summary>
    private static NodeReading WithoutAbsent(NodeReading r, IReadOnlyList<string> absent)
    {
        if (absent.Count == 0) return r;
        bool Gone(string signal) => absent.Contains(signal);
        return r with
        {
            RequestsPerSecond = Gone(Signals.Requests) ? 0 : r.RequestsPerSecond,
            Calls = Gone(Signals.Requests) ? null : r.Calls,
            ErrorRate = Gone(Signals.Errors) ? 0 : r.ErrorRate,
            P99Ms = Gone(Signals.Latency) ? 0 : r.P99Ms,
            InstancesTotal = Gone(Signals.Instances) ? 0 : r.InstancesTotal,
            InstancesHealthy = Gone(Signals.Instances) ? 0 : r.InstancesHealthy,
            Cpu = Gone(Signals.Cpu) ? null : r.Cpu,
            Memory = Gone(Signals.Memory) ? null : r.Memory,
            Utilisation = Gone(Signals.Utilisation) ? null : r.Utilisation,
            Throttled = Gone(Signals.Throttled) ? null : r.Throttled,
            QueueDepth = Gone(Signals.Backlog) ? null : r.QueueDepth,
            OldestMessageSeconds = Gone(Signals.Backlog) ? null : r.OldestMessageSeconds,
            DeadLetters = Gone(Signals.DeadLetters) ? null : r.DeadLetters,
            Queues = Gone(Signals.Backlog) && Gone(Signals.DeadLetters) ? null
                : r.Queues?.Select(q => q with { Backlog = Gone(Signals.Backlog) ? null : q.Backlog, DeadLetters = Gone(Signals.DeadLetters) ? null : q.DeadLetters, DeadLetterRegions = Gone(Signals.DeadLetters) ? null : q.DeadLetterRegions }).ToList(),
        };
    }
}
