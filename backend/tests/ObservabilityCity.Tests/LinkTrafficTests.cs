using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Links;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 3, slice 2: where an API's traffic comes from. Outside = the measured total less what town systems send it (sampling-corrected), never a setting.
/// The addresses are the environment's own rules, so the same calls in two towns with opposite conventions must split the same way.
/// </summary>
public class LinkTrafficTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-b");
    private static readonly DateTimeOffset Now = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Hour = TimeSpan.FromHours(1);

    private static double Rate(InboundSplit split, string from) => split.Callers.Single(c => c.From == from).RequestsPerSecond;

    // ---- the maths ----

    private static LinkTraffic Traffic(int minCalls = 20, params (string Caller, string Target, double Calls)[] calls)
    {
        var traffic = new LinkTraffic();
        traffic.Update(calls, Hour, minCalls);
        return traffic;
    }

    [Fact]
    public void Nothing_is_known_until_a_read_has_succeeded()
    {
        var traffic = new LinkTraffic();

        Assert.False(traffic.Measured);
        Assert.Null(traffic.Split("bb.ledger-api", 10)); // unmeasured is not the same as nobody calls it
    }

    [Fact]
    public void Outside_is_the_measured_total_less_what_the_town_callers_send()
    {
        // 1800 and 900 calls an hour are 0.5 and 0.25 a second; the API sees 1 a second in all
        var traffic = Traffic(20, ("aa.orders-worker", "bb.ledger-api", 1800), ("bb.ledger-worker", "bb.ledger-api", 900));

        var split = traffic.Split("bb.ledger-api", 1.0)!;

        Assert.Equal(0.25, split.Outside, 6);
        Assert.Equal(0.5, Rate(split, "aa.orders-worker"), 6);
        Assert.Equal(0.25, Rate(split, "bb.ledger-worker"), 6);
        Assert.False(split.Estimated);
    }

    [Fact]
    public void A_building_no_town_system_calls_gets_all_its_traffic_from_outside()
    {
        var traffic = Traffic(20, ("aa.orders-worker", "bb.ledger-api", 1800));

        var split = traffic.Split("aa.orders-api", 4.0)!;

        Assert.Equal(4.0, split.Outside, 6);
        Assert.Empty(split.Callers);
        Assert.False(split.Estimated); // no callers is a measurement, not a guess
    }

    [Fact]
    public void Callers_that_add_up_to_more_than_the_total_are_scaled_down_together_and_outside_is_never_below_zero()
    {
        // 2 a second from one caller and 1 from another against a total of 1.5: the two are measured differently, so they are cut to fit
        var traffic = Traffic(20, ("a.x", "t.api", 7200), ("b.y", "t.api", 3600));

        var split = traffic.Split("t.api", 1.5)!;

        Assert.Equal(0, split.Outside, 6);
        Assert.Equal(1.0, Rate(split, "a.x"), 6);
        Assert.Equal(0.5, Rate(split, "b.y"), 6);
        Assert.Equal(1.5, split.Callers.Sum(c => c.RequestsPerSecond), 6);
    }

    [Fact]
    public void An_idle_api_has_no_traffic_from_anywhere()
    {
        var split = Traffic(20, ("a.x", "t.api", 7200)).Split("t.api", 0)!;

        Assert.Equal(0, split.Outside);
        Assert.Empty(split.Callers);
    }

    [Fact]
    public void Too_few_calls_to_trust_keep_the_last_good_share_and_say_it_is_estimated()
    {
        var traffic = Traffic(20, ("a.x", "t.api", 3600)); // 1 a second of an API that sees 4
        Assert.Equal(3.0, traffic.Split("t.api", 4.0)!.Outside, 6);

        traffic.Update([("a.x", "t.api", 5)], Hour, 20); // five calls in the hour: noise
        var split = traffic.Split("t.api", 8.0)!;

        Assert.True(split.Estimated);
        Assert.Equal(2.0, Rate(split, "a.x"), 6); // the same quarter of the API's traffic, now that it sees 8
        Assert.Equal(6.0, split.Outside, 6);
    }

    [Fact]
    public void Too_few_calls_and_no_earlier_share_uses_what_there_is_and_marks_it_estimated()
    {
        var split = Traffic(20, ("a.x", "t.api", 18)).Split("t.api", 1.0)!;

        Assert.True(split.Estimated);
        Assert.Equal(0.005, Rate(split, "a.x"), 6);
    }

    [Fact]
    public void A_failed_read_keeps_the_numbers_and_remembers_why()
    {
        var traffic = Traffic(20, ("a.x", "t.api", 3600));

        traffic.Fail("Log Analytics answered 500");

        Assert.Equal("Log Analytics answered 500", traffic.Error);
        Assert.Equal(1.0, Rate(traffic.Split("t.api", 4.0)!, "a.x"), 6);
        traffic.Update([("a.x", "t.api", 3600)], Hour, 20);
        Assert.Null(traffic.Error);
    }

    // ---- the runner, in two towns with opposite address conventions ----

    private const string TrafficA = """

        links:
          source: telemetry
          query: "AppDependencies | where AppRoleName in ({roles}) | where TimeGenerated between (datetime({from}) .. datetime({to}))"
          rules:
            - { host: '^(?<service>[a-z]+)-(?<role>api|worker)\.(?<pillar>[a-z]+)\.a\.example\.test$', target: '{pillar}.{service}-{role}' }
            - { host: '^gw\.a\.example\.test$', path: '^/(?<pillar>[a-z]+)/(?<service>[a-z]+)/(?<role>api|worker)', target: '{pillar}.{service}-{role}', gateway: true }
          aliases: { al: aa, be: bb }
          traffic:
            query: "AppDependencies | where AppRoleName in ({roles}) | where TimeGenerated between (datetime({from}) .. datetime({to})) | summarize calls = sum(ItemCount)"
            minCalls: 20
        """;

    private const string TrafficB = """

        links:
          source: telemetry
          query: "AppDependencies | where AppRoleName in ({roles}) | where TimeGenerated between (datetime({from}) .. datetime({to}))"
          rules:
            - { host: '^(?<role>api|worker)--(?<service>[a-z]+)--(?<pillar>[a-z]+)\.b\.example\.test$', target: '{pillar}.{service}-{role}' }
            - { host: '^edge\.b\.example\.test$', path: '^/v1/(?<service>[a-z]+)\.(?<pillar>[a-z]+)\.(?<role>api|worker)', target: '{pillar}.{service}-{role}', gateway: true }
          aliases: { alpha: aa, beta: bb }
          traffic:
            query: "Deps | where Role in ({roles}) | where At between (datetime({from}) .. datetime({to}))"
            shareWindow: 30m
            minCalls: 10
            interval: 2m
        """;

    private static string Host(bool a, string target, bool gateway, out string? path)
    {
        var (pillar, rest) = (target.Split('.')[0], target.Split('.')[1]);
        var (service, role) = (rest[..rest.LastIndexOf('-')], rest[(rest.LastIndexOf('-') + 1)..]);
        if (a)
        {
            var code = pillar == "aa" ? "al" : "be";
            path = gateway ? $"/{code}/{service}/{role}/v1/things" : null;
            return gateway ? "gw.a.example.test" : $"{service}-{role}.{code}.a.example.test";
        }
        var name = pillar == "aa" ? "alpha" : "beta";
        path = gateway ? $"/v1/{service}.{name}.{role}/things" : null;
        return gateway ? "edge.b.example.test" : $"{role}--{service}--{name}.b.example.test";
    }

    private sealed class FakeDependencies(Func<IReadOnlyList<DependencyRow>> answer) : IDependencySource
    {
        public bool CanReadDependencies => true;
        public bool Fails { get; set; }
        public List<(string Query, DateTimeOffset From, DateTimeOffset To)> Asked { get; } = [];

        public Task<IReadOnlyList<DependencyRow>> ReadDependenciesAsync(TownRegistry registry, string query, IReadOnlyCollection<string> roles, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
        {
            Asked.Add((query, from, to));
            return Fails ? throw new HttpRequestException("Log Analytics answered 500") : Task.FromResult(answer());
        }
    }

    private sealed class Town(string folder, bool a, FakeTimeProvider time) : IDisposable
    {
        /// <summary>The share window of the town's traffic block, which turns a rate into the calls its query counts.</summary>
        public double WindowSeconds { get; } = a ? 3600 : 1800;
        public RegistryHolder Holder { get; } = new(RegistryLoader.Load(folder));
        public ScopeStore Scope { get; } = new();
        public DiscoveredLinks Store { get; } = new();
        public EnvironmentRegistry View => new(Holder, "prod", Store, time);
        public RegistryCopy? Copy { get; init; }
        public Dictionary<string, string> Roles => Scope.Resolve(View.Current).Systems.Where(s => s.TelemetryRole is not null).ToDictionary(s => s.SystemId, s => s.TelemetryRole!);

        /// <summary>What the traffic query returns: calls over the hour from each caller to each target (no days).</summary>
        public IReadOnlyList<DependencyRow> Rows(params (string Caller, string Target, bool Gateway, double Calls)[] calls) =>
            calls.Select(c => new DependencyRow(Roles[c.Caller], Host(a, c.Target, c.Gateway, out var path), path, [], c.Calls * WindowSeconds / 3600)).ToList();

        public LinkTrafficRunner Runner(IDependencySource source, FakeTimeProvider clock) =>
            new(source, Scope, View, Store.Traffic, clock, NullLogger<LinkTrafficRunner>.Instance);

        public void Dispose() => Copy?.Dispose();
    }

    private static Town Make(bool a, FakeTimeProvider time)
    {
        var copy = new RegistryCopy(a ? TownA : TownB);
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + (a ? TrafficA : TrafficB));
        return new Town(copy.Path, a, time) { Copy = copy };
    }

    private static readonly (string, string, bool, double)[] Calls =
    [
        ("aa.orders-worker", "bb.ledger-api", true, 1800),   // across islands, through the gateway: 0.5 a second (calls shown for a 1h window)
        ("bb.ledger-worker", "bb.ledger-api", false, 900),   // on its own island, direct: 0.25 a second
        ("bb.ledger-api", "aa.orders-api", true, 3600),      // 1 a second
    ];

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task The_same_calls_split_the_same_way_in_both_towns_whatever_their_addresses_look_like(bool a)
    {
        var clock = new FakeTimeProvider(Now);
        using var town = Make(a, clock);
        var source = new FakeDependencies(() => town.Rows(Calls));
        var runner = town.Runner(source, clock);

        await runner.RunOnceAsync(TestContext.Current.CancellationToken);

        var ledger = town.Store.Traffic.Split("bb.ledger-api", 1.0)!;
        Assert.Equal(0.25, ledger.Outside, 6);
        Assert.Equal(0.5, Rate(ledger, "aa.orders-worker"), 6);
        Assert.Equal(0.25, Rate(ledger, "bb.ledger-worker"), 6);
        var orders = town.Store.Traffic.Split("aa.orders-api", 4.0)!;
        Assert.Equal(3.0, orders.Outside, 6);
        Assert.Equal(1.0, Rate(orders, "bb.ledger-api"), 6);
    }

    [Theory]
    [InlineData(true, "1h", 20)]
    [InlineData(false, "30m", 10)]
    public async Task The_query_is_the_environments_own_and_looks_back_over_the_share_window(bool a, string window, int minCalls)
    {
        var clock = new FakeTimeProvider(Now);
        using var town = Make(a, clock);
        var source = new FakeDependencies(() => []);

        await town.Runner(source, clock).RunOnceAsync(TestContext.Current.CancellationToken);

        var (query, from, to) = Assert.Single(source.Asked);
        Assert.Equal(Now, to);
        Assert.Equal(Now - (window == "1h" ? Hour : TimeSpan.FromMinutes(30)), from);
        Assert.Contains(a ? "AppDependencies" : "Deps", query);
        var config = town.View.Current.ActiveEnvironment!.Links!.Traffic!;
        Assert.Equal((TimeSpan.Parse(window == "1h" ? "01:00:00" : "00:30:00"), minCalls), (config.ShareWindow, config.MinCalls));
    }

    [Fact]
    public async Task Addresses_no_rule_explains_and_calls_to_a_system_itself_add_nothing()
    {
        var clock = new FakeTimeProvider(Now);
        using var town = Make(true, clock);
        var source = new FakeDependencies(() => town.Rows(Calls).Append(new DependencyRow(town.Roles["aa.orders-worker"], "nobody.example.test", null, [], 9999))
            .Append(new DependencyRow(town.Roles["bb.ledger-api"], "ledger-api.be.a.example.test", null, [], 9999)).ToList());

        await town.Runner(source, clock).RunOnceAsync(TestContext.Current.CancellationToken);

        Assert.Equal(1.0, Rate(town.Store.Traffic.Split("bb.ledger-api", 2.0)!, "aa.orders-worker") * 2, 6);
        Assert.DoesNotContain(town.Store.Traffic.Split("bb.ledger-api", 2.0)!.Callers, c => c.From == "bb.ledger-api");
    }

    [Fact]
    public async Task A_read_that_fails_keeps_the_numbers_and_the_town_says_so()
    {
        var clock = new FakeTimeProvider(Now);
        using var town = Make(true, clock);
        var source = new FakeDependencies(() => town.Rows(Calls));
        var runner = town.Runner(source, clock);
        await runner.CycleAsync(TestContext.Current.CancellationToken);

        source.Fails = true;
        await runner.CycleAsync(TestContext.Current.CancellationToken);

        Assert.Equal(0.5, Rate(town.Store.Traffic.Split("bb.ledger-api", 1.0)!, "aa.orders-worker"), 6);
        Assert.Contains(town.Store.Notices(2), n => n.Contains("Log Analytics answered 500"));
    }

    [Fact]
    public async Task A_town_with_no_traffic_block_reads_nothing_and_stays_unmeasured()
    {
        const string withoutTraffic = TrafficA;
        var clock = new FakeTimeProvider(Now);
        using var copy = new RegistryCopy(TownA);
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + withoutTraffic[..withoutTraffic.IndexOf("  traffic:", StringComparison.Ordinal)]);
        var holder = new RegistryHolder(RegistryLoader.Load(copy.Path));
        var traffic = new LinkTraffic();
        var source = new FakeDependencies(() => []);

        await new LinkTrafficRunner(source, new ScopeStore(), new EnvironmentRegistry(holder, "prod"), traffic, clock, NullLogger<LinkTrafficRunner>.Instance)
            .RunOnceAsync(TestContext.Current.CancellationToken);

        Assert.Empty(source.Asked);
        Assert.False(traffic.Measured);
    }

    // ---- the snapshot ----

    private static Snapshot Build(Town town, LinkTraffic? traffic, double ledger = 1.0, double orders = 4.0)
    {
        var clock = new FakeTimeProvider(Now);
        var state = new LatestState();
        var view = town.View.Current;
        NodeReading Reading(double rps) => new(Now, true, 2, 2, 0.3, rps, 0, 100);
        var readings = view.AllNodes.ToDictionary(n => n.Id, n => Reading(n.Id switch { "bb.ledger-api" => ledger, "aa.orders-api" => orders, _ => 0.1 }));
        foreach (var source in new[] { "telemetry", "inventory", "platform" }) state.Update(source, readings); // the town reads each signal from its own source
        return new SnapshotBuilder(town.View, state, clock) { Traffic = traffic, StaleAfter = TimeSpan.FromDays(1) }.Build();
    }

    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == id);

    [Fact]
    public async Task The_snapshot_carries_each_apis_outside_rate_and_what_each_town_caller_sends()
    {
        var clock = new FakeTimeProvider(Now);
        using var town = Make(true, clock);
        await town.Runner(new FakeDependencies(() => town.Rows(Calls)), clock).RunOnceAsync(TestContext.Current.CancellationToken);

        var s = Build(town, town.Store.Traffic);

        var ledger = Node(s, "bb.ledger-api");
        Assert.Equal(0.25, ledger.OutsideRequestsPerSecond!.Value, 6);
        Assert.Equal(["aa.orders-worker", "bb.ledger-worker"], ledger.Inbound!.Select(l => l.From).ToArray());
        Assert.Equal(0.5, ledger.Inbound!.Single(l => l.From == "aa.orders-worker").RequestsPerSecond, 6);
        Assert.False(ledger.InboundEstimated);
        // a building that is not an API has no inbound split, and an API nobody in the town calls is all outside
        Assert.Null(Node(s, "aa.orders-db").OutsideRequestsPerSecond);
        Assert.Equal(3.0, Node(s, "aa.orders-api").OutsideRequestsPerSecond!.Value, 6);
        // the airport's rate is the sum of the outside parts, for every API on screen, external or not
        Assert.Equal(s.Groups.SelectMany(g => g.Nodes).Where(n => n.OutsideRequestsPerSecond is not null).Sum(n => n.OutsideRequestsPerSecond!.Value), s.OutsideRequestsPerSecond!.Value, 6);
        Assert.True(s.OutsideRequestsPerSecond > 3.0);
    }

    [Fact]
    public async Task The_dependency_overlay_uses_what_each_caller_really_sends_not_an_even_share()
    {
        var clock = new FakeTimeProvider(Now);
        using var town = Make(true, clock);
        await town.Runner(new FakeDependencies(() => town.Rows(Calls)), clock).RunOnceAsync(TestContext.Current.CancellationToken);
        town.Store.RecordLink("aa.orders-worker", "bb.ledger-api", true, [DateOnly.Parse("2026-10-28"), DateOnly.Parse("2026-10-29")]); // found by link discovery

        var s = Build(town, town.Store.Traffic);

        // aa.orders-worker sends 0.5 a second to bb.ledger-api; with an even share it would be half of the API's 1.0
        Assert.Equal(0.5, s.Dependencies.Single(d => d is { From: "aa", To: "bb" }).RequestsPerSecond, 6);
    }

    [Fact]
    public async Task Without_a_measurement_the_snapshot_says_nothing_about_outside_traffic()
    {
        var clock = new FakeTimeProvider(Now);
        using var town = Make(true, clock);

        var s = Build(town, null);

        Assert.Null(s.OutsideRequestsPerSecond);
        Assert.All(s.Groups.SelectMany(g => g.Nodes), n => { Assert.Null(n.OutsideRequestsPerSecond); Assert.Null(n.Inbound); });
        // the outside callers keep adding up the systems they reach, as before there was a measurement
        Assert.Equal(Node(s, "aa.orders-api").RequestsPerSecond + Node(s, "bb.ledger-api").RequestsPerSecond, s.ExternalCallers.Single(c => c.Id == "mobile-app").RequestsPerSecond, 6);
        await Task.CompletedTask;
    }

    // ---- config ----

    [Fact]
    public void The_traffic_block_reaches_the_registry_with_its_defaults()
    {
        var clock = new FakeTimeProvider(Now);
        using var a = Make(true, clock);
        using var b = Make(false, clock);

        var defaults = a.View.Current.ActiveEnvironment!.Links!.Traffic!;
        Assert.Equal((TimeSpan.FromHours(1), 20, TimeSpan.FromMinutes(5)), (defaults.ShareWindow, defaults.MinCalls, defaults.Interval));
        Assert.Equal(TimeSpan.FromMinutes(2), b.View.Current.ActiveEnvironment!.Links!.Traffic!.Interval);
    }

    [Theory]
    [InlineData("query: \"\"", "traffic.query is empty")]
    [InlineData("query: \"x {nonsense}\"", "traffic.query")]
    [InlineData("query: q\n    shareWindow: soon", "shareWindow 'soon'")]
    [InlineData("query: q\n    minCalls: 0", "minCalls is 0")]
    public void A_mistake_in_the_traffic_block_is_a_config_error_that_names_it(string block, string expected)
    {
        using var copy = new RegistryCopy(TownA);
        var env = copy.Read("environments/prod.yaml") + TrafficA[..TrafficA.IndexOf("  traffic:", StringComparison.Ordinal)] + "  traffic:\n    " + block + "\n";
        copy.Write("environments/prod.yaml", env);

        var e = Record.Exception(() => RegistryLoader.Load(copy.Path));

        Assert.NotNull(e);
        Assert.Contains(expected, e!.Message);
    }

    [Fact]
    public void The_traffic_answer_needs_no_days_but_does_need_a_caller_and_a_host_and_calls()
    {
        const string answer = """{"tables":[{"columns":[{"name":"caller"},{"name":"host"},{"name":"path"},{"name":"calls"}],"rows":[["OrdersApi","gw.example.test","/be/ledger",1200.0],["","x.example.test",null,1.0]]}]}""";

        var rows = LogAnalyticsReader.ParseDependencies(answer);

        var row = Assert.Single(rows);
        Assert.Equal(("OrdersApi", "gw.example.test", "/be/ledger", 1200d), (row.Caller, row.Host, row.Path, row.Calls));
        Assert.Empty(row.Days);
        var e = Assert.Throws<InvalidOperationException>(() => LogAnalyticsReader.ParseDependencies("""{"tables":[{"columns":[{"name":"caller"},{"name":"host"}],"rows":[]}]}"""));
        Assert.Contains("caller, host and days", e.Message);
    }
}
