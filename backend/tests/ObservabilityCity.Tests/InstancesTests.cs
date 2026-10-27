using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 2, slice 3: a building's floors come from the real instance count. A resource rule says how to count the instances of its resources, the
/// inventory source reports each system's sum, and the town takes the instances signal from it while other signals come from other sources. Two towns
/// with opposite conventions (a plan's workers; a container app's replicas) show the same numbers, which is the proof that the core counts nothing itself.
/// </summary>
public class InstancesTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-b");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    private static TownRegistry Prod(string folder) => RegistryLoader.Load(folder).ForEnvironment("prod");
    private static Inventory Recorded(string folder) => ResourceGraphInventory.FromRecording(File.ReadAllText(Path.Combine(folder, "inventory.json")));
    private static Resolution Resolved(string folder) => ScopeResolver.Resolve(Prod(folder), Recorded(folder));

    private static NodeReading Reading(DateTimeOffset? at = null, bool up = true, int instances = 0, double rps = 0, double errors = 0, double p99 = 0, double? cpu = null) =>
        new(at ?? T0, up, instances, instances, 0.5, rps, errors, p99, cpu);

    // ---- counting ----

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public void A_system_runs_the_sum_of_its_counted_resources_whatever_the_convention(string town)
    {
        var r = Resolved(town == "a" ? TownA : TownB);

        Assert.Equal(3, r.System("aa.orders-api")!.Instances);
        Assert.Equal(3, r.System("aa.orders-worker")!.Instances);
        Assert.Equal(5, r.System("bb.ledger-api")!.Instances);
        Assert.Equal(5, r.System("bb.ledger-worker")!.Instances);
    }

    [Fact]
    public void Plans_in_two_regions_are_added_and_a_staging_plan_is_left_out()
    {
        var api = Resolved(TownA).System("aa.orders-api")!;

        Assert.Equal([1, 2], api.Resources.Where(x => x.Rule == "plans").Select(x => x.Instances).Order().Select(x => x!.Value));
        Assert.DoesNotContain(api.Resources, x => x.Instances == 9); // the staging subscription's plan
    }

    [Fact]
    public void A_system_with_no_counted_resource_has_an_unknown_count_not_zero()
    {
        var r = Resolved(TownA);

        Assert.Null(r.System("aa.orders-db")!.Instances); // its accounts are not counted
        Assert.NotEmpty(r.System("aa.orders-db")!.Resources);
        Assert.Null(ScopeResolver.Resolve(Prod(TownA), null).System("aa.orders-api")!.Instances); // nothing read yet
    }

    [Fact]
    public void A_rule_without_an_instances_expression_counts_nothing_even_when_the_inventory_has_a_number()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", ", instances: \"coalesce(toint(properties.numberOfWorkers), toint(sku.capacity))\"", "");

        var r = ScopeResolver.Resolve(Prod(copy.Path), Recorded(copy.Path));

        Assert.Null(r.System("aa.orders-api")!.Instances);
    }

    [Fact]
    public void A_resource_the_cloud_gave_no_number_adds_nothing_but_does_not_make_the_count_unknown()
    {
        var inventory = Recorded(TownA);
        var plans = inventory.Resources.Select(x => x.Name.StartsWith("plan-cf-acme-al-ord-westeurope") ? x with { Instances = null } : x).ToList();

        var r = ScopeResolver.Resolve(Prod(TownA), inventory with { Resources = plans });

        Assert.Equal(2, r.System("aa.orders-api")!.Instances);
    }

    // ---- the file ----

    [Fact]
    public void An_empty_instances_expression_is_refused_and_a_filled_one_is_kept()
    {
        using var copy = new RegistryCopy(TownA);
        Assert.Equal("coalesce(toint(properties.numberOfWorkers), toint(sku.capacity))", Prod(TownA).ActiveEnvironment!.Scope.Resources.First(x => x.Name == "plans").Instances);

        copy.Replace("environments/prod.yaml", "instances: \"coalesce(toint(properties.numberOfWorkers), toint(sku.capacity))\"", "instances: \" \"");
        var message = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;

        Assert.Contains("resources 'plans'", message);
        Assert.Contains("instances is empty", message);
    }

    // ---- the adapter ----

    private sealed class Graph(Func<JsonDocument, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<JsonDocument> Bodies { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            Bodies.Add(body);
            return answer(body);
        }
    }

    private static string SecondQuery(Graph graph) => graph.Bodies[1].RootElement.GetProperty("query").GetString()!;

    private static async Task<(Inventory Inventory, Graph Graph)> Read(ScopeRules rules, object[]? resources = null)
    {
        var subs = new[] { new { id = "sub-1", name = "acme-eu-prd-al", tags = new { } } };
        var graph = new Graph(body => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = JsonContent.Create(new { data = body.RootElement.GetProperty("query").GetString()!.StartsWith("resourcecontainers") ? (object)subs : resources ?? [] }),
        });
        var reader = new ResourceGraphInventory(new HttpClient(graph), null, new RegistrySource("inventory", "resourcegraph", null), rules);
        return (await reader.ReadAsync(Prod(TownA), CancellationToken.None), graph);
    }

    [Fact]
    public async Task The_query_counts_each_type_with_the_expression_of_its_rule()
    {
        var (_, graph) = await Read(Prod(TownA).ActiveEnvironment!.Scope);

        Assert.Contains("extend instances = case(type =~ 'microsoft.web/serverfarms', toint(coalesce(toint(properties.numberOfWorkers), toint(sku.capacity))), int(null))", SecondQuery(graph));
        Assert.Contains("project id, name, type, subscriptionId, location, tags, instances", SecondQuery(graph));
    }

    [Fact]
    public async Task Another_convention_sends_its_own_expression_and_the_first_rule_of_a_type_wins()
    {
        var rules = Prod(TownB).ActiveEnvironment!.Scope with
        {
            Resources =
            [
                new ResourceRule("one", ["t/one"], "(?<service>x)", [], null, null, "a.b"),
                new ResourceRule("two", ["T/ONE", "t/two"], "(?<service>x)", [], null, null, "c.d"),
                new ResourceRule("three", ["t/three"], "(?<service>x)", [], null, null),
            ],
        };

        var (_, graph) = await Read(rules);

        Assert.Contains("case(type =~ 't/one', toint(a.b), type =~ 't/two', toint(c.d), int(null))", SecondQuery(graph));
    }

    [Fact]
    public async Task Rules_that_count_nothing_ask_for_no_count()
    {
        var rules = Prod(TownA).ActiveEnvironment!.Scope with { Resources = [new ResourceRule("plans", ["microsoft.web/serverfarms"], "(?<service>x)", [], null, null)] };

        var (_, graph) = await Read(rules);

        Assert.Contains("extend instances = int(null)", SecondQuery(graph));
    }

    [Fact]
    public async Task A_replaced_query_without_the_hole_is_sent_as_it_is()
    {
        var rules = Prod(TownA).ActiveEnvironment!.Scope with { Queries = new ScopeQueries(null, "resources | where type in~ ({types}) | project id, name, type, subscriptionId, location, tags") };

        var (_, graph) = await Read(rules);

        Assert.DoesNotContain("instances", SecondQuery(graph));
    }

    [Fact]
    public async Task The_numbers_in_the_answer_become_counts_and_a_missing_or_odd_one_becomes_unknown()
    {
        object Row(string name, object? instances) => new Dictionary<string, object?>
        {
            ["id"] = "/" + name, ["name"] = name, ["type"] = "microsoft.web/serverfarms", ["subscriptionId"] = "sub-1", ["location"] = "northeurope", ["tags"] = new { }, ["instances"] = instances,
        };
        var (inventory, _) = await Read(Prod(TownA).ActiveEnvironment!.Scope, [Row("p1", 4), Row("p2", null), Row("p3", "many"), Row("p4", 0), Row("p5", -1), Row("p6", 2.0)]);

        Assert.Equal([4, null, null, 0, null, 2], inventory.Resources.OrderBy(x => x.Name).Select(x => x.Instances));
    }

    // ---- the source ----

    private static ResourceGraphSource Source(string folder, FakeTimeProvider time) =>
        (ResourceGraphSource)new ResourceGraphSourceFactory(time: time).Create(
            new SourceContext("prod", new RegistrySource("inventory", "resourcegraph", "file:inventory.json"), null, Prod(folder).ActiveEnvironment!.Scope, new ScopeStore(), folder));

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task The_source_reports_the_instances_of_each_system_it_could_count_and_no_others(string town)
    {
        var folder = town == "a" ? TownA : TownB;
        var time = new FakeTimeProvider(T0);

        var readings = await Source(folder, time).PollAsync(RegistryLoader.Load(folder), CancellationToken.None);

        Assert.Equal(["aa.orders-api", "aa.orders-worker", "bb.ledger-api", "bb.ledger-worker"], readings.Keys.Order());
        var api = readings["aa.orders-api"];
        Assert.Equal(3, api.InstancesTotal);
        Assert.Equal(3, api.InstancesHealthy); // the count is what is configured; the inventory cannot say which are unhealthy
        Assert.True(api.Up);
        Assert.Equal(T0, api.At);
        Assert.Equal(5, readings["bb.ledger-api"].InstancesTotal);
    }

    // ---- joining sources ----

    [Fact]
    public void One_sources_reading_is_the_reading()
    {
        var only = Reading(instances: 3, rps: 7);

        Assert.Same(only, ReadingMerge.Merge(new Dictionary<string, NodeReading> { ["metrics"] = only }, _ => "elsewhere"));
        Assert.Null(ReadingMerge.Merge(new Dictionary<string, NodeReading>(), _ => "metrics"));
    }

    [Fact]
    public void Each_signal_comes_from_the_source_it_is_pointed_at()
    {
        var bySource = new Dictionary<string, NodeReading>
        {
            ["inventory"] = Reading(instances: 3, rps: 99, errors: 0.9),
            ["telemetry"] = Reading(instances: 0, rps: 12, errors: 0.02, p99: 140),
            ["platform"] = Reading(cpu: 0.7),
        };

        var merged = ReadingMerge.Merge(bySource, s => s switch { Signals.Instances => "inventory", Signals.Cpu => "platform", _ => "telemetry" })!;

        Assert.Equal(3, merged.InstancesTotal);
        Assert.Equal(3, merged.InstancesHealthy);
        Assert.Equal(12, merged.RequestsPerSecond);
        Assert.Equal(0.02, merged.ErrorRate);
        Assert.Equal(140, merged.P99Ms);
        Assert.Equal(0.7, merged.Cpu);
        Assert.Null(merged.Memory.HasValue ? 1 : null);
    }

    [Fact]
    public void A_signal_whose_source_has_not_reported_is_empty_and_one_with_no_source_is_left_out()
    {
        var bySource = new Dictionary<string, NodeReading> { ["inventory"] = Reading(instances: 3), ["other"] = Reading(rps: 5) };

        var merged = ReadingMerge.Merge(bySource, s => s == Signals.Instances ? "inventory" : s == Signals.Requests ? "late" : null)!;

        Assert.Equal(3, merged.InstancesTotal);
        Assert.Equal(0, merged.RequestsPerSecond);
    }

    [Fact]
    public void The_merged_reading_is_as_old_as_its_oldest_source_and_down_if_any_says_so()
    {
        var bySource = new Dictionary<string, NodeReading>
        {
            ["inventory"] = Reading(at: T0.AddMinutes(-9), instances: 2),
            ["telemetry"] = Reading(at: T0, up: false, rps: 1),
        };

        var merged = ReadingMerge.Merge(bySource, s => s == Signals.Instances ? "inventory" : "telemetry")!;

        Assert.Equal(T0.AddMinutes(-9), merged.At); // the builder greys it when this is too old: a fresh source cannot hide a stale one
        Assert.False(merged.Up);
    }

    [Fact]
    public void The_state_keeps_each_sources_reading_apart_and_the_newest_stands_for_the_node()
    {
        var state = new LatestState();
        state.Update("inventory", new Dictionary<string, NodeReading> { ["n"] = Reading(at: T0, instances: 3) });
        state.Update("telemetry", new Dictionary<string, NodeReading> { ["n"] = Reading(at: T0.AddSeconds(5), rps: 8) });
        state.Update("telemetry", new Dictionary<string, NodeReading> { ["n"] = Reading(at: T0.AddSeconds(10), rps: 9) });

        Assert.Equal(["inventory", "telemetry"], state.GetAll("n").Keys.Order());
        Assert.Equal(3, state.GetAll("n")["inventory"].InstancesTotal);
        Assert.Equal(9, state.Get("n")!.RequestsPerSecond);
        Assert.Empty(state.GetAll("missing"));
        Assert.Null(state.Get("missing"));
    }

    // ---- the town ----

    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).First(n => n.Id == id);

    [Fact]
    public async Task The_town_shows_the_inventorys_instances_next_to_another_sources_rates()
    {
        var registry = Prod(TownA);
        var time = new FakeTimeProvider(T0);
        var state = new LatestState();
        state.Update("inventory", await Source(TownA, time).PollAsync(registry, CancellationToken.None));
        state.Update("telemetry", new Dictionary<string, NodeReading> { ["aa.orders-api"] = Reading(at: T0, rps: 12, errors: 0.001, p99: 20) });

        var snapshot = new SnapshotBuilder(registry, state, time) { Environment = "prod" }.Build();

        var api = Node(snapshot, "aa.orders-api");
        Assert.Equal(HealthState.Healthy, api.State);
        Assert.Equal(3, api.InstancesTotal);
        Assert.Equal(3, api.InstancesHealthy);
        Assert.Equal(12, api.RequestsPerSecond);
        Assert.Equal(0.001, api.ErrorRate);
        Assert.DoesNotContain("instances", api.Absent!);
        Assert.Contains("backlog", api.Absent!); // nothing was asked to supply it
        Assert.Equal(5, Node(snapshot, "bb.ledger-worker").InstancesTotal);
    }

    [Fact]
    public async Task A_building_with_no_instance_reading_is_grey_never_healthy()
    {
        var time = new FakeTimeProvider(T0);
        var state = new LatestState();
        state.Update("inventory", await Source(TownA, time).PollAsync(RegistryLoader.Load(TownA), CancellationToken.None));

        var snapshot = new SnapshotBuilder(Prod(TownA), state, time) { Environment = "prod" }.Build();

        Assert.Equal(HealthState.Healthy, Node(snapshot, "aa.orders-api").State);
        Assert.Equal(HealthState.Stale, Node(snapshot, "aa.orders-db").State); // an account has no instances to count
    }

    [Fact]
    public async Task A_count_that_goes_stale_greys_the_building()
    {
        var time = new FakeTimeProvider(T0);
        var state = new LatestState();
        state.Update("inventory", await Source(TownA, time).PollAsync(RegistryLoader.Load(TownA), CancellationToken.None));
        var builder = new SnapshotBuilder(Prod(TownA), state, time) { Environment = "prod", StaleAfter = TimeSpan.FromSeconds(30) };

        time.Advance(TimeSpan.FromSeconds(31));

        Assert.Equal(HealthState.Stale, Node(builder.Build(), "aa.orders-api").State);
    }

    [Fact]
    public async Task A_source_asked_rarely_stays_fresh_for_two_of_its_intervals_and_then_greys_the_building()
    {
        var time = new FakeTimeProvider(T0);
        var state = new LatestState();
        state.Update("inventory", await Source(TownA, time).PollAsync(RegistryLoader.Load(TownA), CancellationToken.None));
        var builder = new SnapshotBuilder(Prod(TownA), state, time)
        {
            Environment = "prod",
            StaleAfter = TimeSpan.FromSeconds(30),
            SourceIntervals = new Dictionary<string, TimeSpan> { ["inventory"] = TimeSpan.FromMinutes(5) },
        };

        time.Advance(TimeSpan.FromMinutes(9)); // a poll or two have been missed, and the count still stands
        Assert.Equal(HealthState.Healthy, Node(builder.Build(), "aa.orders-api").State);

        time.Advance(TimeSpan.FromMinutes(2)); // 11 minutes: more than two intervals
        Assert.Equal(HealthState.Stale, Node(builder.Build(), "aa.orders-api").State);
    }

    [Fact]
    public async Task A_slow_source_does_not_keep_a_fast_ones_stale_reading_alive()
    {
        var registry = Prod(TownA);
        var time = new FakeTimeProvider(T0);
        var state = new LatestState();
        state.Update("inventory", await Source(TownA, time).PollAsync(registry, CancellationToken.None));
        state.Update("telemetry", new Dictionary<string, NodeReading> { ["aa.orders-api"] = Reading(at: T0, rps: 12) });
        var builder = new SnapshotBuilder(registry, state, time)
        {
            Environment = "prod",
            StaleAfter = TimeSpan.FromSeconds(30),
            SourceIntervals = new Dictionary<string, TimeSpan> { ["inventory"] = TimeSpan.FromMinutes(5), ["telemetry"] = TimeSpan.FromSeconds(10) },
        };

        time.Advance(TimeSpan.FromMinutes(2));
        state.Update("inventory", await Source(TownA, time).PollAsync(registry, CancellationToken.None)); // the inventory is fresh, the telemetry is not

        Assert.Equal(HealthState.Stale, Node(builder.Build(), "aa.orders-api").State);
    }

    private static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    private static async Task<(Snapshot Snapshot, SystemDetail Detail)> Served(string folder)
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Registry:Path", folder);
            b.UseSetting("Registry:WatchSeconds", "0");
            b.UseSetting("Snapshot:IntervalSeconds", "0.2");
        });
        var client = factory.CreateClient();
        for (var i = 0; i < 100; i++)
        {
            var snapshot = await client.GetFromJsonAsync<Snapshot>("/api/snapshot/latest", Wire, TestContext.Current.CancellationToken);
            if (snapshot is not null && Node(snapshot, "aa.orders-api").State != HealthState.Stale)
                return (snapshot, (await client.GetFromJsonAsync<SystemDetail>("/api/systems/aa.orders-api", Wire, TestContext.Current.CancellationToken))!);
            await Task.Delay(100, TestContext.Current.CancellationToken);
        }
        throw new TimeoutException("The instances were not read");
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task The_server_serves_the_instance_counts_of_either_convention(string town)
    {
        var (snapshot, detail) = await Served(town == "a" ? TownA : TownB);

        Assert.Equal(3, Node(snapshot, "aa.orders-api").InstancesTotal);
        Assert.Equal(5, Node(snapshot, "bb.ledger-api").InstancesTotal);
        Assert.Equal(3, detail.Scope!.Instances);
        Assert.Contains(detail.Scope.Resources, r => r.Instances is > 0);
    }
}
