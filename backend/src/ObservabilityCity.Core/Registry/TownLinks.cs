using ObservabilityCity.Contracts;

namespace ObservabilityCity.Core.Registry;

/// <summary>What connects one island to the rest of the town. The renderer builds only the connectors that exist.</summary>
/// <param name="HasApi">The island has an API: outside callers and other islands can reach it, so it needs a bridge.</param>
/// <param name="HasBridge">A bridge to the hub. In a hub-and-spoke town: the island has an API, or a call link crosses its coast in either direction (a hub database or cache, a gateway call, a call into or out of it). In a town whose islands call each other directly: a call link between the island and the hub's shared resources, and nothing else, because islands do not go through the hub to reach each other.</param>
/// <param name="HasRingBridge">A bridge to the outer ring road, from the island's back gate. In a hub-and-spoke town only an island that calls a third party has one. In a direct town it is also how islands reach each other and how outside callers arrive: an island with an API, a call to or from another island, a third party or an outside caller has one.</param>
/// <param name="HasMessaging">The island publishes a topic or has a worker that subscribes to one, so it gets a pier and boats.</param>
/// <param name="CallsVendor">One of its systems calls a third party, which is reached over the ring road rather than the hub.</param>
public sealed record GroupLinks(bool HasApi, bool HasBridge, bool HasRingBridge, bool HasMessaging, bool CallsVendor)
{
    /// <summary>Nothing connects it to the town: no bridge, no ring road, no messaging and no third party to reach.</summary>
    public bool Standalone => !HasBridge && !HasRingBridge && !HasMessaging && !CallsVendor;
}

/// <summary>Works out which connectors each island has, from the links the registry really declares.</summary>
public static class TownLinks
{
    public static IReadOnlyDictionary<string, GroupLinks> Of(Registry registry)
    {
        var direct = registry.Town.Topology != "hub-and-spoke";
        var hubIds = registry.Groups.Where(g => g.IsHub).Select(g => g.Id).ToHashSet();
        var groupOf = registry.AllNodes.ToDictionary(n => n.Id, n => n.GroupId);
        var crossing = new HashSet<string>(); // islands with at least one call link over their coast (in a direct town: to or from the hub)
        var reaching = new HashSet<string>(); // direct towns: islands with a call link to or from another island, or an outside caller
        foreach (var n in registry.AllNodes)
        {
            foreach (var callee in n.Calls.Concat(n.GatewayCalls))
            {
                if (!groupOf.TryGetValue(callee, out var to) || to == n.GroupId) continue;
                if (direct && !hubIds.Contains(to) && !hubIds.Contains(n.GroupId))
                {
                    reaching.Add(n.GroupId);
                    reaching.Add(to);
                    continue;
                }
                crossing.Add(n.GroupId);
                crossing.Add(to);
            }
            // a gateway call always leaves the island, even when the target is not known here
            if (n.GatewayCalls.Count > 0) crossing.Add(n.GroupId);
        }
        foreach (var caller in registry.ExternalCallers)
            foreach (var id in caller.Calls)
                if (groupOf.TryGetValue(id, out var target)) reaching.Add(target);

        var messaging = registry.Topics.Select(t => t.GroupId).Concat(registry.Subscriptions.Select(s => s.ConsumerGroupId)).ToHashSet();
        var vendorCallers = registry.Vendors.SelectMany(v => v.CalledBy).Where(groupOf.ContainsKey).Select(id => groupOf[id]).ToHashSet();

        var result = new Dictionary<string, GroupLinks>();
        foreach (var g in registry.Groups)
        {
            if (g.IsHub || g.ConfigError is not null)
            {
                result[g.Id] = new GroupLinks(false, false, false, messaging.Contains(g.Id) && g.IsHub, false);
                continue;
            }
            var hasApi = g.Nodes.Any(n => n.Kind == NodeKind.Api);
            var callsVendor = vendorCallers.Contains(g.Id);
            result[g.Id] = direct
                ? new GroupLinks(hasApi, crossing.Contains(g.Id), hasApi || reaching.Contains(g.Id) || callsVendor, messaging.Contains(g.Id), callsVendor)
                : new GroupLinks(hasApi, hasApi || crossing.Contains(g.Id), callsVendor, messaging.Contains(g.Id), callsVendor);
        }
        return result;
    }

    /// <summary>One warning for each island nothing connects to.</summary>
    public static IEnumerable<string> Warnings(Registry registry)
    {
        var links = Of(registry);
        foreach (var g in registry.Groups.Where(g => !g.IsHub && g.ConfigError is null && g.Nodes.Count > 0))
            if (links[g.Id].Standalone)
                yield return $"Island '{g.Id}' stands alone: it has no API, no topics or subscriptions, no calls to or from other islands and no third party, so nothing connects it to the town. Add an API, a messaging block or a calls link.";
    }
}
