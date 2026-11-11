using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>Joins the registry with the latest readings and applies the rules that decide each node's state.</summary>
public sealed partial class SnapshotBuilder(IRegistryProvider registries, LatestState state, TimeProvider clock)
{
    /// <summary>A builder for a registry that never changes.</summary>
    public SnapshotBuilder(Registry.Registry registry, LatestState state, TimeProvider clock)
        : this(new RegistryHolder(registry), state, clock)
    {
    }

    private IReadOnlyList<AssetSnapshot> AssetsOf(string groupId, Registry.Registry registry)
    {
        if (FixedAssets is { Count: > 0 })
            return FixedAssets.Where(a => a.PillarId == groupId).Select(a => new AssetSnapshot(a.Id, a.Name, a.Label, a.Shape, a.Service, a.Region, [], a.Group)).ToList();
        if (ScopeSource is null || registry.ActiveEnvironment is not { } env || env.Scope.Assets.Count == 0) return [];
        return ScopeSource.Resolve(registry).AssetList.Where(a => a.PillarId == groupId)
            .Select(a => new AssetSnapshot(a.Id, a.Name, a.Label, a.Shape, a.Service, a.Region,
                ObservabilityCity.Core.Scope.ScopeLinks.For(env.Scope, Environment, new Scope.ResolvedResource(a.ResourceId, a.Name, a.Type, a.Region, null, a.Rule), a.AccountId, null), a.Group))
            .ToList();
    }

    private readonly DateTimeOffset _startedAt = clock.GetUtcNow();
    private readonly object _incidentGate = new();
    private readonly Dictionary<string, DateTimeOffset> _lastIncident = new();

    /// <summary>Readings older than this are shown as stale, never as healthy.</summary>
    public TimeSpan StaleAfter { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// How often each source is asked, by source name. A source asked rarely (the inventory, every few minutes) is not stale in between: its readings
    /// stand for twice its interval, or <see cref="StaleAfter"/> if that is longer. A source not listed here stands for <see cref="StaleAfter"/>.
    /// </summary>
    public IReadOnlyDictionary<string, TimeSpan> SourceIntervals { get; init; } = new Dictionary<string, TimeSpan>();

    /// <summary>Per source, how long a scheduled job may be past its time, without a newer run, before it counts as late (see <see cref="Jobs"/>). A source not listed uses its freshness limit.</summary>
    public IReadOnlyDictionary<string, TimeSpan> SourceLateAfter { get; init; } = new Dictionary<string, TimeSpan>();

    /// <summary>How long a reading from this source counts as fresh.</summary>
    internal TimeSpan FreshFor(string source) =>
        SourceIntervals.TryGetValue(source, out var interval) && interval * 2 > StaleAfter ? interval * 2 : StaleAfter;

    /// <summary>How late a job may be: the source's own setting, but never less than the reading is allowed to lag.</summary>
    internal TimeSpan LateAfter(string source) =>
        SourceLateAfter.TryGetValue(source, out var late) && late > FreshFor(source) ? late : FreshFor(source);

    public string Environment { get; init; } = "demo";

    /// <summary>Where the resources that stand as basic buildings come from. Without it (a demo town) there are none.</summary>
    public Scope.ScopeStore? ScopeSource { get; init; }

    /// <summary>Basic buildings given outright, for a demo town that has no inventory to find them in. They have no portal links.</summary>
    public IReadOnlyList<Scope.ResolvedAsset>? FixedAssets { get; init; }

    /// <summary>Who sends how much to each API. Without it (or until it has read), nothing says where an API's traffic comes from.</summary>
    public Links.LinkTraffic? Traffic { get; init; }

    /// <summary>The mode the server runs in. Fixed when the server starts, so a registry reload cannot turn a live server into a demo one. Without it, the town's own mode.</summary>
    public string? Mode { get; init; }

    public Func<double> DayFraction { get; init; } = () => 0.5;

    /// <summary>Where open incidents come from. Without a source, the sky is clear.</summary>
    public IReadOnlyList<IIncidentSource> IncidentSources { get; init; } = [];

    /// <summary>Where the cloud's own health reports come from (resources it calls Degraded or Unavailable). Without a source the snapshot has none, which is not the same as an empty list: nothing reads them.</summary>
    public IReadOnlyList<IHealthEventSource> HealthSources { get; init; } = [];

    /// <summary>
    /// The whole town, or with <paramref name="islands"/> only those islands (and always the hub). What is left out is left out of everything: the
    /// totals count only what is on screen, and a third party shows only while one of the islands that call it does. The traffic that crosses the edge
    /// is listed in <see cref="Snapshot.View"/>, so the renderer can show where it goes. Ids the town does not have are ignored and reported.
    /// </summary>
    public Snapshot Build(IReadOnlyCollection<string>? islands = null)
    {
        var now = clock.GetUtcNow();
        var registry = WithRoutes(registries.Current);
        var incidents = OpenIncidents(registry);
        var healthEvents = HealthSources.Count == 0 ? null : HealthEventsOf(registry);
        // a cloud health event stands for an incident of the island that owns the resource, for "since the last incident" as for the count
        NoteIncidents(incidents.Where(kv => kv.Value.Count > 0).Select(kv => kv.Key).Concat((healthEvents ?? []).Where(e => e.GroupId is not null && e.State != "Resolved").Select(e => e.GroupId!)), now);
        var links = TownLinks.Of(registry);
        var allGroups = registry.Groups
            .Select(g => new GroupSnapshot(g.Id, g.DisplayName, g.Color, g.IsHub, g.IsLostFound, g.ConfigError,
                incidents.GetValueOrDefault(g.Id) ?? [], links[g.Id].HasBridge, links[g.Id].HasRingBridge, MessagingOf(registry, g),
                g.Nodes.Select(n => ToNode(n, now, registry)).ToList(), AssetsOf(g.Id, registry), g.IsHub ? null : FlowOf(g, now)))
            .ToList();
        var allVendors = registry.Vendors.Select(v => new VendorSnapshot(WithCallRate(ToNode(v.Node, now, registry)), v.CalledBy, v.IslandId ?? v.Node.Id, v.IslandName, v.Internal, v.Calls is { Count: > 0 } calls ? calls : null)).ToList();
        var allNodes = allGroups.SelectMany(g => g.Nodes).ToList();
        var everyone = allNodes.Concat(allVendors.Select(v => v.Node)).ToDictionary(n => n.Id);

        var filter = islands is { Count: > 0 } ? islands.Select(i => i.Trim()).Where(i => i.Length > 0).Distinct().Order(StringComparer.Ordinal).ToList() : null;
        var shown = filter is null ? allGroups : allGroups.Where(g => g.IsHub || filter.Contains(g.Id)).ToList();
        var shownIds = shown.SelectMany(g => g.Nodes).Select(n => n.Id).ToHashSet();
        // a third party's island can be chosen like a pillar's: it shows even when none of the shown islands calls it
        var vendorIslands = allVendors.GroupBy(v => v.IslandId ?? v.Node.Id).ToDictionary(g => g.Key, g => g.First().IslandName ?? g.First().Node.Name);
        var chosenVendors = filter is null ? [] : filter.Where(vendorIslands.ContainsKey).ToHashSet();
        var vendors = filter is null ? allVendors
            : allVendors.Where(v => chosenVendors.Contains(v.IslandId ?? v.Node.Id) || v.CalledBy.Any(shownIds.Contains) || (v.Calls ?? []).Any(shownIds.Contains))
                .Select(v => v with { CalledBy = v.CalledBy.Where(shownIds.Contains).ToList(), Calls = (v.Calls ?? []).Where(shownIds.Contains).ToList() }).ToList();
        var visible = shownIds.Concat(vendors.Select(v => v.Node.Id)).ToHashSet();
        var groups = shown;
        // what is not on screen is left out; an event no building owns has no island to be left out with, so it stays
        var events = healthEvents?.Where(e => e.NodeId is null || shownIds.Contains(e.NodeId)).ToList();

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
            groups.Sum(g => g.Incidents.Count) + (events?.Count(e => e.State != "Resolved") ?? 0), // a resolved report is listed, not counted
            live.Where(n => registry.ConsumerIds.Contains(n.Id)).Sum(n => n.DeadLetters ?? 0));

        var env = registry.ActiveEnvironment;
        var environments = registry.Environments.Count > 0
            ? registry.Environments.Select(e => new EnvironmentInfo(e.Id, e.Name, e.Id == registry.DefaultEnvironmentId)).ToList()
            : [new EnvironmentInfo(Environment, Environment, true)];

        // what is not on screen does not count: not in the airport's rate, and not in an arc
        var onScreenNodes = everyone.Where(kv => visible.Contains(kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value);
        var callers = ExternalCallers(registry, onScreenNodes);
        var dependencies = Dependencies(registry, onScreenNodes);
        var view = new ViewInfo([], [], [], []);
        var notices = registries.Notices;
        notices = [.. notices, .. UnmappedJobs(registry, onScreenNodes)];
        if (filter is not null)
        {
            var known = allGroups.Where(g => !g.IsHub).Select(g => g.Id).Concat(vendorIslands.Keys).ToHashSet();
            var unknown = filter.Where(i => i != "hub" && !known.Contains(i)).ToList();
            var hidden = allGroups.Where(g => !g.IsHub && !filter.Contains(g.Id)).Select(g => new HiddenIsland(g.Id, g.DisplayName)).ToList();
            var shownVendorIslands = vendors.Select(v => v.IslandId ?? v.Node.Id).ToHashSet();
            var hiddenVendors = vendorIslands.Where(kv => !shownVendorIslands.Contains(kv.Key)).OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => new HiddenIsland(kv.Key, kv.Value, true)).ToList();
            var onScreen = groups.Select(g => g.Id).Concat(vendors.Select(v => v.Node.Id)).ToHashSet();
            callers = callers.Select(c => c with { Calls = c.Calls.Where(visible.Contains).ToList() }).ToList();
            dependencies = dependencies.Where(d => onScreen.Contains(d.From) && onScreen.Contains(d.To)).ToList();
            view = new ViewInfo(filter.Where(known.Contains).ToList(), unknown, [.. hidden, .. hiddenVendors], OffscreenLinks(registry, everyone, shownIds, hidden));
            if (unknown.Count > 0)
                notices = [.. notices, .. unknown.Select(i => $"Island '{i}' is not in this town, so the island filter ignores it.")];
        }

        var (incidentFreeSince, incidentsSeen) = IncidentHistory(groups.Select(g => g.Id), groups.Any(g => g.Incidents.Count > 0) || events?.Any(e => e.State != "Resolved") == true);

        return new Snapshot(registry.Town.Id, registry.Town.Name, registry.Town.GroupLabel, env?.Id ?? Environment, now, DayFraction(), totals, notices, groups,
            vendors, callers, dependencies, registry.RingCapacity,
            env?.Name ?? Environment, environments, TenantsOf(env, allNodes), registry.Town.Topology, Mode ?? registry.Town.Mode, view, incidentFreeSince, incidentsSeen,
            OutsideRate(onScreenNodes.Values), env?.Scope.Cloud, registry.Town.TrafficDensity, registries.Notes is { Count: > 0 } notes ? notes : null, SourceFreshness(now), events, registry.Town.InternalVendorsLabel,
            registry.Town.Wall is { } w ? new WallSettingsSnapshot(w.HoldSeconds, w.OverviewSeconds, w.OverviewIslandSeconds, w.Light) : null);
    }

    /// <summary>What the pillar sends and receives through the broker, from the source that reads it; absent when no source reports it or its reading is older than the source stands for.</summary>
    private PillarFlowSnapshot? FlowOf(RegistryGroup g, DateTimeOffset now)
    {
        PillarFlowSnapshot? best = null;
        DateTimeOffset? at = null;
        foreach (var (source, reading) in state.GetAll(NodeReading.FlowKey(g.Id)))
        {
            if (reading.Flow is not { } f || now - reading.At > FreshFor(source) || (at is not null && reading.At <= at)) continue;
            (best, at) = (new PillarFlowSnapshot(f.Sent is { } s ? Math.Round(s, 3) : null, f.Received is { } r ? Math.Round(r, 3) : null, f.WindowSeconds), reading.At);
        }
        return best;
    }

    /// <summary>
    /// One notice for each function with a scheduled job the pillar's file does not map to services (<c>scheduler:</c>). Such a job sends no boats, and the notice
    /// says which jobs, so the file can be completed. Several regions of one job count once.
    /// </summary>
    private static IEnumerable<string> UnmappedJobs(Registry.Registry registry, IReadOnlyDictionary<string, NodeSnapshot> nodes)
    {
        foreach (var g in registry.Groups.Where(g => !g.IsHub))
        {
            foreach (var n in g.Nodes.Where(n => n.Kind == NodeKind.Function && nodes.ContainsKey(n.Id)))
            {
                var mapped = g.Schedules.Where(x => x.SystemId == n.Id).Select(x => x.Job).ToHashSet(StringComparer.OrdinalIgnoreCase);
                var missing = (nodes[n.Id].Jobs ?? []).Select(j => j.Name).Distinct(StringComparer.OrdinalIgnoreCase).Where(j => !mapped.Contains(j)).Order(StringComparer.OrdinalIgnoreCase).ToList();
                if (missing.Count > 0)
                    yield return $"Job not mapped: {n.Id} runs {string.Join(", ", missing)}, which the scheduler: list of {g.Id}.yaml does not say a service for, so it sends no boats.";
            }
        }
    }

    /// <summary>
    /// The registry with the routes the broker's queue names add: a queue whose name says who publishes it (see the <c>producerPillar</c> and <c>producer</c> groups of an entity pattern)
    /// is a topic of that publisher and a subscription of the worker that reads it. What the pillar files already say is kept; a route they already hold is not added twice.
    /// </summary>
    private Registry.Registry WithRoutes(Registry.Registry registry)
    {
        var topics = registry.Topics.ToList();
        var subscriptions = registry.Subscriptions.ToList();
        var added = false;
        foreach (var n in registry.Groups.Where(g => !g.IsHub).SelectMany(g => g.Nodes))
        {
            if (registry.SourceFor(n, Signals.Backlog) is not { } source || !state.GetAll(n.Id).TryGetValue(source, out var reading)) continue;
            foreach (var q in reading.Queues ?? [])
            {
                if (q.ProducerGroup is null || q.ProducerService is null) continue;
                if (!topics.Any(t => t.Name == q.Name)) { topics.Add(new RegistryTopic(q.Name, q.ProducerGroup, q.ProducerService)); added = true; }
                if (!subscriptions.Any(s => s.Topic == q.Name && s.ConsumerId == n.Id)) { subscriptions.Add(new RegistrySubscription(q.Name, q.ProducerGroup, n.Id, n.GroupId, false)); added = true; }
            }
        }
        return added ? registry with { Topics = topics, Subscriptions = subscriptions } : registry;
    }

    private static MessagingSnapshot MessagingOf(Registry.Registry registry, RegistryGroup g) => new(
        registry.Topics.Where(t => t.GroupId == g.Id).Select(t => new TopicSnapshot(t.Name, t.Service)).ToList(),
        registry.Subscriptions.Where(s => s.ConsumerGroupId == g.Id).Select(s => new SubscriptionSnapshot(s.Topic, s.PublisherGroupId, s.ConsumerId, s.Legacy)).ToList(),
        g.Schedules.Select(x => new ScheduleSnapshot(x.SystemId, x.Job, x.Services)).ToList());
}
