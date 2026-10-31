using System.Text.RegularExpressions;

namespace ObservabilityCity.Core.Registry;

/// <summary>
/// How an environment maps its pillars and systems onto the cloud: which subscription a pillar lives in, which workspace the telemetry is in, which
/// resources belong to a service and what the telemetry calls a system. The core knows none of the conventions; every one is a rule or a template
/// here, with variables, and an environment without a <c>scope:</c> block has none (<see cref="IsEmpty"/>).
/// </summary>
public sealed record ScopeRules
{
    public static ScopeRules None { get; } = new();

    /// <summary>The name of the environment source that reads the inventory (a resourcegraph source). Without it, the only such source.</summary>
    public string? Inventory { get; init; }

    /// <summary>The workspace the telemetry is in, a template over <see cref="Variables"/> and {environment}. Null: none is configured.</summary>
    public string? Workspace { get; init; }

    /// <summary>The workspace's id (a GUID, or a resource id), a template. When it is given it is used as it is and the name is not looked up.</summary>
    public string? WorkspaceId { get; init; }

    /// <summary>Your own words for the templates: {env} and so on. Values are plain text.</summary>
    public IReadOnlyDictionary<string, string> Variables { get; init; } = new Dictionary<string, string>();

    /// <summary>How a pillar finds its subscription when this file does not name it.</summary>
    public SubscriptionRule? Subscription { get; init; }

    /// <summary>Pillar id to subscription id, for the pillars that are named instead of found.</summary>
    public IReadOnlyDictionary<string, string> PillarSubscriptions { get; init; } = new Dictionary<string, string>();

    /// <summary>How resources are told to belong to a service.</summary>
    public IReadOnlyList<ResourceRule> Resources { get; init; } = [];

    /// <summary>What the telemetry calls a system that does not say (<c>telemetry.role</c>), a template over the system's own words. Null: it is not derived.</summary>
    public string? TelemetryRole { get; init; }

    /// <summary>Addresses that open a resource somewhere else (a portal, a console). None: no link is shown.</summary>
    public IReadOnlyList<ResourceLinkRule> Links { get; init; } = [];

    /// <summary>How a service's region is read and named, and where the per-region view is off. None: the resource's location, shown as it is, on wherever a service has two regions.</summary>
    public RegionRules Regions { get; init; } = RegionRules.Default;

    /// <summary>Overrides for the queries the inventory source sends. Null: the adapter's own.</summary>
    public ScopeQueries Queries { get; init; } = new(null, null);

    public bool IsEmpty => Inventory is null && Workspace is null && WorkspaceId is null && Subscription is null && PillarSubscriptions.Count == 0 && Resources.Count == 0 && TelemetryRole is null;

    public const string EnvironmentVariable = "environment";
    public static readonly string[] PillarVariables = ["pillar", "pillarId"];
    /// <summary>What a link template can use besides the environment's variables and {environment}: the resource's own words.</summary>
    public static readonly string[] LinkVariables = ["resourceId", "name", "type", "region", "subscriptionId", "tenantId", "tenantName"];
    public static readonly string[] SystemVariables = ["system", "service", "name", "role", "pillar", "pillarId"];
}

/// <summary>
/// How regions are read. <see cref="Tag"/> is the tag of a resource that says its region (without it, the location the cloud gives, or the <c>region</c> group of the resource pattern);
/// <see cref="Names"/> gives the label to show for a region value (an unmapped value is shown as it is). <see cref="Enabled"/> false turns the region view off in the whole environment,
/// and <see cref="Off"/> lists the pillars it is off for there.
/// </summary>
public sealed record RegionRules(string? Tag, IReadOnlyDictionary<string, string> Names, bool Enabled, IReadOnlyList<string> Off)
{
    public static RegionRules Default { get; } = new(null, new Dictionary<string, string>(), true, []);

    /// <summary>The label for a region value.</summary>
    public string Label(string region) => Names.FirstOrDefault(kv => kv.Key.Equals(region, StringComparison.OrdinalIgnoreCase)).Value is { Length: > 0 } label ? label : region;
}

/// <summary>Finds a pillar's subscription by its display name (a wildcard pattern) or by a tag on the subscription. Both are templates over {pillar}, {pillarId} and the variables.</summary>
public sealed record SubscriptionRule(string? NameLike, string? TagKey, string? TagValue);

/// <summary>
/// One kind of resource that belongs to a service. <see cref="Pattern"/> is a regular expression over the resource's name with the named groups
/// <c>service</c> (required), and optionally <c>role</c>, <c>pillar</c>, <c>region</c> and <c>tenant</c>. <see cref="Roles"/> limits it to systems of
/// those roles (api, worker, db...). <see cref="ServiceTag"/> is a fallback: a resource whose name does not match but whose tag says the service.
/// <see cref="TenantNameTag"/> is the tag that holds the tenant's friendly name. <see cref="Instances"/> is the expression the inventory query uses to count
/// the instances one resource of this rule runs (a plan's workers, an app's replicas); the instances of a system are the sum over its resources of such rules. <see cref="State"/> is the expression that reads one resource's app state as text, and <see cref="Running"/> the values of it that mean the app runs (any other value means stopped); the core knows no state words.
/// </summary>
public sealed record ResourceRule(string Name, IReadOnlyList<string> Types, string Pattern, IReadOnlyList<string> Roles, string? ServiceTag, string? TenantNameTag, string? Instances = null, string? State = null, IReadOnlyList<string>? Running = null);

/// <summary>
/// One address to make for a resource. <see cref="Url"/> is a template over <see cref="ScopeRules.LinkVariables"/>, {environment} and the environment's variables; it starts with
/// http:// or https://. <see cref="Types"/> limits it to resources of those types (empty: every resource).
/// </summary>
public sealed record ResourceLinkRule(string Name, string Url, IReadOnlyList<string> Types);

/// <summary>Query templates for the inventory source. {types} stands for the quoted resource types the rules name; {instances} for the expression that counts the instances of each (from the rules' <c>instances</c>). The workspaces query returns id, name and customerId (the workspace id) of every workspace, and the name is matched here.</summary>
public sealed record ScopeQueries(string? Subscriptions, string? Resources, string? Workspaces = null);

/// <summary>Templates with {variable} and {variable|filter} holes. Filters: nospace, lower, upper.</summary>
public static partial class ScopeTemplate
{
    public static readonly string[] Filters = ["nospace", "lower", "upper"];

    [GeneratedRegex(@"\{([A-Za-z][A-Za-z0-9]*)(?:\|([a-z]+))?\}")]
    private static partial Regex Hole();

    /// <summary>The variables a template uses, with the filter each has (null for none).</summary>
    public static IEnumerable<(string Variable, string? Filter)> Holes(string template) =>
        Hole().Matches(template).Select(m => (m.Groups[1].Value, m.Groups[2].Success ? m.Groups[2].Value : null));

    /// <summary>What is wrong with a template: a variable not in <paramref name="known"/> or a filter that does not exist. Empty when it is fine.</summary>
    public static IEnumerable<string> Check(string template, IEnumerable<string> known)
    {
        var allowed = known.ToHashSet(StringComparer.Ordinal);
        foreach (var (variable, filter) in Holes(template))
        {
            if (!allowed.Contains(variable))
                yield return $"{{{variable}}} is not a variable here. Use {string.Join(", ", allowed.Order(StringComparer.Ordinal).Select(v => "{" + v + "}"))}.{DidYouMean.Hint(variable, allowed)}";
            if (filter is not null && !Filters.Contains(filter))
                yield return $"the filter '{filter}' does not exist. Use {string.Join(", ", Filters)}.";
        }
    }

    /// <summary>The template with every hole filled; a variable without a value becomes empty.</summary>
    public static string Render(string template, Func<string, string?> value) =>
        Hole().Replace(template, m =>
        {
            var text = value(m.Groups[1].Value) ?? "";
            return m.Groups[2].Value switch
            {
                "nospace" => text.Replace(" ", ""),
                "lower" => text.ToLowerInvariant(),
                "upper" => text.ToUpperInvariant(),
                _ => text,
            };
        });

    /// <summary>A wildcard pattern (* any run, ? one character), matched without regard to case.</summary>
    public static bool Like(string text, string pattern) =>
        Regex.IsMatch(text, "^" + Regex.Escape(pattern).Replace(@"\*", ".*").Replace(@"\?", ".") + "$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
}
