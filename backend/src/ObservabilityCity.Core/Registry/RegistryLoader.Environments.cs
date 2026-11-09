using System.Text.RegularExpressions;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Sources;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ObservabilityCity.Core.Registry;

/// <summary>The environment files of a registry: reading each one, its links, logs and sources, and checking them. Part of <see cref="RegistryLoader"/>.</summary>
public static partial class RegistryLoader
{
    /// <summary>
    /// Reads environments/*.yaml. The file name is the environment's id. A file with problems is reported (an error in a strict load) and, in a
    /// resilient load, left out, so the other environments still run. A town without the folder has no environments.
    /// </summary>
    private static List<RegistryEnvironment> LoadEnvironments(string folder, HashSet<string> ids, Dictionary<string, string> aliases, bool resilient, Action<string> problem)
    {
        var dir = Path.Combine(folder, "environments");
        var result = new List<RegistryEnvironment>();
        if (!Directory.Exists(dir)) return result;
        var parsed = new List<(RegistryEnvironment Env, int Order)>();
        foreach (var file in Directory.GetFiles(dir, "*.yaml").OrderBy(f => f, StringComparer.Ordinal))
        {
            var stem = Path.GetFileNameWithoutExtension(file);
            var name = $"environments/{Path.GetFileName(file)}";
            var own = new List<string>();
            EnvironmentFile? f = null;
            try { f = Read<EnvironmentFile>(file, name); }
            catch (RegistryException e) { own.Add(e.Message); }
            if (f is not null) CheckEnvironment(f, stem, name, ids, aliases, own);
            if (own.Count > 0)
            {
                foreach (var message in own) problem(message);
                continue;
            }
            var excluded = f!.Exclude.Select(id => ids.Contains(id) ? id : aliases[id]).ToHashSet();
            parsed.Add((new RegistryEnvironment(
                stem, f.Name ?? stem, f.Default,
                f.Sources.Select(kv => new RegistrySource(kv.Key, kv.Value.Kind.ToLowerInvariant(), kv.Value.Connection)
                    { Credential = kv.Value.Credential, PollSeconds = kv.Value.PollSeconds, TimeoutSeconds = kv.Value.TimeoutSeconds, LateAfterSeconds = kv.Value.LateAfterSeconds, Query = kv.Value.Query, RegionQuery = kv.Value.RegionQuery, TypesQuery = kv.Value.TypesQuery, Window = kv.Value.Window, Metrics = ToMetrics(kv.Value.Metrics), Entities = ToEntities(kv.Value.Entities), Providers = kv.Value.Providers.Select(p => p.Trim()).ToList(), KeepResolvedFor = kv.Value.KeepResolvedFor }).ToList(),
                f.Tenants.Select(t => new RegistryTenant(t.Id, t.Name ?? t.Id, t.Kind.Equals("test", StringComparison.OrdinalIgnoreCase) ? TenantKind.Test : TenantKind.Customer)).ToList(),
                excluded, f.Fake?.UndeclaredTenants ?? [])
            {
                Credentials = f.Credentials.Select(kv => new RegistryCredential(kv.Key, kv.Value.Kind.ToLowerInvariant(), kv.Value.TenantId, kv.Value.ClientId, kv.Value.ClientSecretEnv)).ToList(),
                Signals = f.Signals,
                Scope = ToScope(f.Scope),
                Links = ToLinks(f.Links),
                Logs = ToLogs(f.Logs),
            }, f.Order ?? 100));
        }
        var ordered = parsed.OrderBy(p => p.Order).ThenBy(p => p.Env.Id, StringComparer.Ordinal).Select(p => p.Env).ToList();
        if (ordered.Count(e => e.IsDefault) > 1)
            problem($"environments: {string.Join(" and ", ordered.Where(e => e.IsDefault).Select(e => $"'{e.Id}'"))} are all marked default: only one environment can be");
        return ordered;
    }

    private static ObservabilityCity.Core.Links.LinkDiscovery? ToLinks(LinksFile? f) => f is null ? null : new ObservabilityCity.Core.Links.LinkDiscovery(
        f.Source, f.Query,
        Duration(f.Interval, ObservabilityCity.Core.Links.LinkDiscovery.DefaultInterval),
        Duration(f.FirstRead, ObservabilityCity.Core.Links.LinkDiscovery.DefaultFirstRead),
        f.MinDays ?? ObservabilityCity.Core.Links.LinkDiscovery.DefaultMinDays,
        Duration(f.KeepFor, ObservabilityCity.Core.Links.LinkDiscovery.DefaultKeepFor),
        f.IgnoreHosts,
        f.Rules.Select(r => new ObservabilityCity.Core.Links.LinkRule(r.Host, r.Path, r.Target, r.Gateway)).ToList(),
        f.Aliases)
    {
        Traffic = f.Traffic is null ? null : new ObservabilityCity.Core.Links.LinkTrafficConfig(
            f.Traffic.Query,
            Duration(f.Traffic.ShareWindow, ObservabilityCity.Core.Links.LinkTrafficConfig.DefaultShareWindow),
            f.Traffic.MinCalls ?? ObservabilityCity.Core.Links.LinkTrafficConfig.DefaultMinCalls,
            Duration(f.Traffic.Interval, ObservabilityCity.Core.Links.LinkTrafficConfig.DefaultInterval)),
    };

    private static ObservabilityCity.Core.Logs.LogsConfig? ToLogs(LogsFile? f) => f is null ? null : new ObservabilityCity.Core.Logs.LogsConfig(
        f.Source, f.Query, Duration(f.Window, ObservabilityCity.Core.Logs.LogsConfig.DefaultWindow),
        f.Links.Select(l => new ObservabilityCity.Core.Logs.LogLinkRule(l.Name, l.Section.Trim().ToLowerInvariant(), l.Resources, l.Url.Trim())).ToList());

    private static void CheckLogs(EnvironmentFile f, string name, List<string> errors)
    {
        if (f.Logs is not { } logs) return;
        var owner = $"{name}: logs";
        if (!f.Sources.TryGetValue(logs.Source, out var source))
            errors.Add($"{owner}.source '{logs.Source}' is not a source of this file.{DidYouMean.Hint(logs.Source, f.Sources.Keys)}");
        else if (!source.Kind.Equals("loganalytics", StringComparison.OrdinalIgnoreCase))
            errors.Add($"{owner}.source '{logs.Source}' is a {source.Kind} source; the logs are read from a loganalytics source");
        var own = (IEnumerable<string>?)f.Scope?.Variables.Keys ?? [];
        if (string.IsNullOrWhiteSpace(logs.Query)) errors.Add($"{owner}.query is empty. Write the query that returns one row for each kind of entry with the columns {string.Join(", ", ObservabilityCity.Core.Logs.LogQuery.Columns)}");
        else foreach (var problem in ScopeTemplate.Check(logs.Query, ObservabilityCity.Core.Logs.LogQuery.Variables.Append(ScopeRules.EnvironmentVariable).Concat(own))) errors.Add($"{owner}.query: {problem}");
        if (logs.Window is { } window && !SourceQuery.TryParseWindow(window, out _)) errors.Add($"{owner}.window '{window}' is not a number and a unit like 4h or 30m");
        var assetRules = (f.Scope?.Assets.Select(r => r.Name) ?? []).ToList();
        var seen = new HashSet<(string, string)>();
        foreach (var l in logs.Links)
        {
            var link = $"{owner}.links '{l.Name}'";
            if (l.Name.Trim().Length == 0) errors.Add($"{owner}.links: a link needs a name, the words on the link");
            if (!ObservabilityCity.Core.Logs.LogSections.All.Contains(l.Section.Trim(), StringComparer.OrdinalIgnoreCase))
                errors.Add($"{link}: section '{l.Section}' is not one of {string.Join(", ", ObservabilityCity.Core.Logs.LogSections.All)}.{DidYouMean.Hint(l.Section, ObservabilityCity.Core.Logs.LogSections.All)}");
            else if (!seen.Add((l.Section.Trim().ToLowerInvariant(), l.Name))) errors.Add($"{owner}.links: '{l.Name}' is listed twice for the section {l.Section}");
            if (!assetRules.Contains(l.Resources, StringComparer.OrdinalIgnoreCase))
                errors.Add($"{link}: resources '{l.Resources}' is not a scope.assets rule of this file.{DidYouMean.Hint(l.Resources, assetRules)}");
            var url = l.Url.Trim();
            if (!url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                errors.Add($"{link}: url must start with https:// (or http://) written out, so a variable can never choose the scheme or host");
            foreach (var problem in ScopeTemplate.Check(url, ObservabilityCity.Core.Logs.LogQuery.LinkVariables.Append(ScopeRules.EnvironmentVariable).Concat(own))) errors.Add($"{link}.url: {problem}");
        }
    }

    private static TimeSpan Duration(string? text, TimeSpan fallback) =>
        text is not null && SourceQuery.TryParseWindow(text, out var d) ? d : fallback;

    private static void CheckLinks(EnvironmentFile f, string name, List<string> errors)
    {
        if (f.Links is not { } links) return;
        var owner = $"{name}: links";
        if (!f.Sources.TryGetValue(links.Source, out var source))
            errors.Add($"{owner}.source '{links.Source}' is not a source of this file.{DidYouMean.Hint(links.Source, f.Sources.Keys)}");
        else if (!source.Kind.Equals("loganalytics", StringComparison.OrdinalIgnoreCase))
            errors.Add($"{owner}.source '{links.Source}' is a {source.Kind} source; link discovery reads dependencies from a loganalytics source");
        if (string.IsNullOrWhiteSpace(links.Query)) errors.Add($"{owner}.query is empty. Write the query that returns one row for each caller and address with the columns {string.Join(", ", ObservabilityCity.Core.Links.LinkQuery.Columns)}");
        else
        {
            var known = ObservabilityCity.Core.Links.LinkQuery.Variables.Append(ScopeRules.EnvironmentVariable).Concat((IEnumerable<string>?)f.Scope?.Variables.Keys ?? []);
            foreach (var problem in ScopeTemplate.Check(links.Query, known)) errors.Add($"{owner}.query: {problem}");
        }
        foreach (var (key, text) in new[] { ("interval", links.Interval), ("firstRead", links.FirstRead), ("keepFor", links.KeepFor) })
            if (text is not null && !SourceQuery.TryParseWindow(text, out _)) errors.Add($"{owner}.{key} '{text}' is not a number and a unit like 1h or 7d");
        if (links.MinDays is < 1) errors.Add($"{owner}.minDays is {links.MinDays}; it must be at least 1");
        if (links.Traffic is { } traffic)
        {
            var at = $"{owner}.traffic";
            if (string.IsNullOrWhiteSpace(traffic.Query)) errors.Add($"{at}.query is empty. Write the query that returns one row for each caller and address with the columns caller, host and calls (path for a gateway)");
            else
            {
                var known = ObservabilityCity.Core.Links.LinkQuery.Variables.Append(ScopeRules.EnvironmentVariable).Concat((IEnumerable<string>?)f.Scope?.Variables.Keys ?? []);
                foreach (var problem in ScopeTemplate.Check(traffic.Query, known)) errors.Add($"{at}.query: {problem}");
            }
            foreach (var (key, text) in new[] { ("shareWindow", traffic.ShareWindow), ("interval", traffic.Interval) })
                if (text is not null && !SourceQuery.TryParseWindow(text, out _)) errors.Add($"{at}.{key} '{text}' is not a number and a unit like 5m or 1h");
            if (traffic.MinCalls is < 1) errors.Add($"{at}.minCalls is {traffic.MinCalls}; it must be at least 1");
        }
        foreach (var pattern in links.IgnoreHosts)
            if (!TryRegex(pattern, out var problem)) errors.Add($"{owner}.ignoreHosts '{pattern}': {problem}");
        for (var i = 0; i < links.Rules.Count; i++)
        {
            var rule = links.Rules[i];
            var at = $"{owner}.rules[{i}]";
            var groups = new List<string> { ObservabilityCity.Core.Links.LinkRules.CallerPillar };
            if (string.IsNullOrWhiteSpace(rule.Host)) errors.Add($"{at} needs a host pattern");
            else if (!TryRegex(rule.Host, out var problem)) errors.Add($"{at}.host '{rule.Host}': {problem}");
            else groups.AddRange(ObservabilityCity.Core.Links.LinkRules.GroupNames(rule.Host));
            if (rule.Path is not null)
            {
                if (!TryRegex(rule.Path, out var problem)) errors.Add($"{at}.path '{rule.Path}': {problem}");
                else groups.AddRange(ObservabilityCity.Core.Links.LinkRules.GroupNames(rule.Path));
            }
            if (string.IsNullOrWhiteSpace(rule.Target)) errors.Add($"{at} needs a target: the system id, with {{group}} holes for what the patterns capture");
            else foreach (var problem in ScopeTemplate.Check(rule.Target, groups)) errors.Add($"{at}.target: {problem} Name the group in the host or path pattern, as (?<name>...)");
        }
    }

    private static bool TryRegex(string pattern, out string problem)
    {
        problem = "";
        try { _ = new System.Text.RegularExpressions.Regex(pattern, System.Text.RegularExpressions.RegexOptions.None, ObservabilityCity.Core.Links.LinkDiscovery.RegexTimeout); return true; }
        catch (ArgumentException e) { problem = $"is not a valid regular expression ({e.Message})"; return false; }
    }

    private static void CheckEnvironment(EnvironmentFile f, string stem, string name, HashSet<string> ids, Dictionary<string, string> aliases, List<string> errors)
    {
        if (!KebabId.IsMatch(stem)) errors.Add($"{name}: the file name '{stem}' is the environment's id and must be lowercase kebab-case");
        foreach (var (source, def) in f.Sources)
        {
            if (!KebabId.IsMatch(source))
                errors.Add($"{name}: source name '{source}' must be lowercase kebab-case");
            if (!KebabId.IsMatch(def.Kind.ToLowerInvariant()))
                errors.Add($"{name}: source '{source}' has kind '{def.Kind}', which must be lowercase kebab-case. Which kinds exist depends on the adapters loaded; `validate` checks that");
            if (def.PollSeconds is <= 0) errors.Add($"{name}: source '{source}' has pollSeconds {def.PollSeconds}; it must be above 0");
            if (def.TimeoutSeconds is <= 0) errors.Add($"{name}: source '{source}' has timeoutSeconds {def.TimeoutSeconds}; it must be above 0");
            if (def.LateAfterSeconds is <= 0) errors.Add($"{name}: source '{source}' has lateAfterSeconds {def.LateAfterSeconds}; it must be above 0");
            CheckQuery(f, def, source, name, errors);
            CheckMetrics(f, def, source, name, errors);
            CheckEntities(f, def, source, name, errors);
            foreach (var provider in def.Providers)
                if (!System.Text.RegularExpressions.Regex.IsMatch(provider.Trim(), @"^[A-Za-z0-9]+(\.[A-Za-z0-9]+)+$"))
                    errors.Add($"{name}: source '{source}' has the provider '{provider}'. Write a resource provider the way the cloud names it, for example Namespace.Service");
            if (def.KeepResolvedFor is { } keep && !SourceQuery.TryParseWindow(keep, out _))
                errors.Add($"{name}: source '{source}' has keepResolvedFor '{keep}', which is not a number and a unit like 4h or 90m");
            if (def.Credential is not null && !f.Credentials.ContainsKey(def.Credential))
                errors.Add($"{name}: source '{source}' uses credential '{def.Credential}', which this file does not define.{DidYouMean.Hint(def.Credential, f.Credentials.Keys)}");
        }
        foreach (var (credential, def) in f.Credentials)
        {
            if (!KebabId.IsMatch(credential)) errors.Add($"{name}: credential name '{credential}' must be lowercase kebab-case");
            if (!KebabId.IsMatch(def.Kind.ToLowerInvariant())) errors.Add($"{name}: credential '{credential}' has kind '{def.Kind}', which must be lowercase kebab-case");
        }
        foreach (var (signal, source) in f.Signals)
        {
            if (!Signals.Known.Contains(signal))
                errors.Add($"{name}: unknown signal '{signal}'. Use {string.Join(", ", Signals.Known)}.{DidYouMean.Hint(signal, Signals.Known)}");
            if (source != Signals.None && !f.Sources.ContainsKey(source))
                errors.Add($"{name}: signal '{signal}' comes from source '{source}', which this file does not define.{DidYouMean.Hint(source, f.Sources.Keys)}");
        }
        CheckScope(f, name, errors);
        CheckLinks(f, name, errors);
        CheckLogs(f, name, errors);
        var seen = new HashSet<string>();
        foreach (var t in f.Tenants)
        {
            if (!KebabId.IsMatch(t.Id)) errors.Add($"{name}: tenant id '{t.Id}' must be lowercase kebab-case, because it is part of the tenant's database names");
            else if (!seen.Add(t.Id)) errors.Add($"{name}: tenant '{t.Id}' is listed twice");
            if (!t.Kind.Equals("customer", StringComparison.OrdinalIgnoreCase) && !t.Kind.Equals("test", StringComparison.OrdinalIgnoreCase))
                errors.Add($"{name}: tenant '{t.Id}' has kind '{t.Kind}'. Use customer or test.{DidYouMean.Hint(t.Kind, ["customer", "test"])}");
        }
        foreach (var id in f.Fake?.UndeclaredTenants ?? [])
        {
            if (!KebabId.IsMatch(id)) errors.Add($"{name}: undeclared tenant '{id}' must be lowercase kebab-case");
            else if (seen.Contains(id)) errors.Add($"{name}: '{id}' is both listed under tenants and an undeclared tenant: an undeclared tenant is one the list does not name");
        }
        foreach (var id in f.Exclude)
        {
            if (!ids.Contains(id) && !aliases.ContainsKey(id))
                errors.Add($"{name}: excludes '{id}', which is not in this town.{DidYouMean.Hint(id, ids.Concat(aliases.Keys))}");
            else if ((ids.Contains(id) ? id : aliases[id]).StartsWith("hub."))
                errors.Add($"{name}: excludes '{id}', a resource of the hub. The hub is the same in every environment");
        }
    }
}
