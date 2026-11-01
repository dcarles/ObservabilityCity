using System.Globalization;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Logs;

/// <summary>One row of the logs query: one kind of entry (a section), seen <see cref="Count"/> times, the newest at <see cref="At"/>.</summary>
public sealed record LogRow(string Section, DateTimeOffset At, string Text, int Count, LogLevel? Level, string? OperationId, double? DurationMs, string? Result);

/// <summary>A source that can answer the logs query (the Log Analytics adapter does). The Logs tab never learns which cloud is behind it.</summary>
public interface ILogRowSource
{
    /// <summary>False for a source that cannot be asked (a recorded answer kept for trying metrics offline).</summary>
    bool CanReadLogs { get; }

    /// <summary>Sends the query, already filled in, over [<paramref name="from"/>, <paramref name="to"/>) and returns its rows. Azure does the grouping; no raw entries come back.</summary>
    Task<IReadOnlyList<LogRow>> ReadLogsAsync(Registry.Registry registry, string query, DateTimeOffset from, DateTimeOffset to, CancellationToken ct);
}

/// <summary>The four sections of the Logs tab, in the order they are shown.</summary>
public static class LogSections
{
    public const string Failed = "failed";
    public const string Slow = "slow";
    public const string Logs = "logs";
    public const string Exceptions = "exceptions";

    public static readonly string[] All = [Failed, Slow, Logs, Exceptions];

    /// <summary>What a worker, a function or anything else that does not answer requests keeps: its warnings and errors, and its exceptions.</summary>
    public static readonly string[] WithoutRequests = [Logs, Exceptions];

    public static string[] For(NodeKind kind) => kind is NodeKind.Api or NodeKind.Gateway ? All : WithoutRequests;
}

/// <summary>
/// The variables the logs query template may use, besides the scope variables and {environment}: {roles} (the system's telemetry name, double-quoted),
/// {from} and {to} (UTC, ISO 8601), {window} (for example 4h), {windowSeconds}, {slaMs} (the system's own p99 SLA, the line slow requests are measured
/// against) and {kind} (api, worker and so on). The query returns one row for each kind of entry with the columns <c>section</c> (failed, slow, logs or
/// exceptions), <c>at</c> (the newest time) and <c>text</c>; <c>count</c>, <c>level</c>, <c>operationId</c>, <c>durationMs</c> and <c>result</c> may be left out.
/// </summary>
public static class LogQuery
{
    public const string From = "from";
    public const string To = "to";
    public const string SlaMs = "slaMs";
    public const string Kind = "kind";
    public static readonly string[] Variables = [SourceQuery.Roles, SourceQuery.Window, SourceQuery.WindowSeconds, From, To, SlaMs, Kind];
    public static readonly string[] Columns = ["section", "at", "text", "count", "level", "operationId", "durationMs", "result"];

    /// <summary>The variables a trace link template may use besides the scope variables and {environment}.</summary>
    public static readonly string[] LinkVariables = ["operationId", "role", "time"];

    public static string Render(string template, string environmentId, ScopeRules rules, string role, NodeKind kind, double slaMs, TimeSpan window, DateTimeOffset from, DateTimeOffset to) =>
        ScopeTemplate.Render(template, name => name switch
        {
            SourceQuery.Roles => "\"" + role.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"",
            SourceQuery.Window => SourceQuery.Text(window),
            SourceQuery.WindowSeconds => ((long)Math.Round(window.TotalSeconds)).ToString(CultureInfo.InvariantCulture),
            From => Iso(from),
            To => Iso(to),
            SlaMs => slaMs.ToString("0.###", CultureInfo.InvariantCulture),
            Kind => kind.ToString().ToLowerInvariant(),
            ScopeRules.EnvironmentVariable => environmentId,
            _ => rules.Variables.GetValueOrDefault(name),
        });

    public static string Iso(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    /// <summary>
    /// The addresses of one entry's full trace, from the environment's <c>logs.traceLinks</c>. Every value is percent-encoded, the scheme and host come only
    /// from the template, and an address that does not come out as an http or https address is dropped. Null when there is no operation to open or no link.
    /// </summary>
    public static IReadOnlyList<ResourceLink>? Links(IReadOnlyList<ResourceLinkRule> rules, ScopeRules scope, string environmentId, string role, string? operationId, DateTimeOffset at)
    {
        if (rules.Count == 0 || string.IsNullOrWhiteSpace(operationId)) return null;
        string? Value(string name) => name switch
        {
            "operationId" => Uri.EscapeDataString(operationId),
            "role" => Uri.EscapeDataString(role),
            "time" => Uri.EscapeDataString(Iso(at)),
            ScopeRules.EnvironmentVariable => Uri.EscapeDataString(environmentId),
            _ => scope.Variables.TryGetValue(name, out var own) ? Uri.EscapeDataString(own) : null,
        };
        var links = new List<ResourceLink>();
        foreach (var rule in rules)
        {
            var url = ScopeTemplate.Render(rule.Url, Value);
            if (Uri.TryCreate(url, UriKind.Absolute, out var parsed) && (parsed.Scheme == Uri.UriSchemeHttps || parsed.Scheme == Uri.UriSchemeHttp))
                links.Add(new ResourceLink(rule.Name, url));
        }
        return links.Count == 0 ? null : links;
    }
}
