using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Scope;

/// <summary>
/// Makes the addresses that open a resource somewhere else, from the environment's <c>scope.links</c> templates. Every value is percent-encoded before it
/// goes into the address (a resource id keeps its slashes), the scheme and host come only from the template, and an address that does not come out as
/// an http or https address is dropped. The program never calls the address; the browser shows it as a link.
/// </summary>
public static class ScopeLinks
{
    public static IReadOnlyList<ResourceLink>? For(ScopeRules rules, string environment, ResolvedResource resource, string? subscriptionId, string? tenantName)
    {
        if (rules.Links.Count == 0) return null;
        string? Value(string name) => name switch
        {
            "resourceId" => string.Join("/", resource.Id.Split('/').Select(Uri.EscapeDataString)),
            "name" => Uri.EscapeDataString(resource.Name),
            "type" => Uri.EscapeDataString(resource.Type),
            "region" => Encode(resource.Region),
            "subscriptionId" => Encode(subscriptionId),
            "tenantId" => Encode(resource.Tenant),
            "tenantName" => Encode(tenantName),
            ScopeRules.EnvironmentVariable => Uri.EscapeDataString(environment),
            _ => rules.Variables.TryGetValue(name, out var own) ? Uri.EscapeDataString(own) : null,
        };
        var links = new List<ResourceLink>();
        foreach (var rule in rules.Links)
        {
            if (rule.Types.Count > 0 && !rule.Types.Contains(resource.Type, StringComparer.OrdinalIgnoreCase)) continue;
            var url = ScopeTemplate.Render(rule.Url, Value);
            if (Uri.TryCreate(url, UriKind.Absolute, out var parsed) && (parsed.Scheme == Uri.UriSchemeHttps || parsed.Scheme == Uri.UriSchemeHttp))
                links.Add(new ResourceLink(rule.Name, url));
        }
        return links.Count == 0 ? null : links;
    }

    private static string? Encode(string? value) => value is null ? null : Uri.EscapeDataString(value);
}
