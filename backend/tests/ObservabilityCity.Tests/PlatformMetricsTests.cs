using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
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
/// Phase 2, slice 5: the lights of a building (CPU and memory of the plans it runs on, request units and throttling of its data accounts) come from the
/// platform metrics API. The program knows no metric name, aggregation, filter or divisor: the environment's <c>metrics</c> entries say them. Two towns
/// with differently shaped entries (percentages from plans and request units over provisioned throughput; cores and bytes over limits and a normalised
/// consumption metric) read the same recorded numbers and show the same town, which is the proof.
/// </summary>
public class PlatformMetricsTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-b");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    private static TownRegistry Prod(string folder) => RegistryLoader.Load(folder).ForEnvironment("prod");
    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).First(n => n.Id == id);

    private static async Task<Snapshot> TownSnapshot(string folder, FakeTimeProvider time)
    {
        var registry = Prod(folder);
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, folder);
        Assert.Empty(set.Problems);
        var state = new LatestState();
        foreach (var source in set.Sources) state.Update(source.Name, await source.PollAsync(registry, CancellationToken.None));
        return new SnapshotBuilder(registry, state, time) { Environment = "prod" }.Build();
    }

    /// <summary>The platform source of a town, started over the inventory its recording gives, with the HTTP it is handed (none: it replays its recording).</summary>
    private static async Task<(IMetricSource Source, TownRegistry Registry)> Platform(string folder, CannedHttp? http = null, ICredentialSource? login = null)
    {
        var registry = Prod(folder);
        var env = registry.ActiveEnvironment!;
        var set = new AdapterCatalog([new AzureAdapters()]).Build(env, folder);
        await set.Sources.Single(s => s.Name == "inventory").PollAsync(registry, CancellationToken.None);
        if (http is null) return (set.Sources.Single(s => s.Name == "platform"), registry);
        var definition = env.Sources.Single(s => s.Name == "platform") with { Connection = null };
        var source = new AzureMonitorSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(new SourceContext("prod", definition, login, env.Scope, set.Scope, folder));
        return (source, registry);
    }

    // ---- the town, whatever the metrics ----

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task Two_towns_with_differently_shaped_metrics_show_the_same_lights(string town)
    {
        var snapshot = await TownSnapshot(town == "a" ? TownA : TownB, new FakeTimeProvider(T0));

        // a system with two plans (or two container apps' worth) is as busy as its busiest
        var api = Node(snapshot, "aa.orders-api");
        Assert.Equal(0.64, api.Cpu!.Value, 6);
        Assert.Equal(0.71, api.Memory!.Value, 6);
        Assert.Equal(0.64, Node(snapshot, "aa.orders-worker").Cpu!.Value, 6);
        var ledger = Node(snapshot, "bb.ledger-api");
        Assert.Equal(0.40, ledger.Cpu!.Value, 6);
        Assert.Equal(0.52, ledger.Memory!.Value, 6);

        // the worst tenant's account decides: Borealis uses 95% of what it has and 10% of its requests are turned away
        var orders = Node(snapshot, "aa.orders-db");
        Assert.Equal(0.95, orders.Utilisation!.Value, 6);
        Assert.Equal(0.1, orders.Throttled!.Value, 6);
        Assert.Equal(HealthState.Degraded, orders.State);
        var ledgerDb = Node(snapshot, "bb.ledger-db");
        Assert.Equal(0.5, ledgerDb.Utilisation!.Value, 6);
        Assert.Equal(0, ledgerDb.Throttled!.Value); // a filter that matches no request at all is no throttling, not an unknown
        Assert.Equal(HealthState.Healthy, ledgerDb.State);

        // the other sources still fill their own signals
        Assert.Equal(3, api.InstancesTotal);
        Assert.Equal(10, api.RequestsPerSecond);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task A_source_reports_only_the_systems_its_entries_cover_and_every_reading_passes_the_contract(string town)
    {
        var (source, registry) = await Platform(town == "a" ? TownA : TownB);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        Assert.Equal(["aa.orders-api", "aa.orders-db", "aa.orders-worker", "bb.ledger-api", "bb.ledger-db", "bb.ledger-worker"], readings.Keys.Order());
        AdapterContract.AssertReadings(readings, registry);
        Assert.Null(readings["aa.orders-api"].Utilisation); // a plan has no request units
        Assert.Null(readings["aa.orders-db"].Cpu); // an account has no CPU
    }

    [Fact]
    public async Task Each_tenants_account_is_read_on_its_own_so_the_town_can_show_whose_is_hot()
    {
        var (source, registry) = await Platform(TownA);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        var tenants = readings["aa.orders-db"].Tenants!.OrderBy(t => t.TenantId).ToList();
        Assert.Equal(["11111111111111111111111111111111", "22222222222222222222222222222222", "33333333333333333333333333333333"], tenants.Select(t => t.TenantId));
        Assert.Equal([0.2, 0.95, 0.4], tenants.Select(t => t.Utilisation!.Value).Select(v => Math.Round(v, 6)));
        Assert.Equal([0, 0.1, 0], tenants.Select(t => Math.Round(t.Throttled!.Value, 6)));
        Assert.Equal([10, 5, 6], tenants.Select(t => Math.Round(t.RequestsPerSecond, 6))); // requests counted over the 5 minutes
    }

    [Fact]
    public async Task A_limit_entry_gives_each_tenants_provisioned_size_as_a_plain_number_and_leaves_the_health_alone()
    {
        var (source, registry) = await Platform(TownA);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        var orders = readings["aa.orders-db"];
        Assert.All(orders.Tenants!, t => Assert.Equal(1000, t.Limit));
        Assert.Equal(0.95, Math.Round(orders.Utilisation!.Value, 6)); // the limit is not a share and does not move the worst
    }

    [Fact]
    public async Task Without_a_limit_entry_a_tenant_has_no_limit()
    {
        var (source, registry) = await Platform(TownB);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        Assert.All(readings["aa.orders-db"].Tenants!, t => Assert.Null(t.Limit));
    }

    [Fact]
    public async Task An_or_else_metric_stands_in_where_the_first_gives_no_number_or_zero_for_the_size_and_for_the_share_it_divides_by()
    {
        using var copy = new RegistryCopy(TownA);
        const string ceiling = "{ metric: AutoscaleMaxThroughput, aggregation: maximum, orElse: { metric: ProvisionedThroughput, aggregation: maximum } }";
        copy.Replace("environments/prod.yaml", "limit: { metric: ProvisionedThroughput, aggregation: maximum }", $"limit: {ceiling}");
        copy.Replace("environments/prod.yaml", "over: { metric: ProvisionedThroughput, aggregation: maximum } }", $"over: {ceiling} }}");
        EditRecording(copy, doc =>
        {
            // the second account has an autoscale ceiling; the first reports 0 (a fixed throughput); the third has no such series at all
            doc["22222222222222222222222222222222-al-ord"]!.AsArray().Add(new JsonObject { ["metric"] = "AutoscaleMaxThroughput", ["aggregation"] = "maximum", ["points"] = new JsonArray(10000, 10000, 10000) });
            doc["11111111111111111111111111111111-al-ord"]!.AsArray().Add(new JsonObject { ["metric"] = "AutoscaleMaxThroughput", ["aggregation"] = "maximum", ["points"] = new JsonArray(0, 0, 0) });
        });
        var (source, registry) = await Platform(copy.Path);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        var tenants = readings["aa.orders-db"].Tenants!.OrderBy(t => t.TenantId).ToList();
        Assert.Equal([1000, 10000, 1000], tenants.Select(t => t.Limit!.Value));
        Assert.Equal([0.2, 0.095, 0.4], tenants.Select(t => Math.Round(t.Utilisation!.Value, 6))); // the second is a tenth of what it was: its share is of the ceiling
    }

    [Fact]
    public void An_or_else_cannot_have_an_over_or_an_or_else_of_its_own()
    {
        var message = LoadError(_ => ["limit: { metric: ProvisionedThroughput, aggregation: maximum }",
            "limit: { metric: A, aggregation: maximum, orElse: { metric: B, aggregation: maximum, orElse: { metric: C, aggregation: maximum } } }"]);

        Assert.Contains("limit.orElse: it is only another metric to read in place; it cannot have an over or an orElse of its own", message);
    }

    private const string NormalisedUtilisation = "utilisation: { metric: NormalizedRUConsumption, aggregation: maximum, scale: 0.01 }";

    /// <summary>Town B's accounts report a normalised consumption (a maximum), which Azure sends only when something happened. A quiet account has no points.</summary>
    private static void QuietAccounts(RegistryCopy copy, bool idle, params string[] accounts)
    {
        if (idle) copy.Replace("environments/prod.yaml", NormalisedUtilisation, NormalisedUtilisation.Replace(" scale:", " whenEmpty: idle, scale:"));
        EditRecording(copy, doc =>
        {
            foreach (var account in accounts)
                doc[account]!.AsArray().First(x => (string?)x!["metric"] == "NormalizedRUConsumption")!["points"] = new JsonArray();
        });
    }

    [Fact]
    public async Task A_quiet_account_that_gave_no_number_makes_the_whole_store_unknown_unless_the_entry_says_idle()
    {
        using var copy = new RegistryCopy(TownB);
        QuietAccounts(copy, idle: false, "cosmos-orders-cygnus");
        var (source, registry) = await Platform(copy.Path);

        var orders = (await source.PollAsync(registry, CancellationToken.None))["aa.orders-db"];

        Assert.Null(orders.Utilisation);
        Assert.All(orders.Tenants!, t => Assert.Null(t.Idle));
    }

    [Fact]
    public async Task When_empty_idle_counts_a_read_that_gave_no_number_as_no_use_and_marks_that_tenant()
    {
        using var copy = new RegistryCopy(TownB);
        QuietAccounts(copy, idle: true, "cosmos-orders-cygnus");
        var (source, registry) = await Platform(copy.Path);

        var orders = (await source.PollAsync(registry, CancellationToken.None))["aa.orders-db"];

        var idle = orders.Tenants!.Where(t => t.Idle == true).ToList();
        Assert.Single(idle);
        Assert.Equal(0, idle[0].Utilisation);
        Assert.Equal(2, orders.Tenants!.Count(t => t.Idle is null && t.Utilisation > 0));
        Assert.Equal(0.95, Math.Round(orders.Utilisation!.Value, 6)); // the busy one still decides the store's light
    }

    [Fact]
    public async Task A_store_whose_every_account_is_quiet_reads_zero_not_no_data_when_idle_is_set()
    {
        using var copy = new RegistryCopy(TownB);
        QuietAccounts(copy, idle: true, "cosmos-orders-acmebank", "cosmos-orders-borealis", "cosmos-orders-cygnus");
        var (source, registry) = await Platform(copy.Path);

        var orders = (await source.PollAsync(registry, CancellationToken.None))["aa.orders-db"];

        Assert.Equal(0, orders.Utilisation);
        Assert.All(orders.Tenants!, t => Assert.True(t.Idle));
    }

    [Fact]
    public async Task A_failed_read_is_never_read_as_idle()
    {
        using var copy = new RegistryCopy(TownB);
        QuietAccounts(copy, idle: true);
        var http = new CannedHttp().Respond(_ => CannedHttp.Reply("""{"error":{"code":"AuthorizationFailed"}}""", HttpStatusCode.Forbidden));
        var (source, registry) = await Platform(copy.Path, http);
        var published = new Dictionary<string, NodeReading>();

        var e = await Assert.ThrowsAsync<HttpRequestException>(() => ((IProgressiveMetricSource)source).PollAsync(registry, b => { foreach (var (id, r) in b) published[id] = r; }, CancellationToken.None));

        Assert.Contains("resource reads failed", e.Message);
        Assert.False(published.ContainsKey("aa.orders-db")); // not reported at all, so it shows no data and not 0%
    }

    [Fact]
    public void When_empty_takes_unknown_or_idle_and_only_on_the_signal_itself()
    {
        const string utilisation = "utilisation: { metric: TotalRequestUnits, aggregation: total, perSecond: true, over: { metric: ProvisionedThroughput, aggregation: maximum } }";
        var wrong = LoadError(_ => [utilisation, utilisation.Replace(" over:", " whenEmpty: zero, over:")]);
        var onOver = LoadError(_ => [utilisation, utilisation.Replace("aggregation: maximum }", "aggregation: maximum, whenEmpty: idle }")]);

        Assert.Contains("utilisation.whenEmpty: 'zero'. Use unknown, idle.", wrong);
        Assert.Contains("utilisation.over.whenEmpty: it belongs on the signal itself, not on its over or orElse", onOver);
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", utilisation, utilisation.Replace(" over:", " whenEmpty: unknown, over:"));
        Assert.NotNull(RegistryLoader.Load(copy.Path));
    }

    [Fact]
    public async Task A_tenant_the_list_spells_with_dashes_is_the_tenant_the_source_found_without_them()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "signals: {", "tenants:\n  - { id: 22222222-2222-2222-2222-222222222222, name: Borealis Credit Union }\nsignals: {");

        var snapshot = await TownSnapshot(copy.Path, new FakeTimeProvider(T0));

        var units = Node(snapshot, "aa.orders-db").Tenants!;
        var borealis = Assert.Single(units, u => u.Name == "Borealis Credit Union");
        Assert.Equal(0.95, borealis.Utilisation!.Value, 6);
        Assert.Equal(HealthState.Down, borealis.State); // 95% is the red line, and a tenth of its requests turned away is past it too
        Assert.DoesNotContain(units, u => u.Kind == TenantKind.Unknown); // the other two accounts are not listed, but their tag names them
    }

    [Fact]
    public async Task A_tenant_nobody_lists_but_the_accounts_tag_names_is_a_customer_with_that_name()
    {
        using var copy = new RegistryCopy(TownA);

        var snapshot = await TownSnapshot(copy.Path, new FakeTimeProvider(T0));

        var units = Node(snapshot, "aa.orders-db").Tenants!;
        Assert.Equal(["Acme Bank", "Borealis Credit Union", "Cygnus Finance"], units.Select(u => u.Name).Order().ToList());
        Assert.All(units, u => Assert.Equal(TenantKind.Customer, u.Kind));
        // and the top bar's tenant list has them too, by name, with the id the units carry
        Assert.Equal(units.Select(u => u.Id).Order(), snapshot.Tenants.Select(t => t.Id).Order());
        Assert.Contains(snapshot.Tenants, t => t.Name == "Cygnus Finance" && t.Kind == TenantKind.Customer);
    }

    [Fact]
    public async Task A_tenant_nobody_lists_and_nothing_names_stays_unknown_under_its_id()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", ", tenantNameTag: tenant", "");

        var snapshot = await TownSnapshot(copy.Path, new FakeTimeProvider(T0));

        var units = Node(snapshot, "aa.orders-db").Tenants!;
        Assert.Equal(3, units.Count(u => u.Kind == TenantKind.Unknown));
        Assert.All(units, u => Assert.Equal(u.Id, u.Name));
        Assert.All(snapshot.Tenants, t => Assert.Equal(TenantKind.Unknown, t.Kind));
    }

    // ---- nothing is built in ----

    [Fact]
    public async Task A_metric_name_is_only_ever_the_environments_word()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "metric: CpuPercentage", "metric: cpu_pct_of_plan");
        copy.Write("platform.json", copy.Read("platform.json").Replace("CpuPercentage", "cpu_pct_of_plan"));

        var snapshot = await TownSnapshot(copy.Path, new FakeTimeProvider(T0));

        Assert.Equal(0.64, Node(snapshot, "aa.orders-api").Cpu!.Value, 6);
    }

    [Fact]
    public async Task A_metric_the_recording_does_not_have_leaves_that_signal_unknown_and_the_others_alone()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "metric: CpuPercentage", "metric: not_a_metric");

        var snapshot = await TownSnapshot(copy.Path, new FakeTimeProvider(T0));

        var api = Node(snapshot, "aa.orders-api");
        Assert.Null(api.Cpu);
        Assert.Equal(0.71, api.Memory!.Value, 6);
    }

    [Fact]
    public async Task One_resource_with_no_number_makes_the_systems_number_unknown_instead_of_hiding_behind_the_others()
    {
        using var copy = new RegistryCopy(TownA);
        EditRecording(copy, doc => doc["plan-cf-acme-al-ord-westeurope9z"]!.AsArray().Remove(doc["plan-cf-acme-al-ord-westeurope9z"]!.AsArray().First(s => (string?)s!["metric"] == "CpuPercentage")));

        var snapshot = await TownSnapshot(copy.Path, new FakeTimeProvider(T0));

        var api = Node(snapshot, "aa.orders-api");
        Assert.Null(api.Cpu); // the western plan could be the hot one
        Assert.Equal(0.71, api.Memory!.Value, 6);
    }

    [Fact]
    public async Task A_share_above_the_whole_is_held_at_the_whole()
    {
        using var copy = new RegistryCopy(TownA);
        EditRecording(copy, doc =>
        {
            foreach (var series in doc["22222222222222222222222222222222-al-ord"]!.AsArray().Where(s => (string?)s!["metric"] == "ProvisionedThroughput"))
                series!["points"] = new JsonArray(100, 100, 100); // 950 request units a second against 100 provisioned
        });

        var snapshot = await TownSnapshot(copy.Path, new FakeTimeProvider(T0));

        Assert.Equal(1.0, Node(snapshot, "aa.orders-db").Utilisation!.Value);
    }

    // ---- sources start together ----

    [Fact]
    public async Task A_poll_that_starts_before_the_inventory_is_read_waits_for_it_instead_of_reporting_nothing()
    {
        var registry = Prod(TownA);
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, TownA);
        var inventory = set.Sources.Single(s => s.Name == "inventory");
        var platform = set.Sources.Single(s => s.Name == "platform");

        var polling = platform.PollAsync(registry, CancellationToken.None); // started first, as the host starts them
        await Task.Delay(150, TestContext.Current.CancellationToken);
        Assert.False(polling.IsCompleted);
        await inventory.PollAsync(registry, CancellationToken.None);

        Assert.Equal(6, (await polling).Count);
    }

    [Fact]
    public async Task A_poll_gives_up_waiting_after_half_its_time_and_reports_nothing_when_the_inventory_never_comes()
    {
        var registry = Prod(TownA);
        var env = registry.ActiveEnvironment!;
        var definition = env.Sources.Single(s => s.Name == "platform") with { TimeoutSeconds = 0.4 };
        var source = new AzureMonitorSourceFactory().Create(new SourceContext("prod", definition, null, env.Scope, new ScopeStore(), TownA));

        var readings = await source.PollAsync(registry, CancellationToken.None);

        Assert.Empty(readings);
    }

    // ---- the real API ----

    /// <summary>Answers a metrics request from the recording: the series of the resource and metrics named in the URL, in the shape the API gives them.</summary>
    private static HttpResponseMessage FromRecording(SentRequest request, IReadOnlyDictionary<string, IReadOnlyList<MetricSeries>> recording)
    {
        var segments = request.Uri!.AbsolutePath.Split('/');
        var resource = segments[Array.LastIndexOf(segments, "providers") - 1];
        var query = System.Web.HttpUtility.ParseQueryString(request.Uri.Query);
        var aggregation = query["aggregation"]!.ToLowerInvariant();
        var filter = query["$filter"];
        var names = query["metricnames"]!.Split(',');
        var value = names.Select(name =>
        {
            var points = recording.GetValueOrDefault(resource)?.Where(s => s.Metric == name && s.Aggregation == aggregation && s.Filter == filter).SelectMany(s => s.Points).ToList() ?? [];
            return new
            {
                name = new { value = name, localizedValue = name },
                timeseries = points.Count == 0 ? Array.Empty<object>() : [new { data = points.Select(p => new Dictionary<string, object> { ["timeStamp"] = "2026-01-01T00:00:00Z", [aggregation] = p }).ToList() }],
            };
        });
        return CannedHttp.Reply(JsonSerializer.Serialize(new { cost = 0, timespan = query["timespan"], interval = "PT1M", value }));
    }

    [Fact]
    public async Task The_adapter_asks_the_metrics_api_once_per_resource_and_kind_of_question_and_reads_the_same_numbers_as_the_recording()
    {
        var recording = AzureMonitorSource.ReadRecording(File.ReadAllText(Path.Combine(TownA, "platform.json")));
        var http = new CannedHttp().Respond(r => FromRecording(r, recording));
        var login = new StaticLogin("secret-token");
        var (source, registry) = await Platform(TownA, http, login);
        var (replay, _) = await Platform(TownA);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        var expected = await replay.PollAsync(registry, CancellationToken.None);
        Assert.Equal(expected.Keys.Order(), readings.Keys.Order());
        foreach (var (id, reading) in expected)
        {
            Assert.Equal(reading.Cpu, readings[id].Cpu);
            Assert.Equal(reading.Memory, readings[id].Memory);
            Assert.Equal(reading.Utilisation, readings[id].Utilisation);
            Assert.Equal(reading.Throttled, readings[id].Throttled);
        }
        // a plan: CPU and memory share one call; an account: request units, provisioned throughput, all requests and the throttled ones are four
        Assert.Equal(4 * 1 + 5 * 4, http.Sent.Count);
        Assert.All(http.Sent, r => Assert.Equal("Bearer secret-token", r.Headers["Authorization"]));
        Assert.Equal(["https://management.azure.com/.default"], login.Scopes.Distinct());
        var plan = http.Sent.First(r => r.Uri!.AbsolutePath.Contains("/serverfarms/plan-cf-acme-al-ord-northeurope1x/"));
        Assert.StartsWith("https://management.azure.com/subscriptions/00000000-0000-0000-0000-0000000000a1/resourceGroups/rg/providers/microsoft.web/serverfarms/plan-cf-acme-al-ord-northeurope1x/providers/Microsoft.Insights/metrics?api-version=2018-01-01", plan.Uri!.ToString());
        var query = System.Web.HttpUtility.ParseQueryString(plan.Uri.Query);
        Assert.Equal("CpuPercentage,MemoryPercentage", query["metricnames"]);
        Assert.Equal("Average", query["aggregation"]);
        Assert.Equal("PT1M", query["interval"]);
        Assert.Equal("2025-12-31T23:55:00Z/2026-01-01T00:00:00Z", query["timespan"]); // the 5 minute window ending now
        Assert.Null(query["$filter"]);
        var filtered = http.Sent.Where(r => System.Web.HttpUtility.ParseQueryString(r.Uri!.Query)["$filter"] == "StatusCode eq '429'").ToList();
        Assert.Equal(5, filtered.Count);
        Assert.All(filtered, r => Assert.Equal("TotalRequests", System.Web.HttpUtility.ParseQueryString(r.Uri!.Query)["metricnames"]));
    }

    [Fact]
    public async Task A_namespace_in_the_entry_is_sent_and_nothing_is_sent_when_it_is_left_out()
    {
        var http = new CannedHttp().Respond(_ => CannedHttp.Reply("""{"value":[]}"""));
        var (source, registry) = await Platform(TownB, http);

        await source.PollAsync(registry, CancellationToken.None);

        var app = http.Sent.First(r => r.Uri!.AbsolutePath.Contains("/containerapps/"));
        Assert.Equal("microsoft.app/containerapps", System.Web.HttpUtility.ParseQueryString(app.Uri!.Query)["metricnamespace"]);
        var account = http.Sent.First(r => r.Uri!.AbsolutePath.Contains("/databaseaccounts/"));
        Assert.Null(System.Web.HttpUtility.ParseQueryString(account.Uri!.Query)["metricnamespace"]);
    }

    [Fact]
    public async Task An_entry_with_an_interval_asks_its_calls_at_that_grain_and_the_others_at_a_minute()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "- resources: accounts", "- resources: accounts\n        interval: 5m"); // some metrics (provisioned throughput) do not support a minute
        var recording = AzureMonitorSource.ReadRecording(File.ReadAllText(Path.Combine(TownA, "platform.json")));
        var http = new CannedHttp().Respond(r => FromRecording(r, recording));
        var (source, registry) = await Platform(copy.Path, http);

        await source.PollAsync(registry, CancellationToken.None);

        string Interval(SentRequest r) => System.Web.HttpUtility.ParseQueryString(r.Uri!.Query)["interval"]!;
        var accounts = http.Sent.Where(r => r.Uri!.AbsolutePath.Contains("/databaseaccounts/")).ToList();
        var plans = http.Sent.Where(r => r.Uri!.AbsolutePath.Contains("/serverfarms/")).ToList();
        Assert.Equal(5 * 4, accounts.Count);
        Assert.All(accounts, r => Assert.Equal("PT5M", Interval(r)));
        Assert.All(plans, r => Assert.Equal("PT1M", Interval(r)));
    }

    [Fact]
    public async Task An_entry_with_a_window_looks_that_far_back_and_the_others_keep_the_sources()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "- resources: accounts", "- resources: accounts\n        interval: 5m\n        window: 1h");
        var recording = AzureMonitorSource.ReadRecording(File.ReadAllText(Path.Combine(TownA, "platform.json")));
        var http = new CannedHttp().Respond(r => FromRecording(r, recording));
        var (source, registry) = await Platform(copy.Path, http);

        await source.PollAsync(registry, CancellationToken.None);

        string Span(SentRequest r) => System.Web.HttpUtility.ParseQueryString(r.Uri!.Query)["timespan"]!;
        Assert.All(http.Sent.Where(r => r.Uri!.AbsolutePath.Contains("/databaseaccounts/")), r => Assert.Equal("2025-12-31T23:00:00Z/2026-01-01T00:00:00Z", Span(r)));
        Assert.All(http.Sent.Where(r => r.Uri!.AbsolutePath.Contains("/serverfarms/")), r => Assert.Equal("2025-12-31T23:55:00Z/2026-01-01T00:00:00Z", Span(r)));
    }

    [Fact]
    public void An_entry_window_must_hold_two_points_of_its_interval_and_be_a_time()
    {
        var short1 = LoadError(_ => ["- resources: accounts", "- resources: accounts\n        interval: 5m\n        window: 5m"]);
        Assert.Contains("metrics[1]: window '5m' holds fewer than two points of its 5m interval; make it at least 10m", short1);

        var bad = LoadError(_ => ["- resources: accounts", "- resources: accounts\n        window: lots"]);
        Assert.Contains("metrics[1]: window 'lots' is not a number and a unit like 15m or 1h", bad);
    }

    [Theory]
    [InlineData("1m", "PT1M")]
    [InlineData("15m", "PT15M")]
    [InlineData("1h", "PT1H")]
    [InlineData("6h", "PT6H")]
    [InlineData("24h", "P1D")]
    public void A_grain_is_written_the_way_the_metrics_api_takes_it(string text, string iso)
    {
        Assert.True(SourceQuery.TryParseWindow(text, out var grain));

        Assert.Equal(iso, AzureMonitorReader.Iso(grain));
    }

    [Fact]
    public void An_interval_the_metrics_api_does_not_offer_is_a_mistake_that_lists_the_ones_it_does()
    {
        var message = LoadError(_ => ["- resources: accounts", "- resources: accounts\n        interval: 7m"]);

        Assert.Contains("metrics[1]: interval '7m' is not a time grain the metrics API offers", message);
        Assert.Contains("1m, 5m, 15m, 30m, 1h, 6h, 12h, 1d", message);
    }

    [Fact]
    public async Task Each_system_is_reported_as_soon_as_its_own_resources_are_read_not_when_every_read_is_done()
    {
        var http = new CannedHttp().Respond(_ => CannedHttp.Reply("""{"value":[{"name":{"value":"CpuPercentage"},"timeseries":[{"data":[{"average":50}]}]}]}"""));
        var (source, registry) = await Platform(TownA, http);
        var batches = new List<IReadOnlyDictionary<string, NodeReading>>();

        await ((IProgressiveMetricSource)source).PollAsync(registry, batches.Add, CancellationToken.None);

        Assert.True(batches.Count > 1, "every system came in one batch at the end");
        Assert.All(batches, b => Assert.NotEmpty(b));
    }

    [Fact]
    public async Task A_failing_read_holds_back_only_the_systems_that_use_it_and_the_rest_are_reported_before_the_poll_fails()
    {
        var everyone = new HashSet<string>();
        var ok = new CannedHttp().Respond(_ => CannedHttp.Reply("""{"value":[{"name":{"value":"CpuPercentage"},"timeseries":[{"data":[{"average":50}]}]}]}"""));
        var (all, town) = await Platform(TownA, ok);
        await ((IProgressiveMetricSource)all).PollAsync(town, b => { foreach (var id in b.Keys) everyone.Add(id); }, CancellationToken.None);

        var http = new CannedHttp().Respond(r => r.Uri!.AbsolutePath.Contains("westeurope9z")
            ? CannedHttp.Reply("""{"error":{"code":"AuthorizationFailed"}}""", HttpStatusCode.Forbidden)
            : CannedHttp.Reply("""{"value":[{"name":{"value":"CpuPercentage"},"timeseries":[{"data":[{"average":50}]}]}]}"""));
        var (source, registry) = await Platform(TownA, http);
        var published = new HashSet<string>();

        var e = await Assert.ThrowsAsync<HttpRequestException>(() => ((IProgressiveMetricSource)source).PollAsync(registry, b => { foreach (var id in b.Keys) published.Add(id); }, CancellationToken.None));

        Assert.Contains("resource reads failed", e.Message);
        Assert.True(published.IsSubsetOf(everyone) && published.Count < everyone.Count, $"published {published.Count} of {everyone.Count}");
    }

    [Fact]
    public void Saved_readings_come_back_as_they_were_with_the_time_they_were_taken_and_a_bad_file_is_ignored()
    {
        var folder = Path.Combine(Path.GetTempPath(), "oc-readings-" + Guid.NewGuid().ToString("N"));
        try
        {
            var cache = new ReadingCache(folder);
            var at = DateTimeOffset.Parse("2026-11-01T01:00:00Z");
            cache.Save("platform", new Dictionary<string, NodeReading>
            {
                ["aa.orders-db"] = new(at, true, 0, 0, 0, 0, 0, 0, Cpu: 0.4, Utilisation: 0.9, Throttled: 0.1,
                    Tenants: [new TenantReading("t1", 0.9, 0.1, 3, "Acme", 4000)], Regions: [new RegionReading("North", null, 0.4, 0.5)]),
            });

            var back = new ReadingCache(folder).Load("platform");

            var r = Assert.Single(back).Value;
            Assert.Equal(at, r.At);
            Assert.Equal(0.9, r.Utilisation);
            Assert.Equal("Acme", Assert.Single(r.Tenants!).Name);
            Assert.Equal("North", Assert.Single(r.Regions!).Region);
            File.WriteAllText(Path.Combine(folder, "platform.json"), "{ not json");
            Assert.Empty(new ReadingCache(folder).Load("platform"));
            Assert.Empty(new ReadingCache(folder).Load("never-saved"));
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }

    [Fact]
    public async Task A_restart_within_the_freshness_window_starts_from_the_saved_readings_and_an_older_save_comes_back_stale()
    {
        var folder = Path.Combine(Path.GetTempPath(), "oc-readings-" + Guid.NewGuid().ToString("N"));
        try
        {
            var time = new FakeTimeProvider(T0);
            var (source, registry) = await Platform(TownA);
            var first = new LatestState();
            first.Update("platform", await source.PollAsync(registry, CancellationToken.None));
            new ReadingCache(folder).Save("platform", first.Of("platform"));
            Assert.NotEmpty(first.Of("platform"));

            var restarted = new LatestState();
            restarted.Update("platform", new ReadingCache(folder).Load("platform"));
            var builder = () => new SnapshotBuilder(registry, restarted, time) { Environment = "prod", StaleAfter = TimeSpan.FromMinutes(4) };

            Assert.Equal(first.Of("platform").Count, restarted.Of("platform").Count);
            time.SetUtcNow(first.Of("platform").Values.Max(r => r.At) + TimeSpan.FromHours(1));
            Assert.All(builder().Build().Groups.SelectMany(g => g.Nodes).Where(n => restarted.Of("platform").ContainsKey(n.Id)), n => Assert.NotEqual(HealthState.Healthy, n.State));
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }

    [Fact]
    public async Task A_refused_read_fails_the_poll_and_says_how_many_and_what_the_cloud_answered()
    {
        var http = new CannedHttp().Respond(r => r.Uri!.AbsolutePath.Contains("westeurope9z")
            ? CannedHttp.Reply("""{"error":{"code":"AuthorizationFailed"}}""", HttpStatusCode.Forbidden)
            : CannedHttp.Reply("""{"value":[]}"""));
        var (source, registry) = await Platform(TownA, http);

        var e = await Assert.ThrowsAsync<HttpRequestException>(() => source.PollAsync(registry, CancellationToken.None));

        Assert.Contains("2 of 9 resource reads failed", e.Message); // the two western plans
        Assert.Contains("403", e.Message);
        Assert.Contains("AuthorizationFailed", e.Message);
    }

    [Fact]
    public void An_answer_that_is_not_a_metrics_answer_is_named_as_such()
    {
        var e = Assert.Throws<InvalidOperationException>(() => AzureMonitorReader.Parse("""{"tables":[]}""", new MetricCall(null, "average", null)));

        Assert.Contains("metrics answer", e.Message);
    }

    [Fact]
    public void A_point_the_cloud_gave_no_value_for_is_a_gap_and_the_points_are_added_up_as_the_aggregation_says()
    {
        var json = """{"value":[{"name":{"value":"M"},"timeseries":[{"data":[{"timeStamp":"t1","total":4},{"timeStamp":"t2"},{"timeStamp":"t3","total":6}]}]}]}""";

        var series = Assert.Single(AzureMonitorReader.Parse(json, new MetricCall(null, "total", null)));

        Assert.Equal([4, 6], series.Points);
        Assert.Equal(10, AzureMonitorReader.Reduce(series.Points, "total"));
        Assert.Equal(5, AzureMonitorReader.Reduce(series.Points, "average"));
        Assert.Equal(6, AzureMonitorReader.Reduce(series.Points, "maximum"));
        Assert.Equal(4, AzureMonitorReader.Reduce(series.Points, "minimum"));
        Assert.Null(AzureMonitorReader.Reduce([], "average"));
    }

    // ---- the files ----

    private static string LoadError(Func<RegistryCopy, string[]> change)
    {
        using var copy = new RegistryCopy(TownA);
        var edit = change(copy);
        copy.Replace("environments/prod.yaml", edit[0], edit[1]);
        return Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;
    }

    [Fact]
    public void An_entry_must_name_a_rule_of_scope_resources()
    {
        var message = LoadError(_ => ["- resources: plans", "- resources: planz"]);

        Assert.Contains("source 'platform' metrics[0]: resources 'planz' is not a rule of scope.resources", message);
        Assert.Contains("plans", message);
    }

    [Fact]
    public void An_aggregation_must_be_one_the_api_knows_and_a_scale_must_be_above_zero()
    {
        var message = LoadError(_ => ["cpu: { metric: CpuPercentage, aggregation: average, scale: 0.01 }", "cpu: { metric: CpuPercentage, aggregation: avrage, scale: 0 }"]);

        Assert.Contains("metrics[0].cpu: aggregation 'avrage'", message);
        Assert.Contains("Did you mean 'average'", message);
        Assert.Contains("metrics[0].cpu: scale must be above 0", message);
    }

    [Fact]
    public void An_entry_that_asks_for_nothing_and_a_metric_with_no_name_are_mistakes()
    {
        var empty = LoadError(_ => ["      - resources: plans\n        cpu: { metric: CpuPercentage, aggregation: average, scale: 0.01 }\n        memory: { metric: MemoryPercentage, aggregation: average, scale: 0.01 }", "      - resources: plans"]);
        var unnamed = LoadError(_ => ["cpu: { metric: CpuPercentage, aggregation: average, scale: 0.01 }", "cpu: { aggregation: average }"]);

        Assert.Contains("it asks for no signal", empty);
        Assert.Contains("metrics[0].cpu: metric is empty", unnamed);
    }

    [Fact]
    public void A_divisor_is_used_as_it_is_and_cannot_have_a_divisor_of_its_own()
    {
        var message = LoadError(_ => ["over: { metric: ProvisionedThroughput, aggregation: maximum }", "over: { metric: ProvisionedThroughput, aggregation: maximum, scale: 2, over: { metric: X } }"]);

        Assert.Contains("over cannot have an over of its own", message);
        Assert.Contains("the divisor is used as it is", message);
    }

    [Fact]
    public void A_filter_may_use_the_environments_variables_and_nothing_else()
    {
        var message = LoadError(_ => ["filter: \"StatusCode eq '429'\"", "filter: \"StatusCode eq '{code}'\""]);

        Assert.Contains("filter: {code} is not a variable here", message);
    }

    [Fact]
    public void A_platform_source_with_no_metrics_cannot_start_and_says_so()
    {
        var env = RegistryLoader.Load(TownA).Environments.Single();
        var bare = env with { Sources = env.Sources.Select(s => s.Name == "platform" ? s with { Metrics = [] } : s).ToList() };

        var set = new AdapterCatalog([new AzureAdapters()]).Build(bare, TownA);

        Assert.Contains(set.Problems, p => p.Contains("source 'platform' could not start") && p.Contains("no metrics"));
        Assert.DoesNotContain(set.Sources, s => s.Name == "platform");
    }

    private static void EditRecording(RegistryCopy copy, Action<JsonObject> change)
    {
        var doc = JsonNode.Parse(copy.Read("platform.json"))!.AsObject();
        change(doc);
        copy.Write("platform.json", doc.ToJsonString());
    }
}
