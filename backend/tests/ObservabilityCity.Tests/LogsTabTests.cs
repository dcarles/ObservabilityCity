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
/// newest first, the 5xx and exceptions headers link to the telemetry store's own search (one link for each store), and a worker keeps only the logs and exceptions. Every convention is a template in the environment
/// file, so two towns that read opposite shapes run through the same code.
/// </summary>
public class LogsTabTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-b");
    private static readonly DateTimeOffset Now = new(2026, 11, 1, 12, 0, 0, TimeSpan.Zero);

    // Town A: the usual tables, a four hour window by default, and a link in two headers to the search of each telemetry store the assets rule finds.
    private const string LogsA = """

        logs:
          source: telemetry
          query: |
            union AppRequests, AppTraces, AppExceptions
            | where TimeGenerated between (datetime({from}) .. datetime({to})) and AppRoleName in ({roles})
            | where duration > {slaMs} or kind == "{kind}" or "{window}" == "4h"
          links:
            - { name: 5xx, section: failed, resources: stores, url: "https://search.a.example.test/{environment}/{resourceIdTwice}?name={resourceName}&service={role}&code=500&from={from}&to={to}&ms={windowMs}" }
            - { name: Exceptions, section: exceptions, resources: stores, url: "https://search.a.example.test/{environment}/{resourceId}/exceptions?service={role}" }
        """;

    private const string StoresRule = "  assets:\n    - { name: stores, island: hub, group: Monitoring, label: Store, shape: observatory, types: [microsoft.insights/components], pattern: '^appi-', subscription: { nameLike: 'hub-*' } }\n";

    // Town B: another table, a window in minutes, and no link at all.
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
            _copy.Replace("environments/prod.yaml", "\nscope:\n", "\nscope:\n" + StoresRule);
            _copy.Write("environments/prod.yaml", _copy.Read("environments/prod.yaml") + logsBlock);
            View = new EnvironmentRegistry(new RegistryHolder(RegistryLoader.Load(_copy.Path)), "prod");
            Source = new Stub(sourceName, answer ?? (_ => []));
            Logs = new QueryLogSource([Source], View, Scope, new FakeTimeProvider(Now));
        }

        public RegistryNode Node(NodeKind kind) => View.Current.AllNodes.First(n => n.Kind == kind);
        public string Role(RegistryNode node) => Scope.Resolve(View.Current).System(node.Id)!.TelemetryRole!;
        public void Dispose() => _copy.Dispose();
    }

    private static LogRow Row(string section, int minutesAgo, string text, int count = 1, double? ms = null, string? result = null, LogLevel? level = null) =>
        new(section, Now.AddMinutes(-minutesAgo), text, count, level, ms, result);

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
        Assert.All(logs.Sections, s => Assert.Null(s.Links));
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
            Row("failed", 50, "GET /api/orders", count: 3, result: "500"),
            Row("failed", 10, "GET /api/orders", count: 4, ms: 812, result: "500"),
            Row("failed", 5, "GET /api/orders", count: 2, result: "503"),
            Row("failed", 20, "POST /api/orders", result: "500"),
        ]);

        var failed = (await rig.Logs.RecentAsync(rig.Node(NodeKind.Api), default)).Sections[0].Groups;

        Assert.Equal(["GET /api/orders", "GET /api/orders", "POST /api/orders"], failed.Select(g => g.Text));
        Assert.Equal(["503", "500", "500"], failed.Select(g => g.Result));
        Assert.Equal([2, 7, 1], failed.Select(g => g.Count));
        var merged = failed[1];
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

    // ---- links in the section headers ----

    private static ResolvedAsset Store(string name) =>
        new($"hub.{name}", "hub", name, "Store", "observatory", "microsoft.insights/components", null, "northeurope", $"/subscriptions/0000/resourceGroups/rg one/providers/microsoft.insights/components/{name}", "stores", "0000", "Monitoring");

    private static EnvironmentRegistry Env(string town, string logs, out RegistryCopy copy)
    {
        copy = new RegistryCopy(town);
        copy.Replace("environments/prod.yaml", "\nscope:\n", "\nscope:\n" + StoresRule);
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + logs);
        return new EnvironmentRegistry(new RegistryHolder(RegistryLoader.Load(copy.Path)), "prod");
    }

    private static IReadOnlyList<LogSection> Headers(string town, string logs, params ResolvedAsset[] assets)
    {
        var view = Env(town, logs, out var copy);
        using (copy)
        {
            var environment = view.Current.ActiveEnvironment!;
            return QueryLogSource.Sections([], LogSections.All, environment.Logs!, environment, "Orders Api", assets, TimeSpan.FromHours(4), Now.AddHours(-4), Now);
        }
    }

    [Fact]
    public void The_5xx_and_exceptions_headers_have_one_link_for_each_store_the_rule_finds_and_the_other_sections_have_none()
    {
        var sections = Headers(TownA, LogsA, Store("appi-b"), Store("appi-a"));

        Assert.Null(sections.Single(s => s.Id == "slow").Links);
        Assert.Null(sections.Single(s => s.Id == "logs").Links);
        // the store's name is added to the words so the two can be told apart, and they come in name order
        Assert.Equal(["5xx (appi-a)", "5xx (appi-b)"], sections.Single(s => s.Id == "failed").Links!.Select(l => l.Name));
        Assert.Equal(["Exceptions (appi-a)", "Exceptions (appi-b)"], sections.Single(s => s.Id == "exceptions").Links!.Select(l => l.Name));
    }

    [Fact]
    public void A_link_is_filled_in_with_the_store_the_service_and_the_window_every_value_encoded()
    {
        var failed = Headers(TownA, LogsA, Store("appi-a")).Single(s => s.Id == "failed").Links!;

        var link = Assert.Single(failed);
        Assert.Equal("5xx", link.Name); // one store: the words stay as written
        Assert.Equal(
            "https://search.a.example.test/prod/%252Fsubscriptions%252F0000%252FresourceGroups%252Frg%2520one%252Fproviders%252Fmicrosoft.insights%252Fcomponents%252Fappi-a" +
            "?name=appi-a&service=Orders%20Api&code=500&from=2026-11-01T08%3A00%3A00Z&to=2026-11-01T12%3A00%3A00Z&ms=14400000", link.Url);
        // the other template keeps the slashes of the id
        Assert.Equal("https://search.a.example.test/prod//subscriptions/0000/resourceGroups/rg%20one/providers/microsoft.insights/components/appi-a/exceptions?service=Orders%20Api",
            Headers(TownA, LogsA, Store("appi-a")).Single(s => s.Id == "exceptions").Links!.Single().Url);
    }

    [Fact]
    public void A_rule_that_finds_nothing_or_names_another_rule_makes_no_link()
    {
        Assert.All(Headers(TownA, LogsA), s => Assert.Null(s.Links));
        Assert.All(Headers(TownA, LogsA, Store("appi-a") with { Rule = "other" }), s => Assert.Null(s.Links));
    }

    [Fact]
    public async Task Opening_the_tab_puts_the_links_in_the_answer_and_a_town_with_no_links_has_none()
    {
        using var rig = new Rig(TownA, LogsA, _ => []);
        rig.Scope.Update(new Inventory([new InventorySubscription("0000", "hub-monitor", new Dictionary<string, string>())], [new InventoryResource("/subscriptions/0000/resourceGroups/rg/providers/microsoft.insights/components/appi-z", "appi-z", "microsoft.insights/components", "0000", "northeurope", new Dictionary<string, string>(), null)]), Now);

        var logs = await rig.Logs.RecentAsync(rig.Node(NodeKind.Api), default);

        Assert.Contains("appi-z", Assert.Single(logs.Sections[0].Links!).Url);
        Assert.Contains("appi-z", Assert.Single(logs.Sections[3].Links!).Url);
        Assert.Null(logs.Sections[1].Links);
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
        copy.Replace("environments/prod.yaml", "\nscope:\n", "\nscope:\n" + StoresRule);
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
        Assert.Contains("logs.window 'soon'", LoadProblem(LogsA.Replace("  links:", "  window: soon\n  links:")));
    }

    [Fact]
    public void A_header_link_must_write_out_its_scheme_name_a_real_section_and_assets_rule_and_use_only_its_own_variables()
    {
        Assert.Contains("url must start with https://", LoadProblem(LogsA.Replace("\"https://search.a.example.test/{environment}/{resourceIdTwice}", "\"{environment}.example.test/{resourceIdTwice}")));
        Assert.Contains("{operationId}", LoadProblem(LogsA.Replace("service={role}&code", "service={operationId}&code")));
        Assert.Contains("section 'errors' is not one of failed, slow, logs, exceptions", LoadProblem(LogsA.Replace("section: failed", "section: errors")));
        Assert.Contains("resources 'nope' is not a scope.assets rule of this file", LoadProblem(LogsA.Replace("resources: stores, url: \"https://search.a.example.test/{environment}/{resourceIdTwice}", "resources: nope, url: \"https://search.a.example.test/{environment}/{resourceIdTwice}")));
        Assert.Contains("listed twice", LoadProblem(LogsA + "\n    - { name: 5xx, section: failed, resources: stores, url: \"https://other.example.test/{resourceName}\" }"));
    }

    [Fact]
    public void An_environment_may_have_no_header_links_and_the_default_window_is_four_hours()
    {
        using var rig = new Rig(TownB, LogsB.Replace("  window: 30m\n", ""));

        var config = rig.View.Current.ActiveEnvironment!.Logs!;

        Assert.Equal(TimeSpan.FromHours(4), config.Window);
        Assert.Empty(config.Links);
    }

    // ---- the Azure side ----

    private const string Columns = """{"name":"section","type":"string"},{"name":"at","type":"datetime"},{"name":"text","type":"string"},{"name":"count","type":"long"},{"name":"level","type":"dynamic"},{"name":"durationMs","type":"real"},{"name":"result","type":"string"}""";

    private static string Answer(params string[] rows) => """{"tables":[{"name":"PrimaryResult","columns":[""" + Columns + """],"rows":[""" + string.Join(",", rows) + "]}]}";

    [Fact]
    public void The_answer_is_read_by_column_name_with_the_optional_columns_left_out_or_empty()
    {
        var rows = LogAnalyticsReader.ParseLogs(Answer(
            """["failed","2026-11-01T11:58:00Z","GET /a",4,null,812.5,"500"]""",
            """["logs","2026-11-01T11:57:00Z","Cache is cold",1,"Warning",null,null]""",
            """["logs","2026-11-01T11:56:00Z","Disk full",2,3,null,null]"""));

        Assert.Equal(3, rows.Count);
        Assert.Equal(new LogRow("failed", new DateTimeOffset(2026, 11, 1, 11, 58, 0, TimeSpan.Zero), "GET /a", 4, null, 812.5, "500"), rows[0]);
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
        var http = ObservabilityCity.AdapterKit.CannedHttp.Always(Answer("""["logs","2026-11-01T11:57:00Z","Cache is cold",1,"warn",null,null]"""));
        var reader = new LogAnalyticsReader(new HttpClient(http), null);

        var rows = await reader.QueryLogsAsync("00000000-0000-0000-0000-00000000c0de", "Q", Now.AddHours(-4), Now, default);

        Assert.Single(rows);
        var sent = Assert.Single(http.Sent);
        Assert.EndsWith("/workspaces/00000000-0000-0000-0000-00000000c0de/query", sent.Uri!.AbsolutePath);
        Assert.Equal("2026-11-01T08:00:00Z/2026-11-01T12:00:00Z", sent.Json.GetProperty("timespan").GetString());
        Assert.Equal("Q", sent.Json.GetProperty("query").GetString());
    }
}
