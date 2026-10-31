using System.Text.RegularExpressions;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Links;

/// <summary>One dependency the query found: who called which address, on which days, and about how many times (the table is sampled, so only a rough size).</summary>
public sealed record DependencyRow(string Caller, string Host, string? Path, IReadOnlyList<DateOnly> Days, double Calls);

public enum LinkOutcome
{
    /// <summary>Platform noise the ignore list names.</summary>
    Ignored,
    /// <summary>A known third party. Recognised, not drawn yet.</summary>
    Vendor,
    /// <summary>A system of the town, or a service of a vendor island.</summary>
    Found,
    /// <summary>No rule explains the address.</summary>
    Unresolved,
    /// <summary>A rule explains it and names a system of a pillar the town does not have (yet). Nothing is wrong: it will link up when the pillar joins.</summary>
    OutsideTown,
}

public readonly record struct Classified(LinkOutcome Outcome, string? Target = null, bool Gateway = false);

/// <summary>Decides what a call's address is, by the environment's rules and nothing else. Pure: it reads no clock and no file.</summary>
public sealed class LinkClassifier
{
    private readonly List<Regex> _ignore;
    private readonly List<(Regex Host, Regex? Path, LinkRule Rule)> _rules;
    private readonly IReadOnlyDictionary<string, string> _aliases;
    private readonly IReadOnlyList<string> _vendorDomains;
    private readonly Dictionary<string, string> _systems;
    private readonly HashSet<string> _pillars;
    private readonly List<(string Id, string Host, Regex? Path)> _services;

    public LinkClassifier(LinkDiscovery config, IEnumerable<RegistryVendor> vendors, IEnumerable<string> systemIds)
    {
        const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
        _ignore = config.IgnoreHosts.Select(p => new Regex(p, Options, LinkDiscovery.RegexTimeout)).ToList();
        _rules = config.Rules.Select(r => (new Regex(r.Host, Options, LinkDiscovery.RegexTimeout), r.Path is null ? null : new Regex(r.Path, Options, LinkDiscovery.RegexTimeout), r)).ToList();
        _aliases = new Dictionary<string, string>(config.Aliases, StringComparer.OrdinalIgnoreCase);
        _vendorDomains = vendors.SelectMany(v => v.Domains).Select(d => d.Trim().TrimStart('.').ToLowerInvariant()).Where(d => d.Length > 0).ToList();
        _services = vendors.SelectMany(v => v.Matches.Select(m => (v.Node.Id, m.Host.Trim().TrimStart('.').ToLowerInvariant(), m.Path is null ? null : new Regex(m.Path, Options, LinkDiscovery.RegexTimeout))))
            .Where(m => m.Item2.Length > 0).ToList();
        _systems = systemIds.ToDictionary(id => id, id => id, StringComparer.OrdinalIgnoreCase);
        _pillars = _systems.Keys.Select(Pillar).ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    public Classified Classify(DependencyRow row, string callerPillar)
    {
        if (_ignore.Any(r => r.IsMatch(row.Host))) return new Classified(LinkOutcome.Ignored);
        Classified? outside = null;
        foreach (var (host, path, rule) in _rules)
        {
            var hostMatch = host.Match(row.Host);
            if (!hostMatch.Success) continue;
            Match? pathMatch = null;
            if (path is not null)
            {
                if (row.Path is null) continue;
                pathMatch = path.Match(row.Path);
                if (!pathMatch.Success) continue;
            }
            var target = ScopeTemplate.Render(rule.Target, name => name == LinkRules.CallerPillar ? callerPillar : Captured(name, hostMatch, pathMatch));
            if (_systems.TryGetValue(target, out var id)) return new Classified(LinkOutcome.Found, id, rule.Gateway);
            // the rule fits, and names a pillar no system of the town belongs to: a pillar that has not joined the town yet
            if (outside is null && target.Contains('.') && !_pillars.Contains(Pillar(target))) outside = new Classified(LinkOutcome.OutsideTown, target, rule.Gateway);
        }
        var h = row.Host.ToLowerInvariant();
        // a service of a vendor island: the address says which building the call goes to
        foreach (var (id, domain, path) in _services)
        {
            if (h != domain && !h.EndsWith("." + domain, StringComparison.Ordinal)) continue;
            if (path is not null && (row.Path is null || !path.IsMatch(row.Path))) continue;
            return new Classified(LinkOutcome.Found, id);
        }
        if (_vendorDomains.Any(d => h == d || h.EndsWith("." + d, StringComparison.Ordinal))) return new Classified(LinkOutcome.Vendor);
        return outside ?? new Classified(LinkOutcome.Unresolved);
    }

    /// <summary>The pillar a system id belongs to: what comes before the first dot.</summary>
    public static string Pillar(string systemId) => systemId.Split('.')[0];

    private string? Captured(string name, Match host, Match? path)
    {
        var group = host.Groups[name];
        if (!group.Success && path is not null) group = path.Groups[name];
        if (!group.Success) return null;
        return _aliases.TryGetValue(group.Value, out var alias) ? alias : group.Value;
    }
}
