using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// A database split into parts: the shared pool and the pieces that have capacity of their own (for Cosmos DB, the containers with their own throughput). The environment's
/// <c>parts</c> entry names the dimension that names a piece, the metric that says a piece has capacity of its own and, if the cloud names one, the shared pool. Nothing is
/// listed. Two towns with differently shaped entries read the same kind of answer and show the same parts, which is the proof that no engine is in the program.
/// A part that throttles is named instead of making the whole database look like it throttles, and the database is red only when its shared pool is red or every part is.
/// </summary>
public class DatabasePartsTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-b");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    // ---- the metrics API, split by a dimension ----

    /// <summary>What the API holds for one resource: for each (metric, aggregation, filter), the points of each value of the split dimension.</summary>
    private sealed class Answers : Dictionary<(string Metric, string Aggregation, string? Filter), Dictionary<string, double>>
    {
        public Answers Add(string metric, string aggregation, string? filter, params (string Part, double Value)[] values)
        {
            this[(metric, aggregation, filter)] = values.ToDictionary(v => v.Part, v => v.Value);
            return this;
        }
    }

    /// <summary>Answers a read: a split one ($filter ends with the dimension eq '*') with a series for each value of it, an unsplit one with a single series of the sum or the highest.</summary>
    private static HttpResponseMessage Reply(SentRequest request, Answers held, string dimension)
    {
        var query = System.Web.HttpUtility.ParseQueryString(request.Uri!.Query);
        var aggregation = query["aggregation"]!.ToLowerInvariant();
        var filter = query["$filter"];
        var split = filter is not null && filter.EndsWith($"{dimension} eq '*'", StringComparison.Ordinal);
        string? own = null;
        if (split) own = filter!.Length == $"{dimension} eq '*'".Length ? null : filter[..^$" and {dimension} eq '*'".Length];
        else own = filter;
        var value = query["metricnames"]!.Split(',').Select(name =>
        {
            var parts = held.GetValueOrDefault((name, aggregation, own)) ?? [];
            var series = split
                ? parts.Select(p => new { metadatavalues = new[] { new { name = new { value = dimension }, value = p.Key } }, data = new[] { new Dictionary<string, object> { [aggregation] = p.Value } } }).Cast<object>().ToArray()
                : parts.Count == 0 ? [] : [new { data = new[] { new Dictionary<string, object> { [aggregation] = aggregation == "maximum" ? parts.Values.Max() : parts.Values.Sum() } } }];
            return new { name = new { value = name }, timeseries = series };
        });
        return CannedHttp.Reply(JsonSerializer.Serialize(new { value }));
    }

    private static async Task<(IMetricSource Source, TownRegistry Registry)> Platform(string folder, CannedHttp http)
    {
        var registry = RegistryLoader.Load(folder, TestAdapters.Azure).ForEnvironment("prod");
        var env = registry.ActiveEnvironment!;
        var set = new AdapterCatalog([new AzureAdapters()]).Build(env, folder);
        await set.Sources.Single(s => s.Name == "inventory").PollAsync(registry, CancellationToken.None);
        var definition = env.Sources.Single(s => s.Name == "platform") with { Connection = null };
        return (new AzureMonitorSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(new SourceContext("prod", definition, null, env.Scope, set.Scope, folder)), registry);
    }

    // The Cosmos-shaped answer: a shared pool of 2000 with two containers on it, one container with 1000 of its own that is throttled hard, and account-level traffic with no container.
    private static Answers Cosmos() => new Answers()
        .Add("TotalRequestUnits", "total", null, ("shared-a", 180000), ("shared-b", 0), ("orders", 300000))
        .Add("ProvisionedThroughput", "maximum", null, ("__Empty", 2000), ("orders", 1000))
        .Add("TotalRequests", "count", null, ("shared-a", 5000), ("shared-b", 3000), ("orders", 200), ("", 50))
        .Add("TotalRequests", "count", "StatusCode eq '429'", ("orders", 100));

    private static RegistryCopy CosmosTown()
    {
        var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "limit: { metric: ProvisionedThroughput, aggregation: maximum }",
            "limit: { metric: ProvisionedThroughput, aggregation: maximum }\n        parts: { by: CollectionName, ownThroughput: { metric: ProvisionedThroughput, aggregation: maximum }, pool: \"__Empty\" }");
        return copy;
    }

    [Fact]
    public async Task A_database_is_read_as_the_shared_pool_plus_each_piece_with_capacity_of_its_own()
    {
        using var copy = CosmosTown();
        var http = new CannedHttp().Respond(r => Reply(r, Cosmos(), "CollectionName"));
        var (source, registry) = await Platform(copy.Path, http);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        var tenant = readings["aa.orders-db"].Tenants!.First();
        var parts = tenant.Parts!;
        Assert.Equal(["", "orders"], parts.Select(p => p.Name));
        var shared = parts.Single(p => p.Kind == PartKind.Shared);
        var orders = parts.Single(p => p.Kind == PartKind.Dedicated);
        // the two containers on the pool are one part: their requests add up and none of them was throttled
        Assert.Equal(0.3, shared.Utilisation!.Value, 6);
        Assert.Equal(0, shared.Throttled);
        Assert.Equal(2000, shared.Limit);
        Assert.Equal(8000.0 / 300, shared.RequestsPerSecond, 6);
        // the container with its own capacity is judged on its own requests: 100 of its 200
        Assert.Equal(1.0, orders.Utilisation!.Value, 6);
        Assert.Equal(0.5, orders.Throttled!.Value, 6);
        Assert.Equal(1000, orders.Limit);
        // the database turns away what its worst part turns away, not a hundred of 8,250 requests
        Assert.Equal(0.5, tenant.Throttled!.Value, 6);
        AdapterContract.AssertReadings(readings, registry);
    }

    [Fact]
    public async Task The_split_costs_no_more_questions_and_keeps_the_filter_of_the_throttled_ones()
    {
        using var copy = CosmosTown();
        var http = new CannedHttp().Respond(r => Reply(r, Cosmos(), "CollectionName"));
        var (source, registry) = await Platform(copy.Path, http);

        await source.PollAsync(registry, CancellationToken.None);

        var accounts = http.Sent.Where(r => r.Uri!.AbsolutePath.Contains("/databaseaccounts/")).ToList();
        string Filter(SentRequest r) => System.Web.HttpUtility.ParseQueryString(r.Uri!.Query)["$filter"]!;
        Assert.All(accounts, r => Assert.EndsWith("CollectionName eq '*'", Filter(r)));
        Assert.Contains(accounts, r => Filter(r) == "StatusCode eq '429' and CollectionName eq '*'");
        // four kinds of question, as for a database read as a whole (the throughput metric the pieces are told apart by is one the limit already asks for)
        Assert.Equal(5 * 4, accounts.Count);
        Assert.All(accounts, r => Assert.Contains("top=1000", r.Uri!.Query));
    }

    [Fact]
    public async Task A_database_without_parts_in_its_entry_is_read_as_before()
    {
        var recording = AzureMonitorSource.ReadRecording(File.ReadAllText(Path.Combine(TownA, "platform.json")));
        var registry = RegistryLoader.Load(TownA, TestAdapters.Azure).ForEnvironment("prod");
        var env = registry.ActiveEnvironment!;
        var set = new AdapterCatalog([new AzureAdapters()]).Build(env, TownA);
        await set.Sources.Single(s => s.Name == "inventory").PollAsync(registry, CancellationToken.None);

        var readings = await set.Sources.Single(s => s.Name == "platform").PollAsync(registry, CancellationToken.None);

        Assert.All(readings["aa.orders-db"].Tenants!, t => Assert.Null(t.Parts));
        Assert.NotEmpty(recording);
    }

    [Fact]
    public async Task A_differently_shaped_entry_reads_its_own_dimension_and_metric_and_names_no_pool()
    {
        using var copy = new RegistryCopy(TownB);
        copy.ReplaceLine("environments/prod.yaml", "throttled: { metric: Http429",
            "        throttled: { metric: Http429, aggregation: count, over: { metric: HttpRequests, aggregation: count } }\n        parts: { by: TableName, ownThroughput: { metric: ReservedThroughput, aggregation: maximum } }");
        var held = new Answers()
            .Add("NormalizedRUConsumption", "maximum", null, ("inbox", 40), ("ledger-hot", 100))
            .Add("ReservedThroughput", "maximum", null, ("ledger-hot", 500))
            .Add("HttpRequests", "count", null, ("inbox", 1000), ("ledger-hot", 100))
            .Add("Http429", "count", null, ("ledger-hot", 60));
        var http = new CannedHttp().Respond(r => Reply(r, held, "TableName"));
        var (source, registry) = await Platform(copy.Path, http);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        var parts = readings["bb.ledger-db"].Tenants!.First().Parts!;
        Assert.Equal(["", "ledger-hot"], parts.Select(p => p.Name));
        Assert.Equal(0.4, parts[0].Utilisation!.Value, 6);
        Assert.Equal(0, parts[0].Throttled);
        Assert.Equal(1.0, parts[1].Utilisation!.Value, 6);
        Assert.Equal(0.6, parts[1].Throttled!.Value, 6);
        Assert.Null(parts[1].Limit); // this entry reads no limit, and a part has none to show
    }

    [Fact]
    public async Task A_metric_with_no_such_dimension_is_read_as_a_whole_so_the_database_still_shows()
    {
        using var copy = CosmosTown();
        var http = new CannedHttp().Respond(r => System.Web.HttpUtility.ParseQueryString(r.Uri!.Query)["$filter"] is { } f && f.Contains("eq '*'")
            ? CannedHttp.Reply("""{"error":{"code":"BadRequest","message":"Dimension not found"}}""", HttpStatusCode.BadRequest)
            : Reply(r, Cosmos(), "CollectionName"));
        var (source, registry) = await Platform(copy.Path, http);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        var tenant = readings["aa.orders-db"].Tenants!.First();
        Assert.Null(tenant.Parts);
        Assert.NotNull(tenant.Utilisation);
    }

    [Fact]
    public void The_parts_entry_is_checked_like_every_other_setting()
    {
        string Error(string parts)
        {
            using var copy = new RegistryCopy(TownA);
            copy.Replace("environments/prod.yaml", "limit: { metric: ProvisionedThroughput, aggregation: maximum }", $"limit: {{ metric: ProvisionedThroughput, aggregation: maximum }}\n        parts: {parts}");
            return Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path, TestAdapters.Azure)).Message;
        }

        Assert.Contains("metrics[1].parts: by is empty", Error("{ by: '', ownThroughput: { metric: ProvisionedThroughput, aggregation: maximum } }"));
        Assert.Contains("metrics[1].parts: ownThroughput is missing", Error("{ by: CollectionName }"));
        var aggregation = Error("{ by: CollectionName, ownThroughput: { metric: ProvisionedThroughput, aggregation: maximun } }");
        Assert.Contains("metrics[1].parts.ownThroughput: aggregation 'maximun'", aggregation);
        Assert.Contains("Did you mean 'maximum'", aggregation);
    }

    // ---- the rules ----

    private const string Store = "aa.orders-db";

    private static IReadOnlyList<PartReading> Parts(double sharedUse, double sharedThrottled, double dedicatedUse, double dedicatedThrottled, string name = "audit-log") =>
        [new PartReading("", PartKind.Shared, sharedUse, sharedThrottled, 5, 2000), new PartReading("entries", PartKind.Dedicated, 0.4, 0, 2, 1000), new PartReading(name, PartKind.Dedicated, dedicatedUse, dedicatedThrottled, 1, 1000)];

    /// <summary>The orders store with one tenant (Acme, a customer; or smoke, a test tenant) reporting these parts, the others reporting calm.</summary>
    private static Snapshot Snap(string tenant, IReadOnlyList<PartReading> parts)
    {
        var registry = RegistryLoader.Load(TestPaths.TenantsTown).ForEnvironment("prod");
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        var tenants = registry.ActiveEnvironment!.Tenants.Select(t => t.Id == tenant
            ? new TenantReading(t.Id, parts.Max(p => p.Utilisation), parts.Max(p => p.Throttled), 10, Limit: 2000, Parts: parts)
            : new TenantReading(t.Id, 0.3, 0, 10, Limit: 2000)).ToList();
        var state = new LatestState();
        state.Update(new Dictionary<string, NodeReading> { [Store] = new NodeReading(clock.GetUtcNow(), true, 2, 2, 0.3, 40, 0, 20, Utilisation: 0.3, Throttled: 0, Tenants: tenants) });
        return new SnapshotBuilder(registry, state, clock) { Environment = "prod" }.Build();
    }

    private static NodeSnapshot Db(Snapshot s) => s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == Store);
    private static TenantUnitSnapshot Unit(Snapshot s, string tenant) => Db(s).Tenants!.Single(u => u.Id == tenant);

    [Fact]
    public void A_dedicated_part_past_the_red_line_makes_the_database_amber_and_names_it_while_the_store_stays_amber()
    {
        var s = Snap("acme", Parts(0.3, 0, 1.0, 0.5));

        var acme = Unit(s, "acme");
        Assert.Equal(HealthState.Degraded, acme.State);
        Assert.Equal([HealthState.Healthy, HealthState.Down, HealthState.Healthy], acme.Parts!.Select(p => p.State));
        // the shared pool first, then the dedicated parts by name
        Assert.Equal(["", "audit-log", "entries"], acme.Parts!.Select(p => p.Name));
        Assert.Equal(PartKind.Shared, acme.Parts![0].Kind);
        Assert.Equal(0.5, acme.Throttled);
        // the store is amber for it, never red: its throttled figure is held under the red line
        var db = Db(s);
        Assert.Equal(HealthState.Degraded, db.State);
        Assert.True(db.Throttled < db.ThrottleRed);
        Assert.Contains("audit-log", db.Reason);
        Assert.Contains("50.0% throttled", db.Reason);
        Assert.DoesNotContain("tenant Acme · shared", db.Reason);
    }

    [Fact]
    public void A_shared_pool_past_the_red_line_makes_the_database_red_and_the_store_red()
    {
        var s = Snap("acme", Parts(1.0, 0.4, 0.3, 0));

        Assert.Equal(HealthState.Down, Unit(s, "acme").State);
        Assert.Equal(PartKind.Shared, Unit(s, "acme").Parts![0].Kind);
        Assert.True(Db(s).Throttled >= Db(s).ThrottleRed);
        Assert.Contains("shared throughput", Db(s).Reason);
    }

    [Fact]
    public void When_every_part_is_red_the_database_is_red()
    {
        var parts = new[] { new PartReading("", PartKind.Shared, 1, 0.3, 1), new PartReading("a", PartKind.Dedicated, 1, 0.4, 1) };

        Assert.Equal(HealthState.Down, Unit(Snap("acme", parts), "acme").State);
    }

    [Fact]
    public void A_database_whose_parts_are_all_fine_is_healthy_and_a_part_at_the_amber_line_is_amber()
    {
        Assert.Equal(HealthState.Healthy, Unit(Snap("acme", Parts(0.3, 0, 0.4, 0)), "acme").State);
        var amber = Unit(Snap("acme", Parts(0.3, 0, 0.4, 0.0012)), "acme");
        Assert.Equal(HealthState.Degraded, amber.State);
        Assert.Equal(HealthState.Degraded, amber.Parts!.Single(p => p.Name == "audit-log").State);
    }

    [Fact]
    public void A_test_tenants_parts_are_amber_at_most_and_the_store_ignores_them()
    {
        var s = Snap("smoke", Parts(1.0, 0.5, 1.0, 0.5));

        var smoke = Unit(s, "smoke");
        Assert.Equal(HealthState.Degraded, smoke.State);
        Assert.DoesNotContain(HealthState.Down, smoke.Parts!.Select(p => p.State));
        Assert.Equal(HealthState.Healthy, Db(s).State); // the store goes by its customers
    }

    [Fact]
    public void A_database_with_no_parts_follows_the_old_rule()
    {
        var registry = RegistryLoader.Load(TestPaths.TenantsTown).ForEnvironment("prod");
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        var state = new LatestState();
        var tenants = registry.ActiveEnvironment!.Tenants.Select(t => new TenantReading(t.Id, 1.0, t.Id == "acme" ? 0.5 : 0, 10)).ToList();
        state.Update(new Dictionary<string, NodeReading> { [Store] = new NodeReading(clock.GetUtcNow(), true, 2, 2, 0.3, 40, 0, 20, Utilisation: 1, Throttled: 0.5, Tenants: tenants) });

        var s = new SnapshotBuilder(registry, state, clock) { Environment = "prod" }.Build();

        Assert.Equal(HealthState.Down, Unit(s, "acme").State);
        Assert.Null(Unit(s, "acme").Parts);
    }

    // ---- the demo source ----

    private static async Task<Snapshot> Demo(string target, params string[] parts)
    {
        using var copy = new RegistryCopy(TestPaths.TenantsTown);
        copy.ReplaceLine("fake.yaml", "aa.orders-db:", $"aa.orders-db:           {{ rps: 100, p99Ms: 20, minInstances: 2, perInstanceRps: 120, parts: [{string.Join(", ", parts)}] }}");
        var registry = RegistryLoader.Load(copy.Path).ForEnvironment("prod");
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        var fake = new FakeSource(FakeProfiles.Load(copy.Path), new FakeOptions(), clock) { Calm = true };
        if (target.Length > 0) fake.Add(target, FakeEffectKind.Saturate, 1);
        var state = new LatestState();
        Snapshot s = null!;
        for (var i = 0; i < 2; i++)
        {
            clock.Advance(TimeSpan.FromSeconds(1));
            state.Update(await fake.PollAsync(registry, default));
            s = new SnapshotBuilder(registry, state, clock) { Environment = "prod" }.Build();
        }
        return s;
    }

    [Fact]
    public async Task The_demo_source_splits_a_database_only_when_its_profile_lists_parts()
    {
        var calm = await Demo("", "entries", "audit-log");

        Assert.All(Db(calm).Tenants!, u =>
        {
            Assert.Equal(["", "audit-log", "entries"], u.Parts!.Select(p => p.Name).Order(StringComparer.Ordinal));
            Assert.Equal(HealthState.Healthy, u.State);
        });
        var bare = await Demo("");
        Assert.NotNull(bare);
    }

    [Fact]
    public async Task Saturating_one_part_throttles_that_part_only_and_leaves_the_database_amber_for_the_tenant_that_has_it()
    {
        var s = await Demo($"{Store}#acme/audit-log", "entries", "audit-log");

        var acme = Unit(s, "acme");
        Assert.Equal(HealthState.Degraded, acme.State);
        Assert.Equal(["audit-log"], acme.Parts!.Where(p => p.State != HealthState.Healthy).Select(p => p.Name));
        Assert.True(acme.Parts!.Single(p => p.Name == "audit-log").Throttled > 0);
        Assert.Equal(0, acme.Parts!.Single(p => p.Kind == PartKind.Shared).Throttled);
        Assert.Equal(HealthState.Healthy, Unit(s, "borealis").State);
        Assert.Equal(HealthState.Degraded, Db(s).State); // amber for it, not red
    }

    [Fact]
    public async Task A_part_aimed_effect_without_a_tenant_hits_that_part_in_every_tenants_database()
    {
        var s = await Demo($"{Store}/audit-log", "entries", "audit-log");

        Assert.All(Db(s).Tenants!.Where(u => u.Kind == TenantKind.Customer), u => Assert.True(u.Parts!.Single(p => p.Name == "audit-log").Throttled > 0));
    }

    [Fact]
    public void An_effect_target_names_its_scope_tenant_and_part()
    {
        var e = new FakeEffect("fx1", "aa.orders-db#acme/audit-log", FakeEffectKind.Saturate, 1);
        Assert.Equal(("aa.orders-db", "acme", "audit-log"), (e.Scope, e.Tenant, e.Part));
        var noTenant = new FakeEffect("fx2", "aa.orders-db/audit-log", FakeEffectKind.Saturate, 1);
        Assert.Equal(("aa.orders-db", null, "audit-log"), (noTenant.Scope, noTenant.Tenant, noTenant.Part));
        var plain = new FakeEffect("fx3", "aa.orders-db#acme", FakeEffectKind.Saturate, 1);
        Assert.Equal(("aa.orders-db", "acme", null), (plain.Scope, plain.Tenant, plain.Part));
    }
}
