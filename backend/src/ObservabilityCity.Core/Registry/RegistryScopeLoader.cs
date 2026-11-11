using ObservabilityCity.Core.Sources;
using System.Text.RegularExpressions;

namespace ObservabilityCity.Core.Registry;

public static partial class RegistryLoader
{
    private static readonly string[] ResourceGroups = ["service", "role", GroupWords.Group, GroupWords.Pillar, "region", "tenant"]; // group: older name pillar
    private static readonly string[] SystemRoles = ["api", "worker", "db", "cache", "function", "cron", "gateway", "broker", "egress"];

    private static ScopeRules ToScope(ScopeFile? f) =>
        f is null ? ScopeRules.None : new ScopeRules
        {
            Inventory = f.Inventory,
            TelemetryStore = f.TelemetryStore,
            TelemetryStoreId = f.TelemetryStoreId,
            Variables = f.Variables,
            Account = ToAccount(f.Account),
            PillarAccounts = f.PillarAccounts,
            Resources = f.Resources.Select(r => new ResourceRule(r.Name, r.Types, r.Pattern, r.Roles.Select(x => x.ToLowerInvariant() == "cron" ? "function" : x.ToLowerInvariant()).ToList(), r.ServiceTag, r.TenantNameTag, string.IsNullOrWhiteSpace(r.Instances) ? null : r.Instances.Trim(),
                string.IsNullOrWhiteSpace(r.State) ? null : r.State.Trim(), r.Running.Count == 0 ? null : r.Running)
            {
                Account = ToAccount(r.Account),
            }).ToList(),
            Cloud = string.IsNullOrWhiteSpace(f.Cloud) ? null : f.Cloud.Trim(),
            Assets = f.Assets.Select(a => new AssetRule(a.Name, a.Label.Trim(), a.Shape.Trim().ToLowerInvariant(), a.Types, a.Pattern)
            {
                Island = string.IsNullOrWhiteSpace(a.Island) ? null : a.Island.Trim().ToLowerInvariant(),
                Group = string.IsNullOrWhiteSpace(a.Group) ? null : a.Group.Trim(),
                Account = ToAccount(a.Account),
            }).ToList(),
            TelemetryRole = f.TelemetryRole,
            Links = f.Links.Select(l => new ResourceLinkRule(l.Name, l.Url.Trim(), l.Types)).ToList(),
            Regions = f.Regions is null ? RegionRules.Default : new RegionRules(string.IsNullOrWhiteSpace(f.Regions.Tag) ? null : f.Regions.Tag.Trim(), f.Regions.Names, f.Regions.Skew ?? RegionRules.DefaultSkew),
            Queries = new ScopeQueries(f.Queries?.Accounts, f.Queries?.Resources, f.Queries?.TelemetryStores),
        };

    private static AccountRule? ToAccount(AccountRuleFile? f) => f is null ? null : new AccountRule(f.NameLike, f.Tag?.Key, f.Tag?.Value);

    private static void CheckQuery(EnvironmentFile f, SourceFile def, string source, string name, List<string> errors)
    {
        if (def.Window is { } window && !SourceQuery.TryParseWindow(window, out _))
            errors.Add($"{name}: source '{source}' has window '{window}'. Write a number and a unit: 30s, 5m or 1h");
        if (def.Query is not { } query) return;
        if (query.Trim().Length == 0) errors.Add($"{name}: source '{source}' has an empty query; give the query to send, or leave it out");
        var known = f.Scope?.Variables.Keys.Append(ScopeRules.EnvironmentVariable).Concat(SourceQuery.Variables) ?? [ScopeRules.EnvironmentVariable, .. SourceQuery.Variables];
        foreach (var problem in ScopeTemplate.Check(query, known)) errors.Add($"{name}: source '{source}' query: {problem}");
    }

    private static void CheckScope(EnvironmentFile f, string name, List<string> errors)
    {
        if (f.Scope is not { } s) return;
        var at = $"{name}: scope";
        if (s.Inventory is not null && !f.Sources.ContainsKey(s.Inventory))
            errors.Add($"{at}.inventory names source '{s.Inventory}', which this file does not define.{DidYouMean.Hint(s.Inventory, f.Sources.Keys)}");
        foreach (var variable in s.Variables.Keys)
        {
            if (variable == ScopeRules.EnvironmentVariable) errors.Add($"{at}.variables: '{variable}' is the environment's own id and cannot be redefined");
            // {group} and {groupId} are the group's own words (older names {pillar} and {pillarId}): a variable of that name would hide them in one spelling and not the other
            else if (GroupWords.OlderNames.ContainsKey(variable)) errors.Add($"{at}.variables: '{variable}' is a word of the group itself ({{{variable}}}, older name {{{GroupWords.OlderNames[variable]}}}) and cannot be redefined. Give the variable another name");
            else if (!Regex.IsMatch(variable, "^[A-Za-z][A-Za-z0-9]*$")) errors.Add($"{at}.variables: '{variable}' must be letters and digits, starting with a letter, to be used as {{{variable}}}");
        }
        var own = s.Variables.Keys.Append(ScopeRules.EnvironmentVariable).ToList();
        void Template(string? text, string where, IEnumerable<string> known)
        {
            if (text is null) return;
            foreach (var problem in ScopeTemplate.Check(text, known)) errors.Add($"{at}.{where}: {problem}");
        }
        Template(s.TelemetryStore, "telemetryStore", own);
        Template(s.TelemetryStoreId, "telemetryStoreId", own);
        if (s.TelemetryStore is { } named && named.Trim().Length == 0) errors.Add($"{at}.telemetryStore is empty; give the telemetry store's name (or a pattern like logs-*-prod), or leave it out");
        if (s.TelemetryStoreId is { } given && given.Trim().Length == 0) errors.Add($"{at}.telemetryStoreId is empty; give the telemetry store's id (for example a GUID) or leave it out");
        Template(s.TelemetryRole, "telemetryRole", own.Concat(ScopeRules.SystemVariables));
        if (s.Account is { } sub)
        {
            var hasName = sub.NameLike is not null;
            var hasTag = sub.Tag is not null;
            if (hasName == hasTag) errors.Add($"{at}.account needs exactly one of nameLike or tag");
            Template(sub.NameLike, "account.nameLike", own.Concat(ScopeRules.PillarVariables));
            if (sub.Tag is { } tag)
            {
                if (tag.Key.Length == 0) errors.Add($"{at}.account.tag needs a key");
                Template(tag.Value, "account.tag.value", own.Concat(ScopeRules.PillarVariables));
            }
        }
        foreach (var (pillar, account) in s.PillarAccounts)
        {
            if (!KebabId.IsMatch(pillar)) errors.Add($"{at}.pillarAccounts: '{pillar}' must be a pillar id (lowercase kebab-case)");
            if (account.Trim().Length == 0) errors.Add($"{at}.pillarAccounts.{pillar} is empty; name an account id or leave the pillar out");
        }
        if (s.Regions is { } regions)
        {
            if (regions.Tag is { } regionTag && regionTag.Trim().Length == 0) errors.Add($"{at}.regions.tag is empty; name the tag that holds a resource's region, or leave it out");
            foreach (var (value, label) in regions.Names)
                if (label.Trim().Length == 0) errors.Add($"{at}.regions.names: '{value}' has an empty label");
            if (regions.Skew is { } skew && (!double.IsFinite(skew) || skew <= 0.5 || skew > 1)) errors.Add($"{at}.regions.skew is {skew}; give a share above 0.5 and up to 1 (1 never flags)");
        }
        var linkNames = new HashSet<string>();
        foreach (var l in s.Links)
        {
            var link = $"{at}.links '{l.Name}'";
            if (l.Name.Trim().Length == 0) errors.Add($"{at}.links: a link needs a name, the words on the link");
            else if (!linkNames.Add(l.Name)) errors.Add($"{at}.links: '{l.Name}' is listed twice");
            var url = l.Url.Trim();
            if (!url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                errors.Add($"{link}: url must start with https:// (or http://) written out, so a variable can never choose the scheme or host");
            foreach (var problem in ScopeTemplate.Check(url, own.Concat(ScopeRules.LinkVariables))) errors.Add($"{link}.url: {problem}");
            if (l.Types.Any(t => t.Trim().Length == 0)) errors.Add($"{link}: types has an empty entry");
        }
        var assetNames = new HashSet<string>();
        foreach (var a in s.Assets)
        {
            var rule = $"{at}.assets '{a.Name}'";
            if (!KebabId.IsMatch(a.Name)) errors.Add($"{at}.assets: name '{a.Name}' must be lowercase kebab-case");
            else if (!assetNames.Add(a.Name)) errors.Add($"{at}.assets: '{a.Name}' is listed twice");
            if (a.Label.Trim().Length == 0) errors.Add($"{rule} needs a label, the words the drawer calls it (for example Key vault)");
            if (!AssetRule.Shapes.Contains(a.Shape.Trim().ToLowerInvariant())) errors.Add($"{rule}: shape '{a.Shape}'. Use {string.Join(", ", AssetRule.Shapes)}.{DidYouMean.Hint(a.Shape, AssetRule.Shapes)}");
            if (a.Types.Count == 0) errors.Add($"{rule} needs types (the resource types it applies to)");
            var onHub = string.Equals(a.Island?.Trim(), AssetRule.HubIsland, StringComparison.OrdinalIgnoreCase);
            if (!string.IsNullOrWhiteSpace(a.Island) && !onHub) errors.Add($"{rule}: island '{a.Island}'. The only island other than a pillar's own is '{AssetRule.HubIsland}'; leave island out for a pillar's resource");
            if (onHub && string.IsNullOrWhiteSpace(a.Group)) errors.Add($"{rule} stands on the hub, so it needs a group: the name of the cluster of buildings it stands in (for example Monitoring)");
            if (!onHub && !string.IsNullOrWhiteSpace(a.Group)) errors.Add($"{rule}: group only applies to a building on the hub (island: hub)");
            if (!onHub && a.Account is not null) errors.Add($"{rule}: account only applies to a building on the hub (island: hub); a pillar's resources are looked for in the pillar's account");
            if (a.Account is { } assetSub)
            {
                if ((assetSub.NameLike is not null) == (assetSub.Tag is not null)) errors.Add($"{rule}.account needs exactly one of nameLike or tag");
                Template(assetSub.NameLike, $"assets '{a.Name}'.account.nameLike", own);
                if (assetSub.Tag is { } assetTag)
                {
                    if (assetTag.Key.Length == 0) errors.Add($"{rule}.account.tag needs a key");
                    Template(assetTag.Value, $"assets '{a.Name}'.account.tag.value", own);
                }
            }
            try
            {
                var regex = new Regex(a.Pattern, RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
                var allowed = onHub ? AssetRule.HubGroups : AssetRule.Groups;
                foreach (var g in regex.GetGroupNames().Where(g => !int.TryParse(g, out _) && !allowed.Contains(g)))
                    errors.Add($"{rule}: pattern has the group '{g}'. Use {string.Join(", ", allowed)}.{DidYouMean.Hint(g, allowed)}");
            }
            catch (ArgumentException e) { errors.Add($"{rule}: pattern is not a valid regular expression: {e.Message}"); }
        }
        var seen = new HashSet<string>();
        foreach (var r in s.Resources)
        {
            var rule = $"{at}.resources '{r.Name}'";
            if (!KebabId.IsMatch(r.Name)) errors.Add($"{at}.resources: name '{r.Name}' must be lowercase kebab-case");
            else if (!seen.Add(r.Name)) errors.Add($"{at}.resources: '{r.Name}' is listed twice");
            if (r.Types.Count == 0) errors.Add($"{rule} needs types (the resource types it applies to, for example a plan or an account type)");
            if (r.Account is { } ruleSub)
            {
                if ((ruleSub.NameLike is not null) == (ruleSub.Tag is not null)) errors.Add($"{rule}.account needs exactly one of nameLike or tag");
                Template(ruleSub.NameLike, $"resources '{r.Name}'.account.nameLike", own);
                if (ruleSub.Tag is { } ruleTag)
                {
                    if (ruleTag.Key.Length == 0) errors.Add($"{rule}.account.tag needs a key");
                    Template(ruleTag.Value, $"resources '{r.Name}'.account.tag.value", own);
                }
            }
            if (r.Instances is { } counting && counting.Trim().Length == 0) errors.Add($"{rule}: instances is empty; give the expression that counts a resource's instances, or leave it out");
            if (r.State is { } reading && reading.Trim().Length == 0) errors.Add($"{rule}: state is empty; give the expression that reads a resource's app state, or leave it out");
            if (r.State is not null && r.Running.Count == 0) errors.Add($"{rule}: state needs running, the values of it that mean the app runs (any other value is shown as stopped)");
            if (r.State is null && r.Running.Count > 0) errors.Add($"{rule}: running is only used with state");
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
