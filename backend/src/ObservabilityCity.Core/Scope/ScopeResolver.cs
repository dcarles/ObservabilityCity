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

        var pillars = new List<PillarScope>();
        foreach (var group in view.Groups)
            pillars.Add(ResolvePillar(group, rules, Custom, inventory, problems));

        var systems = new List<SystemScope>();
        var tenantNames = new Dictionary<string, string>();
        foreach (var group in view.Groups)
        {
            var pillar = pillars.First(p => p.PillarId == group.Id);
            foreach (var node in group.Nodes)
                systems.Add(ResolveSystem(node, group, pillar, rules, Custom, workspace, inventory, tenantNames, problems));
        }

        foreach (var clash in systems.Where(s => s.TelemetryRole is not null).GroupBy(s => s.TelemetryRole!, StringComparer.OrdinalIgnoreCase).Where(g => g.Count() > 1))
            problems.Add($"Telemetry role '{clash.Key}' is used by {string.Join(" and ", clash.Select(s => $"'{s.SystemId}'"))}; the telemetry of one would be read as the other. Give each its own telemetry.role.");

        return new Resolution(pillars, systems, tenantNames.Select(kv => new TenantName(kv.Key, kv.Value)).OrderBy(t => t.Id, StringComparer.Ordinal).ToList(), problems, inventory is not null, workspace);
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

                    resources.Add(new ResolvedResource(resource.Id, resource.Name, resource.Type, region, tenant, rule.Name, rule.Instances is null ? null : resource.Instances));
                    if (tenant is not null && rule.TenantNameTag is { } nameTag && TagValue(resource, nameTag) is { Length: > 0 } friendly)
                        tenantNames.TryAdd(tenant, friendly);
                }
            }
            if (applicable.Count > 0 && resources.Count == 0 && node.Kind is NodeKind.Api or NodeKind.Worker or NodeKind.Database)
                problems.Add($"No resource found for '{node.Id}' (service code '{serviceCode}') in {pillar.SubscriptionName ?? pillar.SubscriptionId}. Check serviceCode and the resource patterns under scope.resources.");
        }

        return new SystemScope(node.Id, serviceCode, telemetry, via, pillar.SubscriptionId, workspace, resources.OrderBy(r => r.Name, StringComparer.Ordinal).ToList());
    }

    private static string Group(Match match, string name) => match.Groups[name].Success ? match.Groups[name].Value : "";
    private static string Compact(string text) => text.Replace(" ", "");
    private static string? TagValue(InventoryResource r, string key) => r.Tags.FirstOrDefault(t => t.Key.Equals(key, StringComparison.OrdinalIgnoreCase)).Value;
}
