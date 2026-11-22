using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Logs;

/// <summary>
/// The Logs tab of a live town: when a system's inspector opens its Logs tab, one query for that system's telemetry name over the environment's window
/// (<c>logs:</c> in the environment file) goes to the source the file names. Nothing runs otherwise and nothing is kept. The rows come back grouped by
/// the query; repeats of the same text are added up here too, so the tab shows one line with a count. A worker keeps only the logs and exceptions
/// sections. While a page looks at the past, the same question is asked about the window that ended at that time. An environment with no <c>logs:</c> block, or a source that cannot be asked, answers "not configured" (absent, not an empty tab).
/// </summary>
public sealed class QueryLogSource(IReadOnlyList<IMetricSource> sources, IRegistryProvider registries, ScopeStore scope, TimeProvider time) : ILogSource
{
    public string Name => "query";

    public Task<SystemLogs> RecentAsync(RegistryNode node, CancellationToken ct) => ReadAsync(node, time.GetUtcNow(), false, ct);

    /// <summary>The same question moved to a past time: the window that ended at <paramref name="at"/>, with <c>ago()</c> and <c>now()</c> of the query moved to it (<see cref="SourceQuery.AtPast"/>).</summary>
    public Task<SystemLogs> AtAsync(RegistryNode node, DateTimeOffset at, CancellationToken ct) => ReadAsync(node, at, true, ct);

    private async Task<SystemLogs> ReadAsync(RegistryNode node, DateTimeOffset now, bool past, CancellationToken ct)
    {
        var view = registries.Current;
        var environment = view.ActiveEnvironment;
        if (environment?.Logs is not { } config)
            return new SystemLogs(now, false, "", node.SlaP99Ms, []);
        var source = sources.OfType<ILogRowSource>().FirstOrDefault(s => s.CanReadLogs && ((IMetricSource)s).Name == config.Source)
            ?? throw new InvalidOperationException($"the logs source '{config.Source}' is not running, or it replays a recording that has no logs to read");
        var window = SourceQuery.Text(config.Window);
        var role = scope.Resolve(view).System(node.Id)?.TelemetryRole;
        if (string.IsNullOrWhiteSpace(role))
            return new SystemLogs(now, true, window, node.SlaP99Ms, []);

        var from = now - config.Window;
        var query = LogQuery.Render(config.Query, environment.Id, environment.Scope, role, node.Kind, node.SlaP99Ms, config.Window, from, now);
        if (past) query = SourceQuery.AtPast(query, now);
        var rows = await source.ReadLogsAsync(view, query, from, now, ct);
        return new SystemLogs(now, true, window, node.SlaP99Ms, Sections(rows, LogSections.For(node.Kind), config, environment, role, scope.Resolve(view).AssetList, config.Window, from, now));
    }

    /// <summary>
    /// The sections asked for, in order, each with its rows grouped (same text and result: one group, counted, the newest on top) and newest first, and the
    /// header links of the environment for it.
    /// </summary>
    public static IReadOnlyList<LogSection> Sections(IReadOnlyList<LogRow> rows, IEnumerable<string> wanted, LogsConfig config, RegistryEnvironment environment, string role,
        IReadOnlyList<ResolvedAsset> assets, TimeSpan window, DateTimeOffset from, DateTimeOffset to) =>
        wanted.Select(id =>
        {
            var groups = rows
                .Where(r => r.Section.Equals(id, StringComparison.OrdinalIgnoreCase))
                .GroupBy(r => (r.Text, r.Result))
                .Select(g =>
                {
                    var newest = g.OrderByDescending(r => r.At).First();
                    return new LogGroup(newest.At, newest.Level, newest.Text, g.Sum(r => r.Count), newest.DurationMs, newest.Result);
                })
                .OrderByDescending(g => g.At)
                .ToList();
            // a query that does not group could return thousands of lines: the newest are kept and the tab says how many more there were
            return new LogSection(id, groups.Take(MaxGroupsPerSection).ToList(),
                LogQuery.Links(config.Links, id, assets, environment.Scope, environment.Id, role, window, from, to), Math.Max(0, groups.Count - MaxGroupsPerSection));
        }).ToList();

    /// <summary>The most lines one section of the Logs tab shows.</summary>
    public const int MaxGroupsPerSection = 200;
}
