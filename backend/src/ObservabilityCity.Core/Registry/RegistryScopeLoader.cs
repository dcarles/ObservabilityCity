using System.Text.RegularExpressions;

namespace ObservabilityCity.Core.Registry;

public static partial class RegistryLoader
{
    private static readonly string[] ResourceGroups = ["service", "role", "pillar", "region", "tenant"];
    private static readonly string[] SystemRoles = ["api", "worker", "db", "cache", "cron", "gateway", "broker", "egress"];

    private static ScopeRules ToScope(ScopeFile? f) =>
        f is null ? ScopeRules.None : new ScopeRules
        {
            Inventory = f.Inventory,
            Workspace = f.Workspace,
            Variables = f.Variables,
            Subscription = f.Subscription is null ? null : new SubscriptionRule(f.Subscription.NameLike, f.Subscription.Tag?.Key, f.Subscription.Tag?.Value),
            PillarSubscriptions = f.Pillars,
            Resources = f.Resources.Select(r => new ResourceRule(r.Name, r.Types, r.Pattern, r.Roles.Select(x => x.ToLowerInvariant()).ToList(), r.ServiceTag, r.TenantNameTag)).ToList(),
            TelemetryRole = f.TelemetryRole,
            Queries = new ScopeQueries(f.Queries?.Subscriptions, f.Queries?.Resources),
        };

    private static void CheckScope(EnvironmentFile f, string name, List<string> errors)
    {
        if (f.Scope is not { } s) return;
        var at = $"{name}: scope";
        if (s.Inventory is not null && !f.Sources.ContainsKey(s.Inventory))
            errors.Add($"{at}.inventory names source '{s.Inventory}', which this file does not define.{DidYouMean.Hint(s.Inventory, f.Sources.Keys)}");
        foreach (var variable in s.Variables.Keys)
        {
            if (variable == ScopeRules.EnvironmentVariable) errors.Add($"{at}.variables: '{variable}' is the environment's own id and cannot be redefined");
            else if (!Regex.IsMatch(variable, "^[A-Za-z][A-Za-z0-9]*$")) errors.Add($"{at}.variables: '{variable}' must be letters and digits, starting with a letter, to be used as {{{variable}}}");
        }
        var own = s.Variables.Keys.Append(ScopeRules.EnvironmentVariable).ToList();
        void Template(string? text, string where, IEnumerable<string> known)
        {
            if (text is null) return;
            foreach (var problem in ScopeTemplate.Check(text, known)) errors.Add($"{at}.{where}: {problem}");
        }
        Template(s.Workspace, "workspace", own);
        Template(s.TelemetryRole, "telemetryRole", own.Concat(ScopeRules.SystemVariables));
        if (s.Subscription is { } sub)
        {
            var hasName = sub.NameLike is not null;
            var hasTag = sub.Tag is not null;
            if (hasName == hasTag) errors.Add($"{at}.subscription needs exactly one of nameLike or tag");
            Template(sub.NameLike, "subscription.nameLike", own.Concat(ScopeRules.PillarVariables));
            if (sub.Tag is { } tag)
            {
                if (tag.Key.Length == 0) errors.Add($"{at}.subscription.tag needs a key");
                Template(tag.Value, "subscription.tag.value", own.Concat(ScopeRules.PillarVariables));
            }
        }
        foreach (var (pillar, subscription) in s.Pillars)
        {
            if (!KebabId.IsMatch(pillar)) errors.Add($"{at}.pillars: '{pillar}' must be a pillar id (lowercase kebab-case)");
            if (subscription.Trim().Length == 0) errors.Add($"{at}.pillars.{pillar} is empty; name a subscription id or leave the pillar out");
        }
        var seen = new HashSet<string>();
        foreach (var r in s.Resources)
        {
            var rule = $"{at}.resources '{r.Name}'";
            if (!KebabId.IsMatch(r.Name)) errors.Add($"{at}.resources: name '{r.Name}' must be lowercase kebab-case");
            else if (!seen.Add(r.Name)) errors.Add($"{at}.resources: '{r.Name}' is listed twice");
            if (r.Types.Count == 0) errors.Add($"{rule} needs types (the resource types it applies to, for example a plan or an account type)");
            foreach (var role in r.Roles)
                if (!SystemRoles.Contains(role, StringComparer.OrdinalIgnoreCase))
                    errors.Add($"{rule}: roles has '{role}'. Use {string.Join(", ", SystemRoles)}.{DidYouMean.Hint(role, SystemRoles)}");
            Regex regex;
            try { regex = new Regex(r.Pattern, RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)); }
            catch (ArgumentException e)
            {
                errors.Add($"{rule}: pattern is not a valid regular expression: {e.Message}");
                continue;
            }
            var groups = regex.GetGroupNames().Where(g => !int.TryParse(g, out _)).ToList();
            if (!groups.Contains("service")) errors.Add($"{rule}: pattern needs a (?<service>...) group, the part of the name that says which service it belongs to");
            foreach (var g in groups.Where(g => !ResourceGroups.Contains(g)))
                errors.Add($"{rule}: pattern has the group '{g}'. Use {string.Join(", ", ResourceGroups)}.{DidYouMean.Hint(g, ResourceGroups)}");
        }
    }
}
