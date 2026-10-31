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

    /// <summary>How long a reading from this source counts as fresh.</summary>
    internal TimeSpan FreshFor(string source) =>
        SourceIntervals.TryGetValue(source, out var interval) && interval * 2 > StaleAfter ? interval * 2 : StaleAfter;

    public string Environment { get; init; } = "demo";

    /// <summary>Who sends how much to each API. Without it (or until it has read), nothing says where an API's traffic comes from.</summary>
    public Links.LinkTraffic? Traffic { get; init; }

    /// <summary>The mode the server runs in. Fixed when the server starts, so a registry reload cannot turn a live server into a demo one. Without it, the town's own mode.</summary>
    public string? Mode { get; init; }

    public Func<double> DayFraction { get; init; } = () => 0.5;

    /// <summary>Where open incidents come from. Without a source, the sky is clear.</summary>
    public IReadOnlyList<IIncidentSource> IncidentSources { get; init; } = [];

    /// <summary>
    /// The whole town, or with <paramref name="islands"/> only those islands (and always the hub). What is left out is left out of everything: the
    /// totals count only what is on screen, and a third party shows only while one of the islands that call it does. The traffic that crosses the edge
    /// is listed in <see cref="Snapshot.View"/>, so the renderer can show where it goes. Ids the town does not have are ignored and reported.
    /// </summary>
    public Snapshot Build(IReadOnlyCollection<string>? islands = null)
    {
        var now = clock.GetUtcNow();
        var registry = registries.Current;
        var incidents = OpenIncidents(registry);
        NoteIncidents(incidents.Where(kv => kv.Value.Count > 0).Select(kv => kv.Key), now);
        var links = TownLinks.Of(registry);
        var allGroups = registry.Groups
            .Select(g => new GroupSnapshot(g.Id, g.DisplayName, g.Color, g.IsHub, g.IsLostFound, g.ConfigError,
                incidents.GetValueOrDefault(g.Id) ?? [], links[g.Id].HasBridge, links[g.Id].HasRingBridge, MessagingOf(registry, g),
                g.Nodes.Select(n => ToNode(n, now, registry)).ToList()))
            .ToList();
        var allVendors = registry.Vendors.Select(v => new VendorSnapshot(ToNode(v.Node, now, registry), v.CalledBy, v.IslandId ?? v.Node.Id, v.IslandName, v.Internal)).ToList();
        var allNodes = allGroups.SelectMany(g => g.Nodes).ToList();
        var everyone = allNodes.Concat(allVendors.Select(v => v.Node)).ToDictionary(n => n.Id);

        var filter = islands is { Count: > 0 } ? islands.Select(i => i.Trim()).Where(i => i.Length > 0).Distinct().Order(StringComparer.Ordinal).ToList() : null;
        var shown = filter is null ? allGroups : allGroups.Where(g => g.IsHub || filter.Contains(g.Id)).ToList();
        var shownIds = shown.SelectMany(g => g.Nodes).Select(n => n.Id).ToHashSet();
        var vendors = filter is null ? allVendors
            : allVendors.Where(v => v.CalledBy.Any(shownIds.Contains)).Select(v => v with { CalledBy = v.CalledBy.Where(shownIds.Contains).ToList() }).ToList();
        var visible = shownIds.Concat(vendors.Select(v => v.Node.Id)).ToHashSet();
        var groups = shown;

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
            groups.Sum(g => g.Incidents.Count),
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
        if (filter is not null)
        {
            var known = allGroups.Where(g => !g.IsHub).Select(g => g.Id).ToHashSet();
            var unknown = filter.Where(i => i != "hub" && !known.Contains(i)).ToList();
            var hidden = allGroups.Where(g => !g.IsHub && !filter.Contains(g.Id)).Select(g => new HiddenIsland(g.Id, g.DisplayName)).ToList();
            var onScreen = groups.Select(g => g.Id).Concat(vendors.Select(v => v.Node.Id)).ToHashSet();
            callers = callers.Select(c => c with { Calls = c.Calls.Where(visible.Contains).ToList() }).ToList();
            dependencies = dependencies.Where(d => onScreen.Contains(d.From) && onScreen.Contains(d.To)).ToList();
            view = new ViewInfo(filter.Where(known.Contains).ToList(), unknown, hidden, OffscreenLinks(registry, everyone, shownIds, hidden));
            if (unknown.Count > 0)
                notices = [.. notices, .. unknown.Select(i => $"Island '{i}' is not in this town, so the island filter ignores it.")];
        }

        var (incidentFreeSince, incidentsSeen) = IncidentHistory(groups.Select(g => g.Id), groups.Any(g => g.Incidents.Count > 0));

        return new Snapshot(registry.Town.Id, registry.Town.Name, registry.Town.GroupLabel, env?.Id ?? Environment, now, DayFraction(), totals, notices, groups,
            vendors, callers, dependencies, registry.RingCapacity,
            env?.Name ?? Environment, environments, TenantsOf(env, allNodes), registry.Town.Topology, Mode ?? registry.Town.Mode, view, incidentFreeSince, incidentsSeen,
            OutsideRate(onScreenNodes.Values));
    }

    /// <summary>Remembers when each island last had an open incident. Every full build calls this, so the memory does not depend on who is looking.</summary>
    private void NoteIncidents(IEnumerable<string> groupsWithIncidents, DateTimeOffset now)
    {
        lock (_incidentGate)
            foreach (var id in groupsWithIncidents) _lastIncident[id] = now;
    }

    /// <summary>For the islands on screen: since when none has had an incident (null while one is open), and whether any has had one since the server started.</summary>
    private (DateTimeOffset? FreeSince, bool Seen) IncidentHistory(IEnumerable<string> shown, bool openNow)
    {
        lock (_incidentGate)
        {
            var times = shown.Where(_lastIncident.ContainsKey).Select(id => _lastIncident[id]).ToList();
            if (openNow) return (null, true);
            return (times.Count > 0 ? times.Max() : _startedAt, times.Count > 0);
        }
    }

    /// <summary>
    /// The calls that cross the edge of the screen: from a system on screen to a system on a hidden island, and from a hidden island to a system on
    /// screen. A callee's rate is shared evenly between its callers, as in the dependency overlay. One entry for each system on screen and hidden island.
    /// </summary>
    private static List<OffscreenLink> OffscreenLinks(Registry.Registry registry, Dictionary<string, NodeSnapshot> byId, HashSet<string> shown, List<HiddenIsland> hidden)
    {
        var hiddenNames = hidden.ToDictionary(h => h.Id, h => h.DisplayName);
        var callersOf = new Dictionary<string, List<RegistryNode>>();
        foreach (var n in registry.AllNodes)
            foreach (var callee in n.Calls.Concat(n.GatewayCalls).Distinct())
                (callersOf.TryGetValue(callee, out var l) ? l : callersOf[callee] = []).Add(n);
        var links = new Dictionary<(string Node, string Island, bool Incoming), double>();
        foreach (var (callee, from) in callersOf)
        {
            var calleeNode = registry.AllNodes.FirstOrDefault(n => n.Id == callee);
            if (calleeNode is null || !byId.TryGetValue(callee, out var snap)) continue;
            foreach (var caller in from)
            {
                var share = snap.State == HealthState.Stale ? 0 : LinkRate(snap, caller.Id, from.Count);
                var callerShown = shown.Contains(caller.Id);
                var calleeShown = shown.Contains(callee);
                if (callerShown && !calleeShown && hiddenNames.ContainsKey(calleeNode.GroupId))
                    links[(caller.Id, calleeNode.GroupId, false)] = links.GetValueOrDefault((caller.Id, calleeNode.GroupId, false)) + share;
                else if (!callerShown && calleeShown && hiddenNames.ContainsKey(caller.GroupId))
                    links[(callee, caller.GroupId, true)] = links.GetValueOrDefault((callee, caller.GroupId, true)) + share;
            }
        }
        return links.OrderBy(kv => kv.Key.Node, StringComparer.Ordinal).ThenBy(kv => kv.Key.Island, StringComparer.Ordinal).ThenBy(kv => kv.Key.Incoming)
            .Select(kv => new OffscreenLink(kv.Key.Node, kv.Key.Island, hiddenNames[kv.Key.Island], kv.Key.Incoming, kv.Value)).ToList();
    }

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
        var found = new SortedDictionary<string, (string Id, string Name, TenantKind Kind)>(StringComparer.Ordinal); // tenants the list lacks
        foreach (var unit in nodes.Where(n => n.State != HealthState.Stale).SelectMany(n => n.Tenants ?? []))
        {
            var key = Scope.ScopeResolver.TenantKey(unit.Id);
            seen[key] = seen.GetValueOrDefault(key) + unit.RequestsPerSecond;
            if (!declaredKeys.Contains(key)) found.TryAdd(key, (unit.Id, unit.Name, unit.Kind));
        }
        var all = declared.Select(t => (Key: Scope.ScopeResolver.TenantKey(t.Id), Id: t.Id, Name: t.Name, Kind: t.Kind))
            .Concat(found.Select(f => (Key: f.Key, Id: f.Value.Id, Name: f.Value.Name, Kind: f.Value.Kind))).ToList();
        if (all.Count == 0) return [];
        var total = all.Sum(t => seen.GetValueOrDefault(t.Key));
        double Weight(string key, TenantKind kind) => total > 0 ? seen.GetValueOrDefault(key) : kind == TenantKind.Test ? 0.1 : 1.0;
        var sum = all.Sum(t => Weight(t.Key, t.Kind));
        return all.Select(t => new TenantInfo(t.Id, t.Name, t.Kind, sum > 0 ? Weight(t.Key, t.Kind) / sum : 0)).ToList();
    }

    private static MessagingSnapshot MessagingOf(Registry.Registry registry, RegistryGroup g) => new(
        registry.Topics.Where(t => t.GroupId == g.Id).Select(t => new TopicSnapshot(t.Name, t.Service)).ToList(),
        registry.Subscriptions.Where(s => s.ConsumerGroupId == g.Id).Select(s => new SubscriptionSnapshot(s.Topic, s.PublisherGroupId, s.ConsumerId, s.Legacy)).ToList());

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
            .Select(c => new ExternalCallerSnapshot(c.Id, c.Name, c.Calls.Sum(id => byId.TryGetValue(id, out var n) ? (n.OutsideRequestsPerSecond ?? n.RequestsPerSecond) / reached[id] : 0), c.Calls))
            .ToList();
    }

    /// <summary>
    /// What reaches the airport once traffic is measured: the outside part of every API on screen, whichever building it is. Null while nothing is measured,
    /// and the airport then adds up what the outside callers bring.
    /// </summary>
    private static double? OutsideRate(IEnumerable<NodeSnapshot> onScreen)
    {
        var measured = onScreen.Where(n => n.State != HealthState.Stale && n.OutsideRequestsPerSecond is not null).ToList();
        return measured.Count == 0 ? null : measured.Sum(n => n.OutsideRequestsPerSecond!.Value);
    }

    /// <summary>The rate of one call to a system: what the measurement says that caller sends, else (nothing measured) an even share of the callee's rate.</summary>
    private static double LinkRate(NodeSnapshot callee, string callerId, int callers) =>
        callee.Inbound is { } inbound ? inbound.FirstOrDefault(l => l.From == callerId)?.RequestsPerSecond ?? 0 : callee.RequestsPerSecond / callers;

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
            foreach (var caller in from)
            {
                if (caller.GroupId == to) continue;
                var share = LinkRate(snap, caller.Id, from.Count);
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

    private NodeSnapshot ToNode(RegistryNode n, DateTimeOffset now, Registry.Registry registry)
    {
        var absent = registry.AbsentSignals(n);
        var bySource = state.GetAll(n.Id);
        var r = ReadingMerge.Merge(bySource, signal => registry.SourceFor(n, signal));
        var env = registry.ActiveEnvironment;
        if (r is not null) r = WithoutAbsent(r, absent);
        if (r is null || absent.Count == Signals.All.Length || IsStale(n, registry, bySource, r, now))
        {
            // No fresh data: keep the last numbers out of it. Grey, never green.
            return new NodeSnapshot(n.Id, n.Name, n.Kind, n.Service, n.External, HealthState.Stale, 0, 0, 0, null, null, null, null, null, null, null, 0, 0, 0,
                n.SlaP99Ms, n.ErrorAmber, n.ErrorRed, n.ResourceAmber, n.ResourceRed, n.ThrottleAmber, n.ThrottleRed, n.BacklogAmber, n.BacklogRed, n.Calls, n.GatewayCalls, r?.At,
                n.TenantPattern is null ? null : StaleUnits(n, env), absent);
        }

        // Quiet: too few calls in the source's window for its error share and latency to mean anything. The numbers are left out (0 is no trouble to
        // any threshold), the rate stays, and nothing else about the building changes.
        var quiet = r.Calls is { } calls && calls < n.MinCalls;
        if (quiet) r = r with { ErrorRate = 0, P99Ms = 0 };

        var split = n.Kind == NodeKind.Api && !absent.Contains(Signals.Requests) ? Traffic?.Split(n.Id, r.RequestsPerSecond) : null;

        // A store with a database for each tenant: each unit gets its own state, and the store's numbers are the worst that count.
        var tenants = n.TenantPattern is null ? null : TenantUnits(n, r, env);
        var utilisation = r.Utilisation;
        var throttled = r.Throttled;
        if (tenants is not null) (utilisation, throttled) = Aggregate(n, tenants, r);

        // Degraded: errors, slow, unhealthy instances, a resource running hot, a data store turning requests away, or a consumer running late.
        var hot = Math.Max(Math.Max(r.Cpu ?? 0, r.Memory ?? 0), utilisation ?? 0) >= n.ResourceAmber;
        var health = !r.Up ? HealthState.Down
            : r.ErrorRate >= n.ErrorAmber || r.P99Ms > n.SlaP99Ms || r.InstancesHealthy < r.InstancesTotal || hot || (throttled ?? 0) >= n.ThrottleAmber || (r.OldestMessageSeconds ?? 0) >= n.BacklogAmber
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
        };
    }

    /// <summary>
    /// Whether the reading is too old to show. Each source that supplies a signal has its own limit (see <see cref="FreshFor"/>) and one stale source
    /// greys the building however fresh the others are. A single source's reading is judged by that source's limit.
    /// </summary>
    private bool IsStale(RegistryNode n, Registry.Registry registry, IReadOnlyDictionary<string, NodeReading> bySource, NodeReading merged, DateTimeOffset now)
    {
        var used = bySource.Count == 1 ? bySource.Keys.ToList()
            : Signals.All.Select(s => registry.SourceFor(n, s)).OfType<string>().Where(bySource.ContainsKey).Distinct().ToList();
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
        };
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
        return new TenantUnitSnapshot(t.TenantId, name, kind, RegistryEnvironment.DatabaseName(n.TenantPattern!, t.TenantId), state, t.Utilisation, t.Throttled, t.RequestsPerSecond, t.Limit);
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
