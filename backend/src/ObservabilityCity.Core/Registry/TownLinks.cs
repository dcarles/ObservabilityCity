using ObservabilityCity.Contracts;

namespace ObservabilityCity.Core.Registry;

/// <summary>What connects one island to the rest of the town. The renderer builds only the connectors that exist.</summary>
/// <param name="HasApi">The island has an API: outside callers and other islands can reach it, so it needs a bridge.</param>
/// <param name="HasBridge">A bridge to the hub: the island has an API, or a call link crosses its coast in either direction (a hub database or cache, a gateway call, a call into or out of it).</param>
/// <param name="HasMessaging">The island publishes a topic or has a worker that subscribes to one, so it gets a pier and boats.</param>
/// <param name="CallsVendor">One of its systems calls a third party, which is reached over the ring road rather than the hub.</param>
public sealed record GroupLinks(bool HasApi, bool HasBridge, bool HasMessaging, bool CallsVendor)
{
    /// <summary>Nothing connects it to the town: no bridge, no messaging and no third party to reach.</summary>
    public bool Standalone => !HasBridge && !HasMessaging && !CallsVendor;
}

/// <summary>Works out which connectors each island has, from the links the registry really declares.</summary>
public static class TownLinks
{
    public static IReadOnlyDictionary<string, GroupLinks> Of(Registry registry)
    {
        var groupOf = registry.AllNodes.ToDictionary(n => n.Id, n => n.GroupId);
        var crossing = new HashSet<string>(); // islands with at least one call link over their coast
        foreach (var n in registry.AllNodes)
        {
            foreach (var callee in n.Calls.Concat(n.GatewayCalls))
            {
                if (!groupOf.TryGetValue(callee, out var to) || to == n.GroupId) continue;
                crossing.Add(n.GroupId);
                crossing.Add(to);
            }
            // a gateway call always leaves the island, even when the target is not known here
            if (n.GatewayCalls.Count > 0) crossing.Add(n.GroupId);
        }

        var messaging = registry.Topics.Select(t => t.GroupId).Concat(registry.Subscriptions.Select(s => s.ConsumerGroupId)).ToHashSet();
        var vendorCallers = registry.Vendors.SelectMany(v => v.CalledBy).Where(groupOf.ContainsKey).Select(id => groupOf[id]).ToHashSet();

        var result = new Dictionary<string, GroupLinks>();
        foreach (var g in registry.Groups)
        {
            if (g.IsHub || g.ConfigError is not null)
            {
                result[g.Id] = new GroupLinks(false, false, messaging.Contains(g.Id) && g.IsHub, false);
                continue;
            }
            var hasApi = g.Nodes.Any(n => n.Kind == NodeKind.Api);
            result[g.Id] = new GroupLinks(hasApi, hasApi || crossing.Contains(g.Id), messaging.Contains(g.Id), vendorCallers.Contains(g.Id));
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
