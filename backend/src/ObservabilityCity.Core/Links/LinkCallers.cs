using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Links;

/// <summary>A system whose own calls link discovery reads: a town system, or a service of a vendor island that lists the telemetry names it runs under.</summary>
public readonly record struct LinkCaller(string Id, string GroupId);

/// <summary>Which telemetry names link discovery and the traffic read ask about, and whose calls each one is.</summary>
public static class LinkCallers
{
    /// <summary>
    /// Every caller by its telemetry name: the APIs and workers of the town that have discovery on (the name comes from the inventory), then the
    /// services of vendor islands that list <c>roles</c>. A name already taken by a town system is not given to a vendor.
    /// </summary>
    public static Dictionary<string, LinkCaller> ByRole(Registry.Registry view, Func<string, string?> telemetryRole)
    {
        var byRole = new Dictionary<string, LinkCaller>(StringComparer.OrdinalIgnoreCase);
        foreach (var node in view.AllNodes.Where(n => n.Kind is NodeKind.Api or NodeKind.Worker && n.DiscoverLinks))
            if (telemetryRole(node.Id) is { Length: > 0 } role) byRole.TryAdd(role, new LinkCaller(node.Id, node.GroupId));
        foreach (var vendor in view.Vendors)
            foreach (var role in vendor.Roles)
                byRole.TryAdd(role, new LinkCaller(vendor.Node.Id, vendor.Node.GroupId));
        return byRole;
    }
}
