using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Links;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>
/// Reads request rate, error share and latency from a Log Analytics workspace, for every system at once. It sends one query, the environment's own
/// template (<c>query</c> in the source definition), and reads one row per telemetry name with the columns <c>role</c>, <c>calls</c>, <c>errors</c> and
/// <c>latencyMs</c>. Which table, which metric names and which properties those come from is the query's business, so the adapter knows no company's
/// telemetry: a different query reads a different shape. The rows are matched to systems by their telemetry name (see <see cref="SystemScope.TelemetryRole"/>);
/// a system the answer has no row for made no calls in the window, which is reported as zero calls (quiet), not as unknown. Only systems that serve calls
/// (api, worker, gateway, cron) are asked about: a database or a broker has no span metrics, and gets no reading instead of a quiet one. Every row is read: nothing is cut off.
/// </summary>
public sealed class LogAnalyticsReader(HttpClient http, ICredentialSource? credential)
{
    public const string TokenScope = "https://api.loganalytics.io/.default";
    public const string Endpoint = "https://api.loganalytics.io/v1";

    public static readonly string[] Columns = ["role", "calls", "errors", "latencyMs"];

    /// <summary>The workspace is an id (a GUID) or a full resource id starting with a slash; a bare name cannot be queried.</summary>
    public static string QueryUrl(string workspace) =>
        workspace.StartsWith('/') ? $"{Endpoint}{workspace.TrimEnd('/')}/query" : $"{Endpoint}/workspaces/{Uri.EscapeDataString(workspace)}/query";

    public async Task<IReadOnlyList<SpanRow>> QueryAsync(string workspace, string query, TimeSpan window, CancellationToken ct) =>
        Parse(await SendAsync(workspace, query, System.Xml.XmlConvert.ToString(window), ct));

    /// <summary>The dependency rows of the link discovery query over [from, to).</summary>
    public async Task<IReadOnlyList<DependencyRow>> QueryDependenciesAsync(string workspace, string query, DateTimeOffset from, DateTimeOffset to, CancellationToken ct) =>
        ParseDependencies(await SendAsync(workspace, query, $"{LinkQuery.Iso(from)}/{LinkQuery.Iso(to)}", ct));

    private async Task<string> SendAsync(string workspace, string query, string timespan, CancellationToken ct)
    {
        var body = JsonSerializer.Serialize(new { query, timespan });
        using var request = new HttpRequestMessage(HttpMethod.Post, QueryUrl(workspace)) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        if (credential is not null)
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await credential.GetTokenAsync(TokenScope, ct));
        using var response = await http.SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"Log Analytics answered {(int)response.StatusCode} {response.ReasonPhrase}: {Trim(text)}");
        return text;
    }

    private static string Trim(string text) => text.Length <= 300 ? text : text[..300] + "...";

    /// <summary>The rows of the first table, matched to the columns by name (any case). A column the query does not return is a mistake worth naming; errors and latencyMs may be left out.</summary>
    public static IReadOnlyList<SpanRow> Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("tables", out var tables) || tables.ValueKind != JsonValueKind.Array || tables.GetArrayLength() == 0)
            throw new InvalidOperationException("the answer has no table; was the query a query that returns rows?");
        var table = tables[0];
        var names = table.GetProperty("columns").EnumerateArray().Select(c => c.GetProperty("name").GetString() ?? "").ToList();
        int Index(string column) => names.FindIndex(n => n.Equals(column, StringComparison.OrdinalIgnoreCase));
        var (role, calls, errors, latency) = (Index("role"), Index("calls"), Index("errors"), Index("latencyMs"));
        if (role < 0 || calls < 0)
            throw new InvalidOperationException($"the query must return the columns {string.Join(", ", Columns)} (errors and latencyMs may be left out); it returned {string.Join(", ", names)}");
        var rows = new List<SpanRow>();
        foreach (var row in table.GetProperty("rows").EnumerateArray())
        {
            if (row[role].ValueKind != JsonValueKind.String || row[role].GetString() is not { Length: > 0 } name) continue;
            rows.Add(new SpanRow(name, Number(row, calls) ?? 0, errors < 0 ? 0 : Number(row, errors) ?? 0, latency < 0 ? null : Number(row, latency)));
        }
        return rows;
    }

    /// <summary>
    /// The rows of the link discovery query: <c>caller</c>, <c>host</c> and <c>days</c> (an array of the days the call was seen on, or one day as text);
    /// <c>path</c> and <c>calls</c> may be left out. A row without a caller, a host or a day says nothing and is skipped.
    /// </summary>
    public static IReadOnlyList<DependencyRow> ParseDependencies(string json)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("tables", out var tables) || tables.ValueKind != JsonValueKind.Array || tables.GetArrayLength() == 0)
            throw new InvalidOperationException("the answer has no table; was the query a query that returns rows?");
        var table = tables[0];
        var names = table.GetProperty("columns").EnumerateArray().Select(c => c.GetProperty("name").GetString() ?? "").ToList();
        int Index(string column) => names.FindIndex(n => n.Equals(column, StringComparison.OrdinalIgnoreCase));
        var (caller, host, days, path, calls) = (Index("caller"), Index("host"), Index("days"), Index("path"), Index("calls"));
        if (caller < 0 || host < 0 || days < 0)
            throw new InvalidOperationException($"the link query must return the columns caller, host and days (path and calls may be left out); it returned {string.Join(", ", names)}");
        var rows = new List<DependencyRow>();
        foreach (var row in table.GetProperty("rows").EnumerateArray())
        {
            if (Text(row[caller]) is not { Length: > 0 } who || Text(row[host]) is not { Length: > 0 } where) continue;
            var seen = Days(row[days]);
            if (seen.Count == 0) continue;
            rows.Add(new DependencyRow(who, where, path < 0 ? null : Text(row[path]) is { Length: > 0 } p ? p : null, seen, calls < 0 ? 0 : Number(row, calls) ?? 0));
        }
        return rows;
    }

    private static string? Text(JsonElement v) => v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    // make_set gives a JSON array, or the same array as text; a plain day is accepted too
    private static List<DateOnly> Days(JsonElement v)
    {
        IEnumerable<string?> items = v.ValueKind switch
        {
            JsonValueKind.Array => v.EnumerateArray().Select(Text),
            JsonValueKind.String when v.GetString() is { } s && s.TrimStart().StartsWith('[') => JsonSerializer.Deserialize<List<string?>>(s) ?? [],
            JsonValueKind.String => [v.GetString()],
            _ => [],
        };
        var days = new List<DateOnly>();
        foreach (var item in items)
            if (item is { Length: >= 10 } && DateOnly.TryParse(item[..10], CultureInfo.InvariantCulture, out var day)) days.Add(day);
        return days;
    }

    private static double? Number(JsonElement row, int index)
    {
        var v = row[index];
        return v.ValueKind switch
        {
            JsonValueKind.Number when v.TryGetDouble(out var d) && double.IsFinite(d) && d >= 0 => d,
            JsonValueKind.String when double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && double.IsFinite(d) && d >= 0 => d,
            _ => null,
        };
    }
}

/// <summary>One telemetry name's calls in the window, how many of them were errors and their latency in milliseconds (null when the query gave none).</summary>
public sealed record SpanRow(string Role, double Calls, double Errors, double? LatencyMs);

/// <summary>
/// The Log Analytics source. Its connection is the workspace (an id or resource id); without one, the environment's <c>scope.workspace</c> is used.
/// <c>file:name.json</c> replays a recorded answer kept beside the town's files, for trying a query's shape offline and for tests.
/// </summary>
public sealed class LogAnalyticsSource(
    string name, string environmentId, RegistrySource definition, LogAnalyticsReader reader, ScopeStore store, ScopeRules rules, string? recording, TimeProvider time) : IMetricSource, IDependencySource
{
    public bool CanReadDependencies => recording is null;

    public async Task<IReadOnlyList<DependencyRow>> ReadDependenciesAsync(TownRegistry registry, string query, IReadOnlyCollection<string> roles, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
    {
        if (recording is not null) throw new InvalidOperationException($"source '{name}' replays a recording, which has no dependencies to read");
        var workspace = Workspace(store.Resolve(registry.ForEnvironment(environmentId)));
        return await reader.QueryDependenciesAsync(workspace, LinkQuery.Render(query, environmentId, rules, roles, from, to), from, to, ct);
    }

    public string Name => name;
    public TimeSpan PollInterval => definition.PollInterval;
    public TimeSpan Timeout => definition.Timeout;
    public TimeSpan Window { get; } = SourceQuery.WindowOf(definition);

    public async Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct)
    {
        var view = registry.ForEnvironment(environmentId);
        // a workspace given by name is looked up in the inventory, which is read at the same moment the first poll starts
        if (recording is null && string.IsNullOrWhiteSpace(definition.Connection) && store.Inventory is null) await store.WaitForReadAsync(Timeout / 2, ct);
        var resolution = store.Resolve(view);
        var serving = view.AllNodes.Where(n => n.Kind is NodeKind.Api or NodeKind.Worker or NodeKind.Gateway or NodeKind.Cron).Select(n => n.Id).ToHashSet();
        var asked = resolution.Systems.Where(s => serving.Contains(s.SystemId) && !string.IsNullOrWhiteSpace(s.TelemetryRole)).ToList();
        if (asked.Count == 0) return new Dictionary<string, NodeReading>();

        IReadOnlyList<SpanRow> rows;
        if (recording is not null)
            rows = LogAnalyticsReader.Parse(await File.ReadAllTextAsync(recording, ct));
        else
        {
            var query = definition.Query ?? throw new InvalidOperationException($"source '{name}' has no query. Write the query that returns one row per telemetry name with the columns {string.Join(", ", LogAnalyticsReader.Columns)} (see docs/connect-your-company.md)");
            var workspace = Workspace(resolution);
            rows = await reader.QueryAsync(workspace, SourceQuery.Render(query, definition, environmentId, rules, asked.Select(s => s.TelemetryRole!).Distinct(StringComparer.OrdinalIgnoreCase)), Window, ct);
        }
        return Readings(asked, rows, Window, time.GetUtcNow());
    }

    /// <summary>
    /// The workspace to query: the source's own connection, else the id the environment's scope settles (an explicit <c>workspaceId</c>, or the id of the
    /// workspace found by its name). A name that has not been looked up yet is a wait, not a mistake in the files, and the message says so.
    /// </summary>
    private string Workspace(Resolution resolution)
    {
        var connection = definition.Connection;
        var workspace = string.IsNullOrWhiteSpace(connection) ? resolution.WorkspaceId : connection.Trim();
        if (string.IsNullOrWhiteSpace(workspace))
        {
            var named = resolution.Workspace;
            if (string.IsNullOrWhiteSpace(named))
                throw new InvalidOperationException($"source '{name}' has no workspace. Set its connection, or scope.workspaceId (or scope.workspace, a name to look up) in the environment file");
            var why = resolution.Problems.FirstOrDefault(p => p.Contains("Log Analytics workspace")) ??
                      (resolution.InventoryRead ? "the inventory has no workspace by that name" : "the inventory has not been read yet, so the name could not be looked up");
            throw new InvalidOperationException($"the workspace '{named}' is a name and has no workspace id yet: {why}. Log Analytics is queried by workspace id (a GUID) or by resource id (starting with /subscriptions)");
        }
        if (!ScopeResolver.IsWorkspaceId(workspace))
            throw new InvalidOperationException($"the workspace '{workspace}' is a name; Log Analytics is queried by workspace id (a GUID) or by resource id (starting with /subscriptions). Give the id under scope.workspaceId, or the name under scope.workspace to have it looked up");
        return workspace;
    }

    /// <summary>
    /// A reading for every asked system: its rows added up (two systems can share a telemetry name, and a name can come back in several rows), the rate over
    /// the window, the share of calls that were errors and the latency of the rows weighted by their calls. No row means no calls in the window.
    /// </summary>
    public static IReadOnlyDictionary<string, NodeReading> Readings(IEnumerable<SystemScope> asked, IReadOnlyList<SpanRow> rows, TimeSpan window, DateTimeOffset at)
    {
        var byRole = rows.GroupBy(r => r.Role, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.OrdinalIgnoreCase);
        var readings = new Dictionary<string, NodeReading>();
        foreach (var system in asked)
        {
            var mine = byRole.GetValueOrDefault(system.TelemetryRole!) ?? [];
            var calls = mine.Sum(r => r.Calls);
            var errors = Math.Min(mine.Sum(r => r.Errors), calls);
            var latency = calls > 0 ? mine.Where(r => r.LatencyMs is not null).Sum(r => r.LatencyMs!.Value * r.Calls) / calls : 0;
            readings[system.SystemId] = new NodeReading(at, true, 0, 0, 0, calls / window.TotalSeconds, calls > 0 ? errors / calls : 0, latency, Calls: calls);
        }
        return readings;
    }
}

public sealed class LogAnalyticsSourceFactory(HttpClient? http = null, TimeProvider? time = null) : IMetricSourceFactory
{
    public string Kind => "loganalytics";

    public IMetricSource Create(SourceContext context)
    {
        var connection = context.Source.Connection ?? "";
        string? recording = null;
        if (connection.StartsWith(ResourceGraphSourceFactory.RecordingPrefix, StringComparison.OrdinalIgnoreCase))
        {
            var file = connection[ResourceGraphSourceFactory.RecordingPrefix.Length..].Trim();
            recording = Path.IsPathRooted(file) || context.RegistryFolder is null ? file : Path.Combine(context.RegistryFolder, file);
            if (!File.Exists(recording)) throw new InvalidOperationException($"the recording {file} does not exist");
        }
        else if (context.Source.Query is null)
            throw new InvalidOperationException("it has no query. Write the query that returns one row per telemetry name with the columns " + string.Join(", ", LogAnalyticsReader.Columns));
        return new LogAnalyticsSource(context.Source.Name, context.EnvironmentId, context.Source, new LogAnalyticsReader(http ?? Shared, context.Credential),
            context.Scope ?? new ScopeStore(), context.Rules ?? ScopeRules.None, recording, time ?? TimeProvider.System);
    }

    private static readonly HttpClient Shared = new();
}
