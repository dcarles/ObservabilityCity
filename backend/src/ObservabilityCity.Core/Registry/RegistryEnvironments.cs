using ObservabilityCity.Contracts;

namespace ObservabilityCity.Core.Registry;

public sealed partial record Registry
{
    /// <summary>
    /// The town as one environment sees it: the systems that environment leaves out are gone, with the calls, subscriptions, topics and
    /// vendor links that depended on them, and an island left with no systems is not on the map. The environment's tenants come along in
    /// <see cref="ActiveEnvironment"/>. An unknown id, or a town without environments, gives the registry itself.
    /// </summary>
    public Registry ForEnvironment(string id)
    {
        var env = Environments.FirstOrDefault(e => e.Id == id);
        if (env is null) return this;
        var gone = env.Excluded;
        var groups = new List<RegistryGroup>();
        foreach (var g in Groups)
        {
            var nodes = g.Nodes.Where(n => !gone.Contains(n.Id))
                .Select(n => n with { Calls = n.Calls.Where(c => !gone.Contains(c)).ToList(), GatewayCalls = n.GatewayCalls.Where(c => !gone.Contains(c)).ToList() })
                .ToList();
            if (nodes.Count == 0 && g.Nodes.Count > 0 && !g.IsHub) continue; // not deployed here at all
            groups.Add(g with { Nodes = nodes });
        }
        var present = groups.SelectMany(g => g.Nodes).Select(n => n.Id).ToHashSet();
        var groupIds = groups.Select(g => g.Id).ToHashSet();
        // a topic stays while its island is there and, for a pillar, a system of that service is still deployed
        var topics = Topics.Where(t => groupIds.Contains(t.GroupId)
            && (t.GroupId == "hub" || groups.First(g => g.Id == t.GroupId).Nodes.Any(n => n.Service == t.Service))).ToList();
        var topicNames = topics.Select(t => t.Name).ToHashSet();
        var subscriptions = Subscriptions.Where(s => present.Contains(s.ConsumerId) && topicNames.Contains(s.Topic)).ToList();
        var vendors = Vendors
            .Select(v => v with { CalledBy = v.CalledBy.Where(present.Contains).ToList() })
            .Where(v => v.CalledBy.Count > 0 || Vendors.First(o => o.Node.Id == v.Node.Id).CalledBy.Count == 0)
            .ToList();
        var callers = ExternalCallers.Select(c => c with { Calls = c.Calls.Where(present.Contains).ToList() }).ToList();
        var view = this with { Groups = groups, ExternalCallers = callers, Topics = topics, Subscriptions = subscriptions, Vendors = vendors, ActiveEnvironment = env };
        return view with { Warnings = [.. TownLinks.Warnings(view), .. EnvironmentWarnings(env, view), .. view.UnknownSourceWarnings(env), .. view.UnusedSourceWarnings(env)] };
    }

    /// <summary>Things worth fixing about an environment that do not stop it: tenant databases but no tenants listed.</summary>
    internal static IEnumerable<string> EnvironmentWarnings(RegistryEnvironment env, Registry view)
    {
        var tenanted = view.AllNodes.Where(n => n.TenantPattern is not null).ToList();
        if (tenanted.Count > 0 && env.Tenants.Count == 0 && env.UndeclaredTenants.Count == 0)
            yield return $"Environment '{env.Id}' lists no tenants, so its {tenanted.Count} tenant database{(tenanted.Count == 1 ? "" : "s")} show an empty yard. Add tenants to environments/{env.Id}.yaml.";
    }
}
