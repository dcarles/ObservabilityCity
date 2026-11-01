using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Logs;

/// <summary>
/// Where a system's Logs tab reads from (<c>logs:</c> in the environment file). <see cref="Source"/> names a Log Analytics source of the same file, whose
/// workspace and login the query reuses; <see cref="Query"/> is the template it sends when someone opens the tab (see <see cref="LogQuery"/>);
/// <see cref="Window"/> is how far back it looks. <see cref="Links"/> put links in the header of a section that open the telemetry store's own search,
/// already filtered to the system. The program knows no table, column or tracing tool: a different query (or, later, a different adapter) reads a different shape.
/// </summary>
public sealed record LogsConfig(string Source, string Query, TimeSpan Window, IReadOnlyList<LogLinkRule> Links)
{
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromHours(4);
}

/// <summary>
/// One link in the header of a Logs tab section. <see cref="Section"/> is failed, slow, logs or exceptions; <see cref="Resources"/> names a <c>scope.assets</c>
/// rule, and each resource that rule finds (a telemetry store that is active, and one that takes over on a failover) gets its own link made from
/// <see cref="Url"/>, a template over <see cref="LogQuery.LinkVariables"/>. Nothing found means no link.
/// </summary>
public sealed record LogLinkRule(string Name, string Section, string Resources, string Url);
