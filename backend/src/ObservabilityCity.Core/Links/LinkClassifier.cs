using System.Text.RegularExpressions;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Links;

/// <summary>One dependency the query found: who called which address, on which days, and about how many times (the table is sampled, so only a rough size).</summary>
public sealed record DependencyRow(string Caller, string Host, string? Path, IReadOnlyList<DateOnly> Days, double Calls);

public enum LinkOutcome
{
    /// <summary>Platform noise the ignore list names.</summary>
    Ignored,
    /// <summary>A known third party. <see cref="Classified.Target"/> is the vendor's id: its calls are counted for the traffic to it, nothing is drawn from the link itself.</summary>
    Vendor,
    /// <summary>A system of the town, or a service of a vendor island.</summary>
    Found,
    /// <summary>No rule explains the address.</summary>
    Unresolved,
    /// <summary>A rule explains it and names a system of a pillar the town does not have (yet). Nothing is wrong: it will link up when the pillar joins.</summary>
    OutsideTown,
}

/// <summary>A service as the registry knows it: which pillar, its name, and the short code its cloud resources carry (the name when it has none).</summary>
public readonly record struct ServiceCodeEntry(string Pillar, string Service, string Code);

public readonly record struct Classified(LinkOutcome Outcome, string? Target = null, bool Gateway = false);

/// <summary>Decides what a call's address is, by the environment's rules and nothing else. Pure: it reads no clock and no file.</summary>
public sealed class LinkClassifier
{
    private readonly List<Regex> _ignore;
    private readonly List<(Regex Host, Regex? Path, LinkRule Rule)> _rules;
    private readonly IReadOnlyDictionary<string, string> _aliases;
    private readonly List<(string Id, string Domain)> _vendorDomains;
    private readonly Dictionary<string, string> _systems;
    private readonly HashSet<string> _pillars;
    private readonly List<(string Id, string Host, Regex? Path)> _services;
    private readonly HashSet<(string Pillar, string Service)> _serviceNames;
    private readonly Dictionary<(string Pillar, string Code), string> _byCode;

    public LinkClassifier(LinkDiscovery config, IEnumerable<RegistryVendor> vendors, IEnumerable<string> systemIds, IEnumerable<ServiceCodeEntry>? services = null)
    {
        var entries = (services ?? []).ToList();
        _serviceNames = entries.Select(e => (e.Pillar.ToLowerInvariant(), e.Service.ToLowerInvariant())).ToHashSet();
        // a code that points at two different services of a pillar is ambiguous and never used
        _byCode = entries.GroupBy(e => (e.Pillar.ToLowerInvariant(), e.Code.ToLowerInvariant()))
            .Where(g => g.Select(e => e.Service.ToLowerInvariant()).Distinct().Count() == 1)
            .ToDictionary(g => g.Key, g => g.First().Service);
        const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
        _ignore = config.IgnoreHosts.Select(p => new Regex(p, Options, LinkDiscovery.RegexTimeout)).ToList();
        _rules = config.Rules.Select(r => (new Regex(r.Host, Options, LinkDiscovery.RegexTimeout), r.Path is null ? null : new Regex(r.Path, Options, LinkDiscovery.RegexTimeout), r)).ToList();
        _aliases = new Dictionary<string, string>(config.Aliases, StringComparer.OrdinalIgnoreCase);
        _vendorDomains = vendors.SelectMany(v => v.Domains.Select(d => (v.Node.Id, Domain: d.Trim().TrimStart('.').ToLowerInvariant()))).Where(d => d.Domain.Length > 0).ToList();
        _services = vendors.SelectMany(v => v.Matches.Select(m => (v.Node.Id, m.Host.Trim().TrimStart('.').ToLowerInvariant(), m.Path is null ? null : new Regex(m.Path, Options, LinkDiscovery.RegexTimeout))))
            .Where(m => m.Item2.Length > 0).ToList();
        _systems = systemIds.ToDictionary(id => id, id => id, StringComparer.OrdinalIgnoreCase);
        _pillars = _systems.Keys.Select(Pillar).ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>The services of the registry's systems, for matching an address that carries a service code.</summary>
    public static IEnumerable<ServiceCodeEntry> ServicesOf(IEnumerable<RegistryNode> nodes) =>
        nodes.Where(n => n.Service is { Length: > 0 }).Select(n => new ServiceCodeEntry(n.GroupId, n.Service!, n.ServiceCode is { Length: > 0 } c ? c : n.Service!));

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
            var target = ScopeTemplate.Render(rule.Target, name => name == LinkRules.CallerPillar ? callerPillar : Captured(name, hostMatch, pathMatch, callerPillar));
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
        foreach (var (id, domain) in _vendorDomains)
            if (h == domain || h.EndsWith("." + domain, StringComparison.Ordinal)) return new Classified(LinkOutcome.Vendor, id);
        return outside ?? new Classified(LinkOutcome.Unresolved);
    }

    /// <summary>The pillar a system id belongs to: what comes before the first dot.</summary>
    public static string Pillar(string systemId) => systemId.Split('.')[0];

    private string? Captured(string name, Match host, Match? path, string callerPillar)
    {
        var group = host.Groups[name];
        if (!group.Success && path is not null) group = path.Groups[name];
        if (!group.Success) return null;
        var value = _aliases.TryGetValue(group.Value, out var alias) ? alias : group.Value;
        if (name != "service") return value;
        // an address may carry a service's short code instead of its name: the pillar's own serviceCode says which service it is
        var pillarGroup = host.Groups["pillar"].Success ? host.Groups["pillar"] : path?.Groups["pillar"];
        var pillar = (pillarGroup is { Success: true } ? pillarGroup.Value : callerPillar).ToLowerInvariant();
        if (_aliases.ContainsKey(group.Value) || _serviceNames.Contains((pillar, value.ToLowerInvariant()))) return value;
        return _byCode.TryGetValue((pillar, value.ToLowerInvariant()), out var service) ? service : value;
    }
}
