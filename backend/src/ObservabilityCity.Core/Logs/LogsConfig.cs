using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Logs;

/// <summary>
/// Where a system's Logs tab reads from (<c>logs:</c> in the environment file). <see cref="Source"/> names a Log Analytics source of the same file, whose
/// workspace and login the query reuses; <see cref="Query"/> is the template it sends when someone opens the tab (see <see cref="LogQuery"/>);
/// <see cref="Window"/> is how far back it looks. <see cref="TraceLinks"/> are templates for the addresses that open one request's full trace somewhere else.
/// The program knows no table, column or tracing tool: a different query (or, later, a different adapter) reads a different shape.
/// </summary>
public sealed record LogsConfig(string Source, string Query, TimeSpan Window, IReadOnlyList<ResourceLinkRule> TraceLinks)
{
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromHours(4);
}
