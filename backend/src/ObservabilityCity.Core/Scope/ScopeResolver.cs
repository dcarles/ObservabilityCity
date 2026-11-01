using ObservabilityCity.Contracts;
using System.Text.RegularExpressions;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Scope;

/// <summary>
/// Turns an environment's scope rules and an inventory into the town's scopes: each pillar's subscription, and for each system its service code,
/// telemetry role and resources. Pure: the same registry, rules and inventory always give the same answer, whatever the conventions are.
/// </summary>
public static class ScopeResolver
{
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromSeconds(1);

    /// <summary>Tenant ids are written with and without dashes in different places; this is the form they are compared in.</summary>
    public static string TenantKey(string tenant) => tenant.Replace("-", "").ToLowerInvariant();

    public static Resolution Resolve(Registry.Registry view, Inventory? inventory) =>
        view.ActiveEnvironment is not { } env ? Resolution.Empty : Resolve(view, env, inventory);

    public static Resolution Resolve(Registry.Registry view, RegistryEnvironment env, Inventory? inventory)
    {
        var rules = env.Scope;
        var problems = new List<string>();
        string? Custom(string name) => name == ScopeRules.EnvironmentVariable ? env.Id : rules.Variables.GetValueOrDefault(name);
        var workspace = rules.Workspace is null ? null : ScopeTemplate.Render(rules.Workspace, Custom);
        var (workspaceId, workspaceVia) = ResolveWorkspace(rules, workspace, Custom, inventory, problems);

        var pillars = new List<PillarScope>();
        foreach (var group in view.Groups)
            pillars.Add(ResolvePillar(group, rules, Custom, inventory, problems));

        var systems = new List<SystemScope>();
        var tenantNames = new Dictionary<string, string>();
        foreach (var group in view.Groups)
        {
            var pillar = pillars.First(p => p.PillarId == group.Id);
            foreach (var node in group.Nodes)
                systems.Add(ResolveSystem(node, group, pillar, rules, Custom, workspace ?? workspaceId, inventory, tenantNames, problems));
        }

        foreach (var clash in systems.Where(s => s.TelemetryRole is not null).GroupBy(s => s.TelemetryRole!, StringComparer.OrdinalIgnoreCase).Where(g => g.Count() > 1))
            problems.Add($"Telemetry role '{clash.Key}' is used by {string.Join(" and ", clash.Select(s => $"'{s.SystemId}'"))}; the telemetry of one would be read as the other. Give each its own telemetry.role.");

        return new Resolution(pillars, systems, tenantNames.Select(kv => new TenantName(kv.Key, kv.Value)).OrderBy(t => t.Id, StringComparer.Ordinal).ToList(), problems, inventory is not null, workspace ?? workspaceId, workspaceId, workspaceVia,
            ResolveAssets(view, rules, pillars, inventory, Custom));
    }

    /// <summary>
    /// The resources that stand as basic buildings: in each pillar's subscription, every resource of a rule's types whose name matches its pattern. A <c>service</c> group that matches a system's serviceCode
    /// ties the resource to that service; otherwise (or without the group) it belongs to the pillar. A <c>pillar</c> group that names another pillar leaves the resource out.
    /// </summary>
    private static List<ResolvedAsset> ResolveAssets(Registry.Registry view, ScopeRules rules, List<PillarScope> pillars, Inventory? inventory, Func<string, string?> custom)
    {
        var found = new List<ResolvedAsset>();
        if (inventory is null || rules.Assets.Count == 0) return found;
        found.AddRange(ResolveHubAssets(rules, pillars, inventory, custom));
        foreach (var group in view.Groups.Where(g => !g.IsHub))
        {
            var pillar = pillars.First(p => p.PillarId == group.Id);
            if (pillar.SubscriptionId is not { } subscription) continue;
            foreach (var rule in rules.Assets.Where(r => !r.OnHub))
            {
                var regex = new Regex(rule.Pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, RegexTimeout);
                foreach (var resource in inventory.Resources.Where(r => r.SubscriptionId.Equals(subscription, StringComparison.OrdinalIgnoreCase) && rule.Types.Contains(r.Type, StringComparer.OrdinalIgnoreCase)))
                {
                    var match = regex.Match(resource.Name);
                    if (!match.Success) continue;
                    if (Group(match, "pillar") is { Length: > 0 } p && !p.Equals(pillar.Code, StringComparison.OrdinalIgnoreCase) && !p.Equals(group.Id, StringComparison.OrdinalIgnoreCase)) continue;
                    var said = Group(match, "service");
                    var owner = said.Length == 0 ? null : group.Nodes.FirstOrDefault(n => (n.ServiceCode ?? n.Service).Equals(said, StringComparison.OrdinalIgnoreCase))?.Service;
                    var region = Group(match, "region") is { Length: > 0 } g ? g : resource.Region;
                    if (rules.Regions.Tag is { } regionTag && TagValue(resource, regionTag) is { Length: > 0 } tagged) region = tagged;
                    found.Add(new ResolvedAsset($"{group.Id}.{resource.Name.ToLowerInvariant()}", group.Id, resource.Name, rule.Label, rule.Shape, resource.Type, owner, region, resource.Id, rule.Name, subscription));
                }
            }
        }
        return found.OrderBy(a => a.Id, StringComparer.Ordinal).ToList();
    }

    /// <summary>
    /// The resources that stand on the hub island, in a cluster each rule names: every resource of a rule's types whose name matches its pattern, in the subscriptions the rule names
    /// (see <see cref="HubAssetSubscriptions"/>). They belong to no pillar and no service. The same resource found by two rules stands once, for the first.
    /// </summary>
    private static List<ResolvedAsset> ResolveHubAssets(ScopeRules rules, List<PillarScope> pillars, Inventory inventory, Func<string, string?> custom)
    {
        var found = new List<ResolvedAsset>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var rule in rules.Assets.Where(r => r.OnHub))
        {
            var subscriptions = HubAssetSubscriptions(rule, pillars, inventory.Subscriptions, custom);
            var regex = new Regex(rule.Pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, RegexTimeout);
            foreach (var resource in inventory.Resources.Where(r => subscriptions.Contains(r.SubscriptionId) && rule.Types.Contains(r.Type, StringComparer.OrdinalIgnoreCase)))
            {
                var match = regex.Match(resource.Name);
                if (!match.Success || !seen.Add(resource.Id)) continue;
                var region = Group(match, "region") is { Length: > 0 } g ? g : resource.Region;
                if (rules.Regions.Tag is { } regionTag && TagValue(resource, regionTag) is { Length: > 0 } tagged) region = tagged;
                found.Add(new ResolvedAsset($"{AssetRule.HubIsland}.{resource.Name.ToLowerInvariant()}", AssetRule.HubIsland, resource.Name, rule.Label, rule.Shape, resource.Type, null, region, resource.Id, rule.Name, resource.SubscriptionId, rule.Group));
            }
        }
        return found;
    }

    /// <summary>
    /// The ids of the subscriptions a hub rule looks in: those its <c>subscription</c> names (by name pattern or tag, templates over the environment's variables), else every pillar's.
    /// The inventory source reads the resources of these, so a subscription that holds only shared resources is read too.
    /// </summary>
    public static HashSet<string> HubAssetSubscriptions(AssetRule rule, IEnumerable<PillarScope> pillars, IEnumerable<InventorySubscription> known, Func<string, string?> custom)
    {
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (rule.Subscription is not { } sub)
        {
            foreach (var p in pillars.Where(p => p.SubscriptionId is not null)) ids.Add(p.SubscriptionId!);
            return ids;
        }
        foreach (var s in known)
        {
            var matches = sub.NameLike is { } like
                ? ScopeTemplate.Like(s.Name, ScopeTemplate.Render(like, custom))
                : s.Tags.FirstOrDefault(t => t.Key.Equals(sub.TagKey, StringComparison.OrdinalIgnoreCase)).Value is { } v && (sub.TagValue is null || v.Equals(ScopeTemplate.Render(sub.TagValue, custom), StringComparison.OrdinalIgnoreCase));
            if (matches) ids.Add(s.Id);
        }
        return ids;
    }

    /// <summary>The subscriptions the hub rules of an environment look in, for the inventory source to read.</summary>
    public static IReadOnlyList<string> HubAssetSubscriptions(Registry.Registry view, IEnumerable<PillarScope> pillars, IEnumerable<InventorySubscription> known)
    {
        if (view.ActiveEnvironment is not { } env) return [];
        string? Custom(string name) => name == ScopeRules.EnvironmentVariable ? env.Id : env.Scope.Variables.GetValueOrDefault(name);
        return env.Scope.Assets.Where(r => r.OnHub && r.Subscription is not null)
            .SelectMany(r => HubAssetSubscriptions(r, pillars, known, Custom)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>A GUID or a resource id (starting with a slash) is a workspace id; anything else is a name.</summary>
    public static bool IsWorkspaceId(string text) => text.StartsWith('/') || Guid.TryParse(text, out _);

    /// <summary>
    /// The id a workspace is queried by. An explicit <c>workspaceId</c> wins and is used as it is. Otherwise <c>workspace</c> is used as an id when it is
    /// one, and when it is a name or wildcard pattern it is looked up in the inventory's workspaces: exactly one must match. Until the inventory has been
    /// read (or when it was not asked for workspaces) there is no id yet, which is not a problem to report.
    /// </summary>
    private static (string? Id, string? Via) ResolveWorkspace(ScopeRules rules, string? workspace, Func<string, string?> custom, Inventory? inventory, List<string> problems)
    {
        if (rules.WorkspaceId is { } given && ScopeTemplate.Render(given, custom).Trim() is { Length: > 0 } id) return (id, "id");
        if (string.IsNullOrWhiteSpace(workspace)) return (null, null);
        var text = workspace.Trim();
        if (IsWorkspaceId(text)) return (text, "id");
        if (inventory?.Workspaces is not { } known) return (null, null);
        var found = known.Where(w => ScopeTemplate.Like(w.Name, text)).ToList();
        switch (found.Count)
        {
            case 1: return (found[0].CustomerId ?? found[0].Id, "name");
            case 0:
                problems.Add($"No Log Analytics workspace is named '{text}'. Check scope.workspace, or give the workspace's id under scope.workspaceId.");
                return (null, null);
            default:
                problems.Add($"{found.Count} Log Analytics workspaces match '{text}' ({string.Join(", ", found.Select(w => w.Name).Order(StringComparer.Ordinal))}). Make scope.workspace narrower, or give the workspace's id under scope.workspaceId.");
                return (null, null);
        }
    }

    private static PillarScope ResolvePillar(RegistryGroup group, ScopeRules rules, Func<string, string?> custom, Inventory? inventory, List<string> problems)
    {
        var code = group.Code ?? group.Id;
        string? Words(string name) => name switch { "pillar" => code, "pillarId" => group.Id, _ => custom(name) };

        var named = rules.PillarSubscriptions.GetValueOrDefault(group.Id);
        if (named is not null)
        {
            var sub = inventory?.Subscriptions.FirstOrDefault(s => s.Id.Equals(named, StringComparison.OrdinalIgnoreCase));
            if (inventory is not null && sub is null)
                problems.Add($"Pillar '{group.Id}' is set to subscription {named}, which the inventory does not list. Check the id and that the login can read it.");
            return new PillarScope(group.Id, code, named, sub?.Name, "explicit");
        }
        if (group.IsHub || rules.Subscription is not { } rule) return new PillarScope(group.Id, code, null, null, "");
        if (inventory is null) return new PillarScope(group.Id, code, null, null, "");

        List<InventorySubscription> found;
        string how;
        if (rule.NameLike is { } like)
        {
            var wanted = ScopeTemplate.Render(like, Words);
            found = inventory.Subscriptions.Where(s => ScopeTemplate.Like(s.Name, wanted)).ToList();
            how = $"name like '{wanted}'";
        }
        else
        {
            var key = rule.TagKey!;
            var wanted = ScopeTemplate.Render(rule.TagValue ?? "{pillar}", Words);
            found = inventory.Subscriptions.Where(s => s.Tags.FirstOrDefault(t => t.Key.Equals(key, StringComparison.OrdinalIgnoreCase)).Value is { } v && v.Equals(wanted, StringComparison.OrdinalIgnoreCase)).ToList();
            how = $"tag {key} = '{wanted}'";
        }
        switch (found.Count)
        {
            case 1: return new PillarScope(group.Id, code, found[0].Id, found[0].Name, rule.NameLike is not null ? "name" : "tag");
            case 0:
                problems.Add($"Pillar '{group.Id}': no subscription has {how}. Check scope.subscription, or name the subscription under scope.pillars.");
                break;
            default:
                problems.Add($"Pillar '{group.Id}': {found.Count} subscriptions have {how} ({string.Join(", ", found.Select(s => s.Name).Order(StringComparer.Ordinal))}). Make the rule narrower, or name the subscription under scope.pillars.");
                break;
        }
        return new PillarScope(group.Id, code, null, null, "");
    }

    private static SystemScope ResolveSystem(
        RegistryNode node, RegistryGroup group, PillarScope pillar, ScopeRules rules, Func<string, string?> custom, string? workspace,
        Inventory? inventory, Dictionary<string, string> tenantNames, List<string> problems)
    {
        var serviceCode = node.ServiceCode ?? node.Service;
        var role = node.RoleName;

        string? telemetry = null, via = null;
        if (node.TelemetryRole is { } own) { telemetry = own; via = "telemetry.role"; }
        else if (rules.TelemetryRole is { } template)
        {
            var dot = node.Id.IndexOf('.');
            string? Words(string name) => name switch
            {
                "system" => node.Id[(dot + 1)..],
                "service" => node.Service,
                "name" => node.Name,
                "role" => role,
                "pillar" => pillar.Code,
                "pillarId" => group.Id,
                _ => custom(name),
            };
            var rendered = ScopeTemplate.Render(template, Words);
            if (rendered.Length > 0) { telemetry = rendered; via = "scope.telemetryRole"; }
        }

        var resources = new List<ResolvedResource>();
        if (inventory is not null && pillar.SubscriptionId is { } subscription && serviceCode is not null)
        {
            var applicable = rules.Resources.Where(r => r.Roles.Count == 0 || r.Roles.Contains(role, StringComparer.OrdinalIgnoreCase)).ToList();
            foreach (var rule in applicable)
            {
                var regex = new Regex(rule.Pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, RegexTimeout);
                foreach (var resource in inventory.Resources.Where(r =>
                    r.SubscriptionId.Equals(subscription, StringComparison.OrdinalIgnoreCase) && rule.Types.Contains(r.Type, StringComparer.OrdinalIgnoreCase)))
                {
                    var match = regex.Match(resource.Name);
                    string? region = resource.Region, tenant = null;
                    if (match.Success)
                    {
                        if (!Group(match, "service").Equals(serviceCode, StringComparison.OrdinalIgnoreCase)) continue;
                        if (Group(match, "role") is { Length: > 0 } r && !r.Equals(role, StringComparison.OrdinalIgnoreCase)) continue;
                        if (Group(match, "pillar") is { Length: > 0 } p && !p.Equals(pillar.Code, StringComparison.OrdinalIgnoreCase) && !p.Equals(group.Id, StringComparison.OrdinalIgnoreCase)) continue;
                        if (Group(match, "region") is { Length: > 0 } g) region = g;
                        if (Group(match, "tenant") is { Length: > 0 } t) tenant = TenantKey(t);
                    }
                    else if (rule.ServiceTag is not { } tag || TagValue(resource, tag) is not { } said || !Compact(said).Equals(Compact(serviceCode), StringComparison.OrdinalIgnoreCase))
                        continue;

                    if (rules.Regions.Tag is { } regionTag && TagValue(resource, regionTag) is { Length: > 0 } tagged) region = tagged;
                    bool? running = rule.State is null || string.IsNullOrWhiteSpace(resource.State) ? null : rule.Running!.Contains(resource.State, StringComparer.OrdinalIgnoreCase);
                    resources.Add(new ResolvedResource(resource.Id, resource.Name, resource.Type, region, tenant, rule.Name, rule.Instances is null ? null : resource.Instances, running));
                    if (tenant is not null && rule.TenantNameTag is { } nameTag && TagValue(resource, nameTag) is { Length: > 0 } friendly)
                        tenantNames.TryAdd(tenant, friendly);
                }
            }
            if (applicable.Count > 0 && resources.Count == 0 && node.Kind is NodeKind.Api or NodeKind.Worker or NodeKind.Database or NodeKind.Function)
                problems.Add($"No resource found for '{node.Id}' (service code '{serviceCode}') in {pillar.SubscriptionName ?? pillar.SubscriptionId}. Check serviceCode and the resource patterns under scope.resources.");
        }

        // the app's state is known only for a system with a rule that reads one: none of its resources found is a missing app, otherwise it runs while any resource does
        AppState? app = null;
        if (inventory is not null && pillar.SubscriptionId is not null && serviceCode is not null && rules.Resources.Any(r => r.State is not null && (r.Roles.Count == 0 || r.Roles.Contains(role, StringComparer.OrdinalIgnoreCase))))
        {
            var stated = resources.Where(r => r.Running is not null).ToList();
            app = stated.Count == 0 ? (resources.Count == 0 ? AppState.Missing : null) : stated.Any(r => r.Running == true) ? AppState.Running : AppState.Stopped;
        }

        return new SystemScope(node.Id, serviceCode, telemetry, via, pillar.SubscriptionId, workspace, resources.OrderBy(r => r.Name, StringComparer.Ordinal).ToList()) { AppState = app };
    }

    private static string Group(Match match, string name) => match.Groups[name].Success ? match.Groups[name].Value : "";
    private static string Compact(string text) => text.Replace(" ", "");
    private static string? TagValue(InventoryResource r, string key) => r.Tags.FirstOrDefault(t => t.Key.Equals(key, StringComparison.OrdinalIgnoreCase)).Value;
}
