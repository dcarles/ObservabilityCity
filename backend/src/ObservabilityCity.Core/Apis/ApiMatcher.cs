using System.Text.RegularExpressions;
using ObservabilityCity.Core.Links;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Core.Apis;

/// <summary>What an API's backend address belongs to: a town system, a third party, or nothing the rules know.</summary>
public readonly record struct ApiMatch(string? SystemId, string? ThirdPartyId)
{
    public static readonly ApiMatch None = new(null, null);
}

/// <summary>
/// Matches a backend address to a system or a third party, by the rules the environment already has: its <c>links</c> rules (an address pattern that carries the service) and the third parties'
/// domains (the same <see cref="LinkClassifier"/> link discovery uses), then the <c>apis.resourceHosts</c> templates, which turn an address into the name of one of the town's own resources
/// (a web app's default address, for example) and so into the system that owns it. Pure: it reads no clock and calls nothing. A backend that two rules fit takes the first, in that order.
/// </summary>
public sealed class ApiMatcher
{
    private readonly LinkClassifier _classifier;
    private readonly IReadOnlyList<Regex> _resourceHosts;
    private readonly IReadOnlyDictionary<string, string> _resourceToSystem;
    private readonly Func<string, string?>? _extra;

    public ApiMatcher(TownRegistry view, RegistryEnvironment? environment, ApiCatalogueConfig config, Resolution resolution, Func<string, string?>? extra = null)
    {
        var links = environment?.Links ?? new LinkDiscovery("", "", LinkDiscovery.DefaultInterval, LinkDiscovery.DefaultFirstRead, LinkDiscovery.DefaultMinDays, LinkDiscovery.DefaultKeepFor, [], [], new Dictionary<string, string>());
        _classifier = new LinkClassifier(links, view.Vendors, view.AllNodes.Select(n => n.Id), LinkClassifier.ServicesOf(view.AllNodes));
        _resourceHosts = config.ResourceHosts.Select(Template).ToList();
        // a resource name two systems claim is ambiguous and never used
        _resourceToSystem = resolution.Systems.SelectMany(s => s.Resources.Select(r => (Name: r.Name.ToLowerInvariant(), s.SystemId))).Distinct()
            .GroupBy(x => x.Name).Where(g => g.Count() == 1).ToDictionary(g => g.Key, g => g.First().SystemId);
        _extra = extra;
    }

    /// <summary>A template like <c>{name}.example.test</c> as a pattern that captures the name.</summary>
    public static Regex Template(string template) =>
        new("^" + Regex.Escape(template.Trim()).Replace(Regex.Escape("{name}"), "(?<name>[^.]+)") + "$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    public ApiMatch Match(string? backendUrl)
    {
        if (string.IsNullOrWhiteSpace(backendUrl) || !Uri.TryCreate(backendUrl, UriKind.Absolute, out var uri)) return ApiMatch.None;
        var host = uri.Host.ToLowerInvariant();
        var path = uri.AbsolutePath is { Length: > 1 } p ? p : null;
        var found = _classifier.Classify(new DependencyRow("", host, path, [], 0), "");
        if (found.Outcome == LinkOutcome.Found && found.Target is { } id) return new ApiMatch(id, null);
        if (found.Outcome == LinkOutcome.Vendor && found.Target is { } vendor) return new ApiMatch(null, vendor);
        foreach (var pattern in _resourceHosts)
            if (pattern.Match(host) is { Success: true } m && _resourceToSystem.TryGetValue(m.Groups["name"].Value.ToLowerInvariant(), out var system))
                return new ApiMatch(system, null);
        return _extra?.Invoke(host) is { } extra ? new ApiMatch(extra, null) : ApiMatch.None;
    }
}
