using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>Links between systems, calls from outside and request rates. Part of <see cref="SnapshotBuilder"/>.</summary>
public sealed partial class SnapshotBuilder
{
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

        // a service of a vendor island that was seen calling town systems through the gateway counts as one of their callers
        var vendorCallers = new Dictionary<string, List<string>>(); // callee id to the vendor buildings that call it
        foreach (var v in registry.Vendors)
            foreach (var callee in v.Calls)
                if (groupOf.ContainsKey(callee)) (vendorCallers.TryGetValue(callee, out var l) ? l : vendorCallers[callee] = []).Add(v.Node.Id);

        foreach (var callee in callers.Keys.Concat(vendorCallers.Keys).Distinct())
        {
            if (!byId.TryGetValue(callee, out var snap) || (snap.State == HealthState.Stale && groupOf.ContainsKey(callee))) continue; // a third party has no health to be stale about: its calls are still a link
            var to = groupOf.GetValueOrDefault(callee, callee); // a vendor stands on its own
            var from = callers.GetValueOrDefault(callee) ?? [];
            var vendorsHere = vendorCallers.GetValueOrDefault(callee) ?? [];
            var count = from.Count + vendorsHere.Count;
            foreach (var caller in from)
            {
                if (caller.GroupId == to) continue;
                var share = LinkRate(snap, caller.Id, count);
                links[(caller.GroupId, to)] = links.GetValueOrDefault((caller.GroupId, to)) + share;
            }
            foreach (var vendorId in vendorsHere)
                links[(vendorId, to)] = links.GetValueOrDefault((vendorId, to)) + LinkRate(snap, vendorId, count);
        }
        return links.OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key.From, StringComparer.Ordinal).ThenBy(kv => kv.Key.To, StringComparer.Ordinal)
            .Select(kv => new DependencySnapshot(kv.Key.From, kv.Key.To, kv.Value)).ToList();
    }

    /// <summary>A third party has no rate of its own: what the town systems are seen sending it is its traffic, with each caller's part, when the traffic is measured.</summary>
    private NodeSnapshot WithCallRate(NodeSnapshot vendor) =>
        Traffic?.CallRates(vendor.Id) is { } calls ? vendor with { RequestsPerSecond = calls.Total, Inbound = calls.Callers } : vendor;

    /// <summary>Headline latency: p99 averaged over request-serving nodes, weighted by traffic. Workers and crons are left out.</summary>
    private static double RequestWeightedP99(List<NodeSnapshot> live)
    {
        var serving = live.Where(n => n.Kind is NodeKind.Api or NodeKind.Gateway).ToList();
        var rps = serving.Sum(n => n.RequestsPerSecond);
        return rps > 0 ? serving.Sum(n => n.P99Ms * n.RequestsPerSecond) / rps : 0;
    }
}
