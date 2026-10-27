using System.Globalization;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>What the inspector shows about one system beyond its live numbers: its links, and its effective settings with where each came from.</summary>
public static class SystemDetails
{
    /// <summary>The detail of a system or a third party, or null when the registry has no such id.</summary>
    public static SystemDetail? Of(Registry.Registry registry, string id)
    {
        var node = registry.AllNodes.FirstOrDefault(n => n.Id == id) ?? registry.Vendors.FirstOrDefault(v => v.Node.Id == id)?.Node;
        if (node is null) return null;

        var names = registry.AllNodes.Concat(registry.Vendors.Select(v => v.Node)).ToDictionary(n => n.Id);
        var groups = registry.Groups.ToDictionary(g => g.Id);
        LinkRef Ref(string target)
        {
            var n = names.GetValueOrDefault(target);
            var vendor = target.StartsWith(RegistryVendor.GroupId + ".", StringComparison.Ordinal);
            var gid = n?.GroupId ?? target.Split('.')[0];
            var island = vendor ? "Third party" : groups.TryGetValue(gid, out var g) ? g.DisplayName : gid;
            return new LinkRef(target, n?.Name ?? target, vendor ? LinkKind.Vendor : LinkKind.System, vendor ? RegistryVendor.GroupId : gid, island);
        }

        var vendorCalls = registry.Vendors.Where(v => v.CalledBy.Contains(id)).Select(v => v.Node.Id);
        var calls = node.Calls.Concat(vendorCalls).Distinct().Select(Ref).ToList();
        var vendorEntry = registry.Vendors.FirstOrDefault(v => v.Node.Id == id);
        var calledBy = registry.AllNodes.Where(n => n.Calls.Contains(id)).Select(n => n.Id)
            .Concat(vendorEntry?.CalledBy ?? []).Distinct().Select(Ref).ToList();
        var gatewayCalledBy = registry.AllNodes.Where(n => n.GatewayCalls.Contains(id)).Select(n => Ref(n.Id)).ToList();
        var outside = registry.ExternalCallers.Where(c => c.Calls.Contains(id)).Select(c => c.Name).ToList();
        var topics = node.Service is null ? []
            : registry.Topics.Where(t => t.GroupId == node.GroupId && t.Service == node.Service).Select(t => t.Name).ToList();
        var subscriptions = registry.Subscriptions.Where(s => s.ConsumerId == id)
            .Select(s => new SubscriptionSnapshot(s.Topic, s.PublisherGroupId, s.ConsumerId, s.Legacy)).ToList();

        var island2 = node.GroupId == RegistryVendor.GroupId ? "Third party" : groups.TryGetValue(node.GroupId, out var own) ? own.DisplayName : node.GroupId;
        return new SystemDetail(node.Id, node.Name, node.Kind, node.Service, node.GroupId, island2, FileOf(node),
            Config(node), calls, calledBy, node.GatewayCalls.Select(Ref).ToList(), gatewayCalledBy, outside, topics, subscriptions);
    }

    /// <summary>The path of the registry file a system is declared in, relative to the registry folder.</summary>
    public static string FileOf(RegistryNode node) => PathOf(node.SourceFile);

    /// <summary>A registry file name as it is found in the registry folder: pillar files live in pillars/, the rest beside town.yaml.</summary>
    private static string PathOf(string? file) =>
        string.IsNullOrEmpty(file) ? "" : file is "hub.yaml" or "third-parties.yaml" or "defaults.yaml" ? file : $"pillars/{file}";

    private static string RoleOf(NodeKind kind) => kind == NodeKind.Database ? "db" : kind.ToString().ToLowerInvariant();

    /// <summary>The settings that matter for this kind of system, each with its effective value and the layer it came from.</summary>
    public static List<ConfigValue> Config(RegistryNode n)
    {
        var role = RoleOf(n.Kind);
        string Source(string key)
        {
            if (!n.Origins.TryGetValue(key, out var o)) return "";
            var file = PathOf(o.File);
            return o.Layer switch
            {
                SettingLayer.System => $"{file}, this system",
                SettingLayer.Pillar => key == "external" ? $"{file}, external: true for the whole pillar" : $"{file}, pillar defaults for {role}",
                SettingLayer.App => $"defaults.yaml, {role}",
                _ => "built-in default",
            };
        }
        ConfigValue Row(string key, string value) =>
            new(key, value, n.Origins.TryGetValue(key, out var o) ? o.Layer : SettingLayer.BuiltIn, Source(key));

        string Pct(double v) => (v * 100).ToString("0.##", CultureInfo.InvariantCulture) + "%";
        string Ms(double v) => v >= 1000 && v % 1000 == 0 ? $"{v / 1000:0} s" : $"{v.ToString("0.##", CultureInfo.InvariantCulture)} ms";
        string Secs(double v) => $"{v.ToString("0.##", CultureInfo.InvariantCulture)} s";

        var rows = new List<ConfigValue>
        {
            Row("role", role),
            Row("external", n.External ? "yes" : "no"),
            Row("slaP99Ms", Ms(n.SlaP99Ms)),
            Row("errors.amber", Pct(n.ErrorAmber)),
            Row("errors.red", Pct(n.ErrorRed)),
            Row("resources.amber", Pct(n.ResourceAmber)),
            Row("resources.red", Pct(n.ResourceRed)),
        };
        if (n.Kind is NodeKind.Api or NodeKind.Worker or NodeKind.Gateway or NodeKind.Cron)
            rows.Add(Row("minCalls", n.MinCalls.ToString(CultureInfo.InvariantCulture)));
        if (n.Kind is NodeKind.Database or NodeKind.Cache)
        {
            rows.Add(Row("throttle.amber", Pct(n.ThrottleAmber)));
            rows.Add(Row("throttle.red", Pct(n.ThrottleRed)));
        }
        if (n.Kind == NodeKind.Worker)
        {
            rows.Add(Row("backlog.amber", Secs(n.BacklogAmber)));
            rows.Add(Row("backlog.red", Secs(n.BacklogRed)));
        }
        if (n.TenantPattern is not null)
            rows.Add(new ConfigValue("tenantPattern", n.TenantPattern, SettingLayer.System, $"{PathOf(n.SourceFile)}, this system"));
        if (n.Service is not null)
            rows.Add(new ConfigValue("service", n.Service, SettingLayer.System, $"{PathOf(n.SourceFile)}, this system"));
        return rows;
    }
}
