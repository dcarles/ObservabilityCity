using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 2, slice 4: request rate, error share and latency come from span metrics in a Log Analytics workspace, and a system with too few calls to
/// judge is quiet. The program knows no table, metric name or property: the environment's query template says them. Two towns with different queries
/// (a metrics table and an errors-by-status filter; a custom table with other column names and a window in seconds) read the same recorded answer
/// shape and show the same town, which is the proof.
/// </summary>
public class SpanMetricsTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-b");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
    private const string Workspace = "00000000-0000-0000-0000-00000000c0de";

    private static TownRegistry Prod(string folder) => RegistryLoader.Load(folder).ForEnvironment("prod");
    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).First(n => n.Id == id);

    /// <summary>Starts every source of the town's environment the way the host does, polls each once and builds the snapshot.</summary>
    private static async Task<Snapshot> TownSnapshot(string folder, FakeTimeProvider time)
    {
        var registry = Prod(folder);
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, folder);
        Assert.Empty(set.Problems);
        var state = new LatestState();
        foreach (var source in set.Sources) state.Update(source.Name, await source.PollAsync(registry, CancellationToken.None));
        return new SnapshotBuilder(registry, state, time) { Environment = "prod" }.Build();
    }

    // ---- the town, whatever the query ----

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task Two_towns_with_different_queries_show_the_same_health(string town)
    {
        var snapshot = await TownSnapshot(town == "a" ? TownA : TownB, new FakeTimeProvider(T0));

        var api = Node(snapshot, "aa.orders-api"); // 3000 calls in 5 minutes, 60 of them errors
        Assert.Equal(10, api.RequestsPerSecond);
        Assert.Equal(0.02, api.ErrorRate, 6);
        Assert.Equal(120, api.P99Ms);
        Assert.Equal(HealthState.Degraded, api.State); // 2% is past the 1% amber line
        Assert.False(api.Quiet);
        Assert.Equal(3, api.InstancesTotal); // the instances still come from the inventory

        var gateway = Node(snapshot, "hub.apim");
        Assert.Equal(20, gateway.RequestsPerSecond);
        Assert.Equal(HealthState.Healthy, gateway.State);
        Assert.Equal(HealthState.Degraded, Node(snapshot, "aa.orders-db").State); // a database has no span metrics (not quiet), and one tenant's account runs at 95% of what is provisioned

        var worker = Node(snapshot, "aa.orders-worker");
        Assert.Equal(HealthState.Healthy, worker.State);
        Assert.Equal(2, worker.RequestsPerSecond);
        Assert.Equal(400, worker.P99Ms);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task A_system_below_its_minimum_calls_is_quiet_and_its_few_errors_and_slow_calls_are_not_judged(string town)
    {
        var snapshot = await TownSnapshot(town == "a" ? TownA : TownB, new FakeTimeProvider(T0));

        var ledger = Node(snapshot, "bb.ledger-api"); // 4 calls, all of them errors, 5 seconds each: past every threshold if it counted
        Assert.True(ledger.Quiet);
        Assert.Equal(HealthState.Healthy, ledger.State);
        Assert.Equal(0, ledger.ErrorRate);
        Assert.Equal(0, ledger.P99Ms);
        Assert.Equal(4.0 / 300, ledger.RequestsPerSecond, 6);
        Assert.Equal(5, ledger.InstancesTotal);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task A_system_the_answer_has_no_row_for_made_no_calls_and_is_quiet_not_unknown(string town)
    {
        var snapshot = await TownSnapshot(town == "a" ? TownA : TownB, new FakeTimeProvider(T0));

        var worker = Node(snapshot, "bb.ledger-worker");
        Assert.True(worker.Quiet);
        Assert.Equal(HealthState.Healthy, worker.State);
        Assert.Equal(0, worker.RequestsPerSecond);
    }

    [Fact]
    public async Task A_system_with_no_telemetry_name_gets_no_reading_and_a_row_nobody_owns_is_ignored()
    {
        var registry = Prod(TownA);
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, TownA);
        var readings = await set.Sources.Single(s => s.Name == "telemetry").PollAsync(registry, CancellationToken.None);

        Assert.Equal(["aa.orders-api", "aa.orders-worker", "bb.ledger-api", "bb.ledger-worker", "hub.apim"], readings.Keys.Order()); // no database, no broker
        AdapterContract.AssertReadings(readings, registry);
        Assert.DoesNotContain("SomeoneElse", readings.Keys);
    }

    // ---- the minimum ----

    [Fact]
    public void The_minimum_comes_down_the_cascade_and_a_system_can_set_its_own()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("pillars/bb.yaml", "name: Ledger API, role: api,", "name: Ledger API, role: api, minCalls: 3,");

        var registry = Prod(copy.Path);

        Assert.Equal(3, registry.AllNodes.First(n => n.Id == "bb.ledger-api").MinCalls);
        Assert.Equal(20, registry.AllNodes.First(n => n.Id == "aa.orders-api").MinCalls);
        Assert.Equal(50, registry.AllNodes.First(n => n.Id == "aa.orders-worker").MinCalls);
        Assert.Equal(SettingLayer.System, registry.AllNodes.First(n => n.Id == "bb.ledger-api").Origins["minCalls"].Layer);
        Assert.Equal(SettingLayer.App, registry.AllNodes.First(n => n.Id == "aa.orders-api").Origins["minCalls"].Layer);
    }

    [Fact]
    public async Task One_call_more_than_the_minimum_is_judged_and_one_fewer_is_not()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("pillars/bb.yaml", "name: Ledger API, role: api,", "name: Ledger API, role: api, minCalls: 4,");

        var judged = Node(await TownSnapshot(copy.Path, new FakeTimeProvider(T0)), "bb.ledger-api");

        Assert.False(judged.Quiet);
        Assert.Equal(1, judged.ErrorRate);
        Assert.Equal(5000, judged.P99Ms);
        Assert.Equal(HealthState.Degraded, judged.State);

        copy.Replace("pillars/bb.yaml", "minCalls: 4,", "minCalls: 5,");
        Assert.True(Node(await TownSnapshot(copy.Path, new FakeTimeProvider(T0)), "bb.ledger-api").Quiet);
    }

    [Fact]
    public async Task Without_a_minimum_a_system_is_quiet_only_when_it_made_no_calls()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Write("defaults.yaml", "api: { slaP99Ms: 1000, errors: { amber: 0.01, red: 0.05 } }\nworker: { slaP99Ms: 30000, errors: { amber: 0.01, red: 0.05 } }\ndb: { slaP99Ms: 100, errors: { amber: 0.005, red: 0.02 } }\n");

        var snapshot = await TownSnapshot(copy.Path, new FakeTimeProvider(T0));

        Assert.False(Node(snapshot, "bb.ledger-api").Quiet);
        Assert.Equal(HealthState.Degraded, Node(snapshot, "bb.ledger-api").State);
        Assert.True(Node(snapshot, "bb.ledger-worker").Quiet);
        Assert.Equal(1, Prod(copy.Path).AllNodes.First(n => n.Id == "bb.ledger-api").MinCalls);
    }

    [Fact]
    public void A_minimum_below_one_counts_as_one()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("pillars/bb.yaml", "name: Ledger API, role: api,", "name: Ledger API, role: api, minCalls: 0,");

        Assert.Equal(1, Prod(copy.Path).AllNodes.First(n => n.Id == "bb.ledger-api").MinCalls);
    }

    [Fact]
    public void A_source_that_does_not_count_calls_never_makes_a_system_quiet()
    {
        var registry = Prod(TownA);
        var time = new FakeTimeProvider(T0);
        var state = new LatestState();
        state.Update("telemetry", new Dictionary<string, NodeReading> { ["bb.ledger-api"] = new(T0, true, 0, 0, 0, 0.01, 0.5, 4000) });
        state.Update("inventory", new Dictionary<string, NodeReading> { ["bb.ledger-api"] = new(T0, true, 5, 5, 0, 0, 0, 0) });

        var node = Node(new SnapshotBuilder(registry, state, time) { Environment = "prod" }.Build(), "bb.ledger-api");

        Assert.False(node.Quiet);
        Assert.Equal(HealthState.Degraded, node.State);
    }

    [Fact]
    public void The_call_count_goes_through_the_merge_from_the_source_that_supplies_requests()
    {
        var bySource = new Dictionary<string, NodeReading>
        {
            ["inventory"] = new(T0, true, 3, 3, 0, 0, 0, 0, Calls: 999),
            ["telemetry"] = new(T0, true, 0, 0, 0, 1, 0, 0, Calls: 12),
        };

        var merged = ReadingMerge.Merge(bySource, s => s == Signals.Instances ? "inventory" : "telemetry")!;

        Assert.Equal(12, merged.Calls);
    }

    [Fact]
    public void When_requests_have_no_source_nothing_is_quiet()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "signals: { instances: inventory, requests: telemetry, errors: telemetry, latency: telemetry, cpu: platform, memory: platform, utilisation: platform, throttled: platform }", "signals: { instances: inventory }");
        var registry = Prod(copy.Path);
        var state = new LatestState();
        state.Update("inventory", new Dictionary<string, NodeReading> { ["bb.ledger-api"] = new(T0, true, 5, 5, 0, 0, 0, 0, Calls: 1) });
        state.Update("telemetry", new Dictionary<string, NodeReading> { ["bb.ledger-api"] = new(T0, true, 0, 0, 0, 0, 0, 0, Calls: 1) });

        var node = Node(new SnapshotBuilder(registry, state, new FakeTimeProvider(T0)) { Environment = "prod" }.Build(), "bb.ledger-api");

        Assert.False(node.Quiet);
        Assert.Contains("requests", node.Absent!);
    }

    [Fact]
    public async Task The_drawer_lists_the_minimum_with_where_it_came_from()
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Registry:Path", TownA);
            b.UseSetting("Registry:WatchSeconds", "0");
            b.UseSetting("Snapshot:IntervalSeconds", "0.2");
        });
        var wire = new JsonSerializerOptions(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

        var detail = await factory.CreateClient().GetFromJsonAsync<SystemDetail>("/api/systems/aa.orders-api", wire, TestContext.Current.CancellationToken);

        var row = Assert.Single(detail!.Config, c => c.Key == "minCalls");
        Assert.Equal("20", row.Value);
        Assert.Equal("defaults.yaml, api", row.Source);
    }

    // ---- the query ----

    private static (LogAnalyticsSource Source, CannedHttp Http) Asking(string folder, string answer, Func<RegistrySource, RegistrySource>? change = null)
    {
        var registry = Prod(folder);
        var env = registry.ActiveEnvironment!;
        var http = CannedHttp.Always(answer);
        var definition = env.Sources.Single(s => s.Name == "telemetry") with { Connection = Workspace };
        if (change is not null) definition = change(definition);
        var source = (LogAnalyticsSource)new LogAnalyticsSourceFactory(new HttpClient(http), new FakeTimeProvider(T0))
            .Create(new SourceContext("prod", definition, null, env.Scope, new ScopeStore(), folder));
        return (source, http);
    }

    private static string Recorded(string folder) => File.ReadAllText(Path.Combine(folder, "telemetry.json"));

    [Fact]
    public async Task Town_A_sends_its_own_query_with_the_window_and_every_telemetry_name_filled_in()
    {
        var (source, http) = Asking(TownA, Recorded(TownA));

        var readings = await source.PollAsync(RegistryLoader.Load(TownA), CancellationToken.None);

        var sent = Assert.Single(http.Sent);
        Assert.Equal($"https://api.loganalytics.io/v1/workspaces/{Workspace}/query", sent.Uri!.ToString());
        Assert.Equal("PT5M", sent.Json.GetProperty("timespan").GetString());
        var query = sent.Json.GetProperty("query").GetString()!;
        Assert.Contains("AppMetrics", query);
        Assert.Contains("ago(5m)", query);
        Assert.Contains("AppRoleName in (\"ApiGateway\", \"OrdersApi\", \"OrdersWorker\", \"LedgerApi\", \"LedgerWorker\")", query);
        Assert.DoesNotContain("{", query.Replace("[\"", "").Replace("\"]", "")); // every hole was filled
        Assert.Equal(10, readings["aa.orders-api"].RequestsPerSecond);
    }

    [Fact]
    public async Task Town_B_sends_a_different_query_and_gets_the_same_numbers()
    {
        var (source, http) = Asking(TownB, Recorded(TownB));

        var readings = await source.PollAsync(RegistryLoader.Load(TownB), CancellationToken.None);

        var query = Assert.Single(http.Sent).Json.GetProperty("query").GetString()!;
        Assert.Contains("Telemetry_CL", query);
        Assert.Contains("ago(300s)", query);
        Assert.Contains("service_s in (\"APIgateway\", \"OrdersAPI\", \"Ordersworker\", \"LedgerGateway\", \"Ledgerworker\")", query);
        Assert.DoesNotContain("AppMetrics", query);
        Assert.Equal(10, readings["aa.orders-api"].RequestsPerSecond);
        Assert.Equal(0.02, readings["aa.orders-api"].ErrorRate, 6);
    }

    [Fact]
    public async Task The_login_is_asked_for_the_log_analytics_scope_and_its_token_is_sent()
    {
        var registry = Prod(TownA);
        var env = registry.ActiveEnvironment!;
        var http = CannedHttp.Always(Recorded(TownA));
        var login = new StaticLogin("secret-token");
        var source = new LogAnalyticsSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(
            new SourceContext("prod", env.Sources.Single(s => s.Name == "telemetry") with { Connection = Workspace }, login, env.Scope, new ScopeStore(), TownA));

        await source.PollAsync(RegistryLoader.Load(TownA), CancellationToken.None);

        Assert.Equal("Bearer secret-token", Assert.Single(http.Sent).Headers["Authorization"]);
        Assert.Equal(["https://api.loganalytics.io/.default"], login.Scopes);
    }

    [Fact]
    public async Task Without_a_connection_the_environments_workspace_is_used_and_a_resource_id_is_queried_by_its_path()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "workspace: \"ws-{env}-main\"", "workspace: \"/subscriptions/s1/resourceGroups/rg/providers/microsoft.operationalinsights/workspaces/ws-{env}\"");
        var (source, http) = Asking(copy.Path, Recorded(TownA), d => d with { Connection = null });

        await source.PollAsync(RegistryLoader.Load(copy.Path), CancellationToken.None);

        Assert.Equal("https://api.loganalytics.io/v1/subscriptions/s1/resourceGroups/rg/providers/microsoft.operationalinsights/workspaces/ws-prd/query", Assert.Single(http.Sent).Uri!.ToString());
    }

    [Fact]
    public async Task A_workspace_name_is_refused_with_a_message_that_says_what_to_give_instead()
    {
        var (source, http) = Asking(TownA, Recorded(TownA), d => d with { Connection = null }); // scope.workspace is "ws-prd-main"

        var e = await Assert.ThrowsAsync<InvalidOperationException>(() => source.PollAsync(RegistryLoader.Load(TownA), CancellationToken.None));

        Assert.Contains("'ws-prd-main' is a name", e.Message);
        Assert.Contains("workspace id", e.Message);
        Assert.Empty(http.Sent);
    }

    [Fact]
    public async Task A_refusal_from_the_workspace_is_an_error_that_says_what_it_answered()
    {
        var registry = Prod(TownA);
        var env = registry.ActiveEnvironment!;
        var http = CannedHttp.Always("""{"error":{"code":"InsufficientAccessError"}}""", HttpStatusCode.Forbidden);
        var source = new LogAnalyticsSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(
            new SourceContext("prod", env.Sources.Single(s => s.Name == "telemetry") with { Connection = Workspace }, null, env.Scope, new ScopeStore(), TownA));

        var e = await Assert.ThrowsAsync<HttpRequestException>(() => source.PollAsync(registry, CancellationToken.None));

        Assert.Contains("403", e.Message);
        Assert.Contains("InsufficientAccessError", e.Message);
    }

    [Fact]
    public void A_source_with_neither_a_query_nor_a_recording_cannot_start_and_says_so()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "connection: \"file:telemetry.json\"", $"connection: \"{Workspace}\"");
        var env = RegistryLoader.Load(copy.Path).Environments.Single();
        var noQuery = env with { Sources = env.Sources.Select(s => s.Name == "telemetry" ? s with { Query = null } : s).ToList() };

        var set = new AdapterCatalog([new AzureAdapters()]).Build(noQuery, copy.Path);

        Assert.Contains(set.Problems, p => p.Contains("source 'telemetry' could not start") && p.Contains("no query"));
        Assert.DoesNotContain(set.Sources, s => s.Name == "telemetry");
    }

    [Fact]
    public async Task No_system_with_a_telemetry_name_means_no_query_at_all()
    {
        var (source, http) = Asking(TownA, Recorded(TownA));
        using var copy = new RegistryCopy(TownA);
        copy.Replace("hub.yaml", ", telemetry: { role: ApiGateway }", "");
        foreach (var file in new[] { "aa", "bb" })
            copy.Write($"pillars/{file}.yaml", System.Text.RegularExpressions.Regex.Replace(copy.Read($"pillars/{file}.yaml"), ", telemetry: \\{ role: \\w+ \\}", ""));

        var readings = await source.PollAsync(RegistryLoader.Load(copy.Path), CancellationToken.None);

        Assert.Empty(readings);
        Assert.Empty(http.Sent);
    }

    // ---- the answer ----

    private static string Answer(string columns, string rows) => $$"""{"tables":[{"name":"PrimaryResult","columns":[{{columns}}],"rows":[{{rows}}]}]}""";
    private static string Col(string name) => $$"""{"name":"{{name}}","type":"real"}""";

    [Fact]
    public void Columns_are_found_by_name_in_any_order_and_case_and_numbers_may_be_text()
    {
        var rows = LogAnalyticsReader.Parse(Answer($"{Col("LatencyMS")},{Col("ROLE")},{Col("errors")},{Col("calls")}", """[12.5,"Svc",3,"40"]"""));

        var row = Assert.Single(rows);
        Assert.Equal(new SpanRow("Svc", 40, 3, 12.5), row);
    }

    [Fact]
    public void Errors_and_latency_may_be_left_out_of_the_query()
    {
        var row = Assert.Single(LogAnalyticsReader.Parse(Answer($"{Col("role")},{Col("calls")}", """["Svc",7]""")));

        Assert.Equal(new SpanRow("Svc", 7, 0, null), row);
    }

    [Fact]
    public void A_query_that_returns_other_columns_is_told_which_it_must_return()
    {
        var e = Assert.Throws<InvalidOperationException>(() => LogAnalyticsReader.Parse(Answer($"{Col("service")},{Col("n")}", """["Svc",7]""")));

        Assert.Contains("role, calls, errors, latencyMs", e.Message);
        Assert.Contains("it returned service, n", e.Message);
    }

    [Fact]
    public void An_answer_with_no_table_is_an_error()
    {
        Assert.Throws<InvalidOperationException>(() => LogAnalyticsReader.Parse("""{"tables":[]}"""));
    }

    [Fact]
    public void Rows_without_a_name_and_numbers_that_are_missing_negative_or_odd_are_taken_as_nothing()
    {
        var rows = LogAnalyticsReader.Parse(Answer($"{Col("role")},{Col("calls")},{Col("errors")},{Col("latencyMs")}",
            """[null,5,0,1],["A",null,null,null],["B",-4,"x",-1],["",3,0,0]"""));

        Assert.Equal([new SpanRow("A", 0, 0, null), new SpanRow("B", 0, 0, null)], rows);
    }

    [Fact]
    public void Rows_of_one_name_add_up_and_the_latency_is_weighted_by_calls_and_the_errors_never_exceed_the_calls()
    {
        var system = new SystemScope("p.s", null, "Svc", "x", null, null, []);
        var rows = new[] { new SpanRow("svc", 100, 10, 50), new SpanRow("SVC", 300, 500, 150), new SpanRow("Other", 9, 9, 9) };

        var reading = LogAnalyticsSource.Readings([system], rows, TimeSpan.FromMinutes(5), T0)["p.s"];

        Assert.Equal(400, reading.Calls);
        Assert.Equal(400.0 / 300, reading.RequestsPerSecond, 6);
        Assert.Equal(1, reading.ErrorRate); // 510 errors reported of 400 calls: capped
        Assert.Equal(125, reading.P99Ms, 6);
        Assert.Equal(T0, reading.At);
    }

    // ---- the file ----

    private static string Problems(Action<RegistryCopy> change)
    {
        using var copy = new RegistryCopy(TownA);
        change(copy);
        return Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;
    }

    [Fact]
    public void A_window_must_be_a_number_and_a_unit()
    {
        var message = Problems(c => c.Replace("environments/prod.yaml", "window: 5m\n    query: |", "window: soon\n    query: |"));

        Assert.Contains("source 'telemetry' has window 'soon'", message);
    }

    [Fact]
    public void A_query_may_use_the_windows_the_roles_and_the_environments_own_variables_and_nothing_else()
    {
        var message = Problems(c => c.Replace("environments/prod.yaml", "ago({window}) and AppRoleName in ({roles})", "ago({window}) and AppRoleName in ({role}) and x == '{env}'"));

        Assert.Contains("source 'telemetry' query", message);
        Assert.Contains("{role} is not a variable here", message);
        Assert.DoesNotContain("{env} is not", message); // env is the town's own variable
    }

    [Fact]
    public async Task The_adapter_module_and_the_source_keep_the_rules_every_adapter_keeps()
    {
        AdapterContract.AssertModule(new AzureAdapters());
        var registry = Prod(TownB);
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, TownB);

        await AdapterContract.AssertPollAsync(set.Sources.Single(s => s.Name == "telemetry"), registry);
    }
}
