using ObservabilityCity.Core.Sources;
using System.Text.RegularExpressions;

namespace ObservabilityCity.Core.Registry;

public static partial class RegistryLoader
{
    private static readonly string[] ResourceGroups = ["service", "role", "pillar", "region", "tenant"];
    private static readonly string[] SystemRoles = ["api", "worker", "db", "cache", "function", "cron", "gateway", "broker", "egress"];

    private static ScopeRules ToScope(ScopeFile? f) =>
        f is null ? ScopeRules.None : new ScopeRules
        {
            Inventory = f.Inventory,
            Workspace = f.Workspace,
            WorkspaceId = f.WorkspaceId,
            Variables = f.Variables,
            Subscription = f.Subscription is null ? null : new SubscriptionRule(f.Subscription.NameLike, f.Subscription.Tag?.Key, f.Subscription.Tag?.Value),
            PillarSubscriptions = f.Pillars,
            Resources = f.Resources.Select(r => new ResourceRule(r.Name, r.Types, r.Pattern, r.Roles.Select(x => x.ToLowerInvariant() == "cron" ? "function" : x.ToLowerInvariant()).ToList(), r.ServiceTag, r.TenantNameTag, string.IsNullOrWhiteSpace(r.Instances) ? null : r.Instances.Trim(),
                string.IsNullOrWhiteSpace(r.State) ? null : r.State.Trim(), r.Running.Count == 0 ? null : r.Running)).ToList(),
            TelemetryRole = f.TelemetryRole,
            Links = f.Links.Select(l => new ResourceLinkRule(l.Name, l.Url.Trim(), l.Types)).ToList(),
            Regions = f.Regions is null ? RegionRules.Default : new RegionRules(string.IsNullOrWhiteSpace(f.Regions.Tag) ? null : f.Regions.Tag.Trim(), f.Regions.Names, f.Regions.Enabled ?? true, f.Regions.Off),
            Queries = new ScopeQueries(f.Queries?.Subscriptions, f.Queries?.Resources, f.Queries?.Workspaces),
        };

    private static void CheckQuery(EnvironmentFile f, SourceFile def, string source, string name, List<string> errors)
    {
        if (def.Window is { } window && !SourceQuery.TryParseWindow(window, out _))
            errors.Add($"{name}: source '{source}' has window '{window}'. Write a number and a unit: 30s, 5m or 1h");
        if (def.Query is not { } query) return;
        if (query.Trim().Length == 0) errors.Add($"{name}: source '{source}' has an empty query; give the query to send, or leave it out");
        var known = f.Scope?.Variables.Keys.Append(ScopeRules.EnvironmentVariable).Concat(SourceQuery.Variables) ?? [ScopeRules.EnvironmentVariable, .. SourceQuery.Variables];
        foreach (var problem in ScopeTemplate.Check(query, known)) errors.Add($"{name}: source '{source}' query: {problem}");
    }

    private static MetricSignal? ToSignal(MetricSignalFile? f) =>
        f is null ? null : new MetricSignal(f.Metric.Trim(), f.Aggregation.Trim().ToLowerInvariant(), string.IsNullOrWhiteSpace(f.Filter) ? null : f.Filter.Trim(), f.Scale, f.PerSecond, ToSignal(f.Over), ToSignal(f.OrElse));

    private static List<MetricGroup> ToMetrics(List<MetricGroupFile> files) =>
        files.Select(g => new MetricGroup(g.Resources, string.IsNullOrWhiteSpace(g.Namespace) ? null : g.Namespace.Trim(),
            new[] { ("cpu", g.Cpu), ("memory", g.Memory), ("utilisation", g.Utilisation), ("throttled", g.Throttled), ("requests", g.Requests), ("limit", g.Limit) }
                .Where(x => x.Item2 is not null).ToDictionary(x => x.Item1, x => ToSignal(x.Item2)!),
            string.IsNullOrWhiteSpace(g.Interval) ? null : SourceQuery.TryParseWindow(g.Interval, out var interval) ? interval : null,
            string.IsNullOrWhiteSpace(g.Window) ? null : SourceQuery.TryParseWindow(g.Window, out var window) ? window : null)).ToList();

    private static void CheckMetrics(EnvironmentFile f, SourceFile def, string source, string name, List<string> errors)
    {
        if (def.Metrics.Count == 0) return;
        var rules = f.Scope?.Resources.Select(r => r.Name).ToList() ?? [];
        var known = f.Scope?.Variables.Keys.Append(ScopeRules.EnvironmentVariable).ToList() ?? [ScopeRules.EnvironmentVariable];
        for (var i = 0; i < def.Metrics.Count; i++)
        {
            var group = def.Metrics[i];
            var at = $"{name}: source '{source}' metrics[{i}]";
            if (!rules.Contains(group.Resources))
                errors.Add($"{at}: resources '{group.Resources}' is not a rule of scope.resources.{(rules.Count == 0 ? " This file has no scope.resources." : $" Use {string.Join(", ", rules)}.")}{DidYouMean.Hint(group.Resources, rules)}");
            if (group.Interval is { } grain && (!SourceQuery.TryParseWindow(grain, out var parsed) || !MetricGroup.IntervalMinutes.Contains((int)Math.Round(parsed.TotalMinutes)) || Math.Abs(parsed.TotalMinutes - Math.Round(parsed.TotalMinutes)) > 1e-9))
                errors.Add($"{at}: interval '{grain}' is not a time grain the metrics API offers. Use one of {string.Join(", ", MetricGroup.IntervalMinutes.Select(m => m % 1440 == 0 ? $"{m / 1440}d" : m % 60 == 0 ? $"{m / 60}h" : $"{m}m"))}");
            if (group.Window is { } look)
            {
                var grainOf = group.Interval is { } g && SourceQuery.TryParseWindow(g, out var gp) ? gp : TimeSpan.FromMinutes(1);
                if (!SourceQuery.TryParseWindow(look, out var lookSpan)) errors.Add($"{at}: window '{look}' is not a number and a unit like 15m or 1h");
                else if (lookSpan < grainOf * 2) errors.Add($"{at}: window '{look}' holds fewer than two points of its {(group.Interval ?? "1m")} interval; make it at least {Math.Ceiling((grainOf * 2).TotalMinutes)}m");
            }
            var signals = new[] { ("cpu", group.Cpu), ("memory", group.Memory), ("utilisation", group.Utilisation), ("throttled", group.Throttled), ("requests", group.Requests), ("limit", group.Limit) }.Where(x => x.Item2 is not null).ToList();
            if (signals.All(s => s.Item1 == "limit")) errors.Add($"{at}: it asks for no signal. Give at least one of {string.Join(", ", MetricGroup.SignalNames)}");
            foreach (var (signal, spec) in signals)
            {
                CheckSignal(spec!, $"{at}.{signal}", false);
            }
        }

        void CheckSignal(MetricSignalFile spec, string at, bool isOver)
        {
            if (string.IsNullOrWhiteSpace(spec.Metric)) errors.Add($"{at}: metric is empty; give the metric's name");
            if (!MetricGroup.Aggregations.Contains(spec.Aggregation.Trim().ToLowerInvariant()))
                errors.Add($"{at}: aggregation '{spec.Aggregation}'. Use {string.Join(", ", MetricGroup.Aggregations)}.{DidYouMean.Hint(spec.Aggregation, MetricGroup.Aggregations)}");
            if (!double.IsFinite(spec.Scale) || spec.Scale <= 0) errors.Add($"{at}: scale must be above 0 (0.01 turns a percentage into a fraction)");
            if (spec.Filter is { } filter)
                foreach (var problem in ScopeTemplate.Check(filter, known)) errors.Add($"{at}.filter: {problem}");
            if (spec.OrElse is { } alt)
            {
                if (alt.Over is not null || alt.OrElse is not null) errors.Add($"{at}.orElse: it is only another metric to read in place; it cannot have an over or an orElse of its own");
                else CheckSignal(alt, $"{at}.orElse", true);
            }
            if (spec.Over is { } over)
            {
                if (isOver) errors.Add($"{at}: over cannot have an over of its own");
                else CheckSignal(over, $"{at}.over", true);
                if (over.PerSecond || over.Scale != 1) errors.Add($"{at}.over: the divisor is used as it is; put scale and perSecond on the metric itself");
            }
        }
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
            else if (!Regex.IsMatch(variable, "^[A-Za-z][A-Za-z0-9]*$")) errors.Add($"{at}.variables: '{variable}' must be letters and digits, starting with a letter, to be used as {{{variable}}}");
        }
        var own = s.Variables.Keys.Append(ScopeRules.EnvironmentVariable).ToList();
        void Template(string? text, string where, IEnumerable<string> known)
        {
            if (text is null) return;
            foreach (var problem in ScopeTemplate.Check(text, known)) errors.Add($"{at}.{where}: {problem}");
        }
        Template(s.Workspace, "workspace", own);
        Template(s.WorkspaceId, "workspaceId", own);
        if (s.Workspace is { } named && named.Trim().Length == 0) errors.Add($"{at}.workspace is empty; give the workspace's name (or a pattern like law-*-prod), or leave it out");
        if (s.WorkspaceId is { } given && given.Trim().Length == 0) errors.Add($"{at}.workspaceId is empty; give the workspace id (a GUID) or leave it out");
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
        if (s.Regions is { } regions)
        {
            if (regions.Tag is { } regionTag && regionTag.Trim().Length == 0) errors.Add($"{at}.regions.tag is empty; name the tag that holds a resource's region, or leave it out");
            foreach (var (value, label) in regions.Names)
                if (label.Trim().Length == 0) errors.Add($"{at}.regions.names: '{value}' has an empty label");
            foreach (var pillar in regions.Off)
                if (!KebabId.IsMatch(pillar)) errors.Add($"{at}.regions.off: '{pillar}' must be a pillar id (lowercase kebab-case)");
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
        var seen = new HashSet<string>();
        foreach (var r in s.Resources)
        {
            var rule = $"{at}.resources '{r.Name}'";
            if (!KebabId.IsMatch(r.Name)) errors.Add($"{at}.resources: name '{r.Name}' must be lowercase kebab-case");
            else if (!seen.Add(r.Name)) errors.Add($"{at}.resources: '{r.Name}' is listed twice");
            if (r.Types.Count == 0) errors.Add($"{rule} needs types (the resource types it applies to, for example a plan or an account type)");
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
