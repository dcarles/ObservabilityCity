using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Logs;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 3 slice 4: the Logs tab of a live town. Opening it sends one query for the system's telemetry name over the environment's window and nothing
/// runs otherwise. The answer has four separate sections (5xx requests, slow requests, warnings and errors, exceptions), repeats are grouped with a count,
/// newest first, each entry can link to its trace, and a worker keeps only the logs and exceptions. Every convention is a template in the environment
/// file, so two towns that read opposite shapes run through the same code.
/// </summary>
public class LogsTabTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-b");
    private static readonly DateTimeOffset Now = new(2026, 11, 1, 12, 0, 0, TimeSpan.Zero);

    // Town A: the usual tables, a four hour window by default and an address that opens a trace by its operation id.
    private const string LogsA = """

        logs:
          source: telemetry
          query: |
            union AppRequests, AppTraces, AppExceptions
            | where TimeGenerated between (datetime({from}) .. datetime({to})) and AppRoleName in ({roles})
            | where duration > {slaMs} or kind == "{kind}" or "{window}" == "4h"
          traceLinks:
            - { name: Trace, url: "https://tracing.a.example.test/{environment}/operation/{operationId}?role={role}&at={time}" }
        """;

    // Town B: another table, a window in minutes, no link at all, and a second address that only needs the operation.
    private const string LogsB = """

        logs:
          source: telemetry
          window: 30m
          query: >-
            Events_CL | where TimeGenerated > ago({windowSeconds}s) and service_s in ({roles})
            | summarize count = count() by section = kind_s, text = message_s, at = max(TimeGenerated)
        """;

    private sealed class Stub(string name, Func<string, IReadOnlyList<LogRow>> answer) : IMetricSource, ILogRowSource
    {
        public List<(string Query, DateTimeOffset From, DateTimeOffset To)> Asked { get; } = [];
        public string Name => name;
        public TimeSpan PollInterval => TimeSpan.FromSeconds(30);
        public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct) => Task.FromResult<IReadOnlyDictionary<string, NodeReading>>(new Dictionary<string, NodeReading>());
        public bool CanReadLogs { get; set; } = true;
        public Task<IReadOnlyList<LogRow>> ReadLogsAsync(TownRegistry registry, string query, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
        {
            Asked.Add((query, from, to));
            return Task.FromResult(answer(query));
        }
    }

    private sealed class Rig : IDisposable
    {
        private readonly RegistryCopy _copy;
        public Stub Source { get; }
        public EnvironmentRegistry View { get; }
        public ScopeStore Scope { get; } = new();
        public QueryLogSource Logs { get; }

        public Rig(string town, string logsBlock, Func<string, IReadOnlyList<LogRow>>? answer = null, string sourceName = "telemetry")
        {
            _copy = new RegistryCopy(town);
            _copy.Write("environments/prod.yaml", _copy.Read("environments/prod.yaml") + logsBlock);
            View = new EnvironmentRegistry(new RegistryHolder(RegistryLoader.Load(_copy.Path)), "prod");
            Source = new Stub(sourceName, answer ?? (_ => []));
            Logs = new QueryLogSource([Source], View, Scope, new FakeTimeProvider(Now));
        }

        public RegistryNode Node(NodeKind kind) => View.Current.AllNodes.First(n => n.Kind == kind);
        public string Role(RegistryNode node) => Scope.Resolve(View.Current).System(node.Id)!.TelemetryRole!;
        public void Dispose() => _copy.Dispose();
    }

    private static LogRow Row(string section, int minutesAgo, string text, int count = 1, string? op = null, double? ms = null, string? result = null, LogLevel? level = null) =>
        new(section, Now.AddMinutes(-minutesAgo), text, count, level, op, ms, result);

    // ---- when it runs ----

    [Fact]
    public void Nothing_is_asked_until_the_tab_is_opened()
    {
        using var rig = new Rig(TownA, LogsA);

        Assert.Empty(rig.Source.Asked);
    }

    [Fact]
    public async Task Opening_the_tab_sends_one_query_for_that_systems_telemetry_name_over_four_hours()
    {
        using var rig = new Rig(TownA, LogsA);
        var api = rig.Node(NodeKind.Api);

        var logs = await rig.Logs.RecentAsync(api, default);

        var asked = Assert.Single(rig.Source.Asked);
        Assert.Contains($"\"{rig.Role(api)}\"", asked.Query);
        Assert.Contains($"> {api.SlaP99Ms}", asked.Query);
        Assert.Contains("== \"api\"", asked.Query);
        Assert.Contains("\"4h\" == \"4h\"", asked.Query);
        Assert.Contains("datetime(2026-11-01T08:00:00Z) .. datetime(2026-11-01T12:00:00Z)", asked.Query);
        Assert.Equal(TimeSpan.FromHours(4), asked.To - asked.From);
        Assert.True(logs.Configured);
        Assert.Equal("4h", logs.Window);
        Assert.Equal(api.SlaP99Ms, logs.SlowOverMs);
    }

    [Fact]
    public async Task A_second_town_with_opposite_conventions_runs_through_the_same_code()
    {
        using var rig = new Rig(TownB, LogsB, _ => [Row("logs", 5, "Disk is nearly full", level: LogLevel.Warn)]);
        var api = rig.Node(NodeKind.Api);

        var logs = await rig.Logs.RecentAsync(api, default);

        var asked = Assert.Single(rig.Source.Asked);
        Assert.Contains("Events_CL", asked.Query);
        Assert.Contains("ago(1800s)", asked.Query);
        Assert.Contains($"\"{rig.Role(api)}\"", asked.Query);
        Assert.Equal("30m", logs.Window);
        Assert.Equal(TimeSpan.FromMinutes(30), asked.To - asked.From);
        Assert.Equal("Disk is nearly full", logs.Sections.Single(s => s.Id == "logs").Groups.Single().Text);
        Assert.All(logs.Sections, s => Assert.All(s.Groups, g => Assert.Null(g.Links)));
    }

    // ---- the four sections ----

    [Fact]
    public async Task An_api_has_four_separate_sections_and_a_flood_in_one_never_hides_another()
    {
        var flood = Enumerable.Range(0, 300).Select(i => Row("failed", i % 200, $"GET /api/orders/{i}", result: "500")).ToList();
        using var rig = new Rig(TownA, LogsA, _ => [.. flood, Row("exceptions", 90, "TimeoutException: the call timed out"), Row("logs", 80, "Cache is cold", level: LogLevel.Warn)]);

        var logs = await rig.Logs.RecentAsync(rig.Node(NodeKind.Api), default);

        Assert.Equal(["failed", "slow", "logs", "exceptions"], logs.Sections.Select(s => s.Id));
        Assert.Equal(300, logs.Sections[0].Groups.Count); // no row cap: every distinct entry is kept
        Assert.Empty(logs.Sections[1].Groups);
        Assert.Single(logs.Sections[2].Groups);
        Assert.Single(logs.Sections[3].Groups);
    }

    [Fact]
    public async Task A_worker_keeps_only_warnings_errors_and_exceptions_even_when_the_query_returns_requests()
    {
        using var rig = new Rig(TownA, LogsA, _ =>
        [
            Row("failed", 1, "POST /x", result: "500"), Row("slow", 1, "POST /y", ms: 9000),
            Row("logs", 2, "Handling a message failed", level: LogLevel.Error), Row("exceptions", 2, "InvalidOperationException: bad shape"),
        ]);

        var logs = await rig.Logs.RecentAsync(rig.Node(NodeKind.Worker), default);

        Assert.Equal(["logs", "exceptions"], logs.Sections.Select(s => s.Id));
        Assert.All(logs.Sections, s => Assert.Single(s.Groups));
    }

    [Fact]
    public async Task Repeats_are_grouped_with_a_count_and_the_newest_entry_comes_first()
    {
        using var rig = new Rig(TownA, LogsA, _ =>
        [
            Row("failed", 50, "GET /api/orders", count: 3, op: "old", result: "500"),
            Row("failed", 10, "GET /api/orders", count: 4, op: "new", ms: 812, result: "500"),
            Row("failed", 5, "GET /api/orders", count: 2, op: "other-status", result: "503"),
            Row("failed", 20, "POST /api/orders", op: "post", result: "500"),
        ]);

        var failed = (await rig.Logs.RecentAsync(rig.Node(NodeKind.Api), default)).Sections[0].Groups;

        Assert.Equal(["GET /api/orders", "GET /api/orders", "POST /api/orders"], failed.Select(g => g.Text));
        Assert.Equal(["503", "500", "500"], failed.Select(g => g.Result));
        Assert.Equal([2, 7, 1], failed.Select(g => g.Count));
        var merged = failed[1];
        Assert.Equal("new", merged.OperationId);
        Assert.Equal(812, merged.DurationMs);
        Assert.Equal(Now.AddMinutes(-10), merged.At);
        Assert.Equal(failed.OrderByDescending(g => g.At).Select(g => g.At), failed.Select(g => g.At));
    }

    [Fact]
    public async Task A_row_of_a_section_nobody_shows_is_left_out()
    {
        using var rig = new Rig(TownA, LogsA, _ => [Row("audit", 1, "something else"), Row("logs", 1, "kept", level: LogLevel.Warn)]);

        var logs = await rig.Logs.RecentAsync(rig.Node(NodeKind.Api), default);

        Assert.Equal(1, logs.Sections.Sum(s => s.Groups.Count));
    }

    // ---- links to the full trace ----

    [Fact]
    public async Task Each_entry_links_to_its_trace_from_the_environments_templates_with_every_value_encoded()
    {
        using var rig = new Rig(TownA, LogsA, _ => [Row("failed", 3, "GET /a", op: "op 1/2&x", result: "500"), Row("logs", 3, "no operation", level: LogLevel.Warn)]);
        var api = rig.Node(NodeKind.Api);

        var logs = await rig.Logs.RecentAsync(api, default);

        var link = Assert.Single(logs.Sections[0].Groups.Single().Links!);
        Assert.Equal("Trace", link.Name);
        Assert.StartsWith("https://tracing.a.example.test/prod/operation/op%201%2F2%26x?role=", link.Url);
        Assert.Contains(Uri.EscapeDataString(rig.Role(api)), link.Url);
        Assert.EndsWith("&at=2026-11-01T11%3A57%3A00Z", link.Url);
        Assert.Null(logs.Sections[2].Groups.Single().Links); // an entry without an operation has no trace to open
    }

    // ---- not set up, not running, nothing to read ----

    [Fact]
    public async Task An_environment_with_no_logs_block_says_so_and_asks_nothing()
    {
        using var rig = new Rig(TownA, "");

        var logs = await rig.Logs.RecentAsync(rig.Node(NodeKind.Api), default);

        Assert.False(logs.Configured);
        Assert.Empty(logs.Sections);
        Assert.Empty(rig.Source.Asked);
    }

    [Fact]
    public async Task A_system_with_no_telemetry_name_has_no_sections_and_asks_nothing()
    {
        using var rig = new Rig(TownA, LogsA);

        var logs = await rig.Logs.RecentAsync(rig.Node(NodeKind.Database), default);

        Assert.True(logs.Configured);
        Assert.Empty(logs.Sections);
        Assert.Empty(rig.Source.Asked);
    }

    [Fact]
    public async Task A_source_that_is_not_running_is_a_failure_with_a_reason_not_an_empty_tab()
    {
        using var rig = new Rig(TownA, LogsA, sourceName: "another");

        var e = await Assert.ThrowsAsync<InvalidOperationException>(() => rig.Logs.RecentAsync(rig.Node(NodeKind.Api), default));

        Assert.Contains("'telemetry'", e.Message);
    }

    [Fact]
    public async Task A_source_that_replays_a_recording_without_logs_is_a_failure_with_a_reason()
    {
        using var rig = new Rig(TownA, LogsA);
        rig.Source.CanReadLogs = false;

        await Assert.ThrowsAsync<InvalidOperationException>(() => rig.Logs.RecentAsync(rig.Node(NodeKind.Api), default));
    }

    // ---- the files ----

    private static string LoadProblem(string logsBlock)
    {
        using var copy = new RegistryCopy(TownA);
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + logsBlock);
        return Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;
    }

    [Fact]
    public void A_variable_the_query_does_not_have_is_an_error_that_names_it()
    {
        var message = LoadProblem(LogsA.Replace("{slaMs}", "{sla}"));

        Assert.Contains("environments/prod.yaml: logs.query", message);
        Assert.Contains("{sla}", message);
    }

    [Fact]
    public void A_source_that_is_not_in_the_file_or_not_a_log_analytics_source_is_an_error()
    {
        Assert.Contains("logs.source 'nope' is not a source of this file", LoadProblem(LogsA.Replace("source: telemetry", "source: nope")));
        Assert.Contains("the logs are read from a loganalytics source", LoadProblem(LogsA.Replace("source: telemetry", "source: inventory")));
    }

    [Fact]
    public void An_empty_query_and_a_window_without_a_unit_are_errors()
    {
        Assert.Contains("logs.query is empty", LoadProblem("\nlogs:\n  source: telemetry\n  query: ''\n"));
        Assert.Contains("logs.window 'soon'", LoadProblem(LogsA.Replace("traceLinks:", "window: soon\n  traceLinks:")));
    }

    [Fact]
    public void A_trace_link_must_write_out_its_scheme_and_may_only_use_its_own_variables()
    {
        Assert.Contains("url must start with https://", LoadProblem(LogsA.Replace("\"https://tracing.a.example.test", "\"{environment}.example.test")));
        Assert.Contains("{resourceId}", LoadProblem(LogsA.Replace("{operationId}", "{resourceId}")));
        Assert.Contains("listed twice", LoadProblem(LogsA + "\n    - { name: Trace, url: \"https://other.example.test/{operationId}\" }"));
    }

    [Fact]
    public void An_environment_may_have_no_trace_links_and_the_default_window_is_four_hours()
    {
        using var rig = new Rig(TownB, LogsB.Replace("  window: 30m\n", ""));

        var config = rig.View.Current.ActiveEnvironment!.Logs!;

        Assert.Equal(TimeSpan.FromHours(4), config.Window);
        Assert.Empty(config.TraceLinks);
    }

    // ---- the Azure side ----

    private const string Columns = """{"name":"section","type":"string"},{"name":"at","type":"datetime"},{"name":"text","type":"string"},{"name":"count","type":"long"},{"name":"level","type":"dynamic"},{"name":"operationId","type":"string"},{"name":"durationMs","type":"real"},{"name":"result","type":"string"}""";

    private static string Answer(params string[] rows) => """{"tables":[{"name":"PrimaryResult","columns":[""" + Columns + """],"rows":[""" + string.Join(",", rows) + "]}]}";

    [Fact]
    public void The_answer_is_read_by_column_name_with_the_optional_columns_left_out_or_empty()
    {
        var rows = LogAnalyticsReader.ParseLogs(Answer(
            """["failed","2026-11-01T11:58:00Z","GET /a",4,null,"op1",812.5,"500"]""",
            """["logs","2026-11-01T11:57:00Z","Cache is cold",1,"Warning",null,null,null]""",
            """["logs","2026-11-01T11:56:00Z","Disk full",2,3,null,null,null]"""));

        Assert.Equal(3, rows.Count);
        Assert.Equal(new LogRow("failed", new DateTimeOffset(2026, 11, 1, 11, 58, 0, TimeSpan.Zero), "GET /a", 4, null, "op1", 812.5, "500"), rows[0]);
        Assert.Equal(LogLevel.Warn, rows[1].Level);
        Assert.Equal(LogLevel.Error, rows[2].Level); // a number: 3 and above is an error
        Assert.Equal(2, rows[2].Count);
    }

    [Fact]
    public void A_query_that_returns_only_section_at_and_text_is_enough_and_a_row_missing_one_is_skipped()
    {
        var json = """{"tables":[{"columns":[{"name":"Section"},{"name":"AT"},{"name":"Text"}],"rows":[["exceptions","2026-11-01T11:58:00Z","Boom"],["exceptions",null,"no time"],[null,"2026-11-01T11:58:00Z","no section"],["exceptions","2026-11-01T11:58:00Z",""]]}]}""";

        var rows = LogAnalyticsReader.ParseLogs(json);

        var row = Assert.Single(rows);
        Assert.Equal(("exceptions", "Boom", 1), (row.Section, row.Text, row.Count));
    }

    [Fact]
    public void A_query_without_the_required_columns_is_a_mistake_worth_naming()
    {
        var e = Assert.Throws<InvalidOperationException>(() => LogAnalyticsReader.ParseLogs("""{"tables":[{"columns":[{"name":"role"},{"name":"calls"}],"rows":[]}]}"""));

        Assert.Contains("section, at and text", e.Message);
        Assert.Contains("role, calls", e.Message);
    }

    [Fact]
    public async Task The_adapter_sends_the_query_over_the_window_to_the_workspace_and_reads_the_answer()
    {
        var http = ObservabilityCity.AdapterKit.CannedHttp.Always(Answer("""["logs","2026-11-01T11:57:00Z","Cache is cold",1,"warn",null,null,null]"""));
        var reader = new LogAnalyticsReader(new HttpClient(http), null);

        var rows = await reader.QueryLogsAsync("00000000-0000-0000-0000-00000000c0de", "Q", Now.AddHours(-4), Now, default);

        Assert.Single(rows);
        var sent = Assert.Single(http.Sent);
        Assert.EndsWith("/workspaces/00000000-0000-0000-0000-00000000c0de/query", sent.Uri!.AbsolutePath);
        Assert.Equal("2026-11-01T08:00:00Z/2026-11-01T12:00:00Z", sent.Json.GetProperty("timespan").GetString());
        Assert.Equal("Q", sent.Json.GetProperty("query").GetString());
    }
}
