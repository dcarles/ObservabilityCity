using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Validate;

namespace ObservabilityCity.Tests;

/// <summary>
/// What a database runs on: the company lists its engines in town.yaml (each one of the fixed types), a database says <c>engine: id</c>, and the snapshot
/// carries the engine's name and type. The town's own island order lives in town.yaml too.
/// </summary>
public class DatabaseEngineTests
{
    private const string Engines = "databaseEngines:\n  cosmos: { name: Cosmos DB, type: document }\n  sqlserver: { name: SQL Server, type: relational }\n";

    private static RegistryCopy MiniWithEngines(string aaEngine = "cosmos")
    {
        var f = new RegistryCopy(TestPaths.MiniTown);
        f.Write("town.yaml", f.Read("town.yaml").TrimEnd() + "\n" + Engines);
        f.Replace("pillars/aa.yaml", "name: Orders DB, role: db", $"name: Orders DB, role: db, engine: {aaEngine}");
        return f;
    }

    [Fact]
    public void The_fixed_types_are_the_eight_the_town_can_tell_apart()
    {
        Assert.Equal(["relational", "document", "key-value", "wide-column", "graph", "time-series", "analytical", "vector"], DatabaseTypes.All);
        Assert.All(DatabaseTypes.All, t => Assert.False(string.IsNullOrWhiteSpace(DatabaseTypes.Names[t])));
    }

    [Fact]
    public void A_database_takes_its_engine_name_and_type_from_the_towns_list()
    {
        using var f = MiniWithEngines();

        var registry = RegistryLoader.Load(f.Path);
        var db = registry.AllNodes.Single(n => n.Id == "aa.orders-db");

        Assert.Equal(["cosmos", "sqlserver"], registry.DatabaseEngines.Select(e => e.Id));
        Assert.Equal(new DatabaseEngine("cosmos", "Cosmos DB", "document"), registry.EngineOf(db));
        Assert.Null(registry.EngineOf(registry.AllNodes.Single(n => n.Id == "bb.ledger-db"))); // names none: no label, no error
    }

    [Fact]
    public void A_town_that_lists_no_engines_loads_as_before()
    {
        var registry = RegistryLoader.Load(TestPaths.MiniTown);

        Assert.Empty(registry.DatabaseEngines);
        Assert.All(registry.AllNodes, n => Assert.Null(n.Engine));
    }

    [Fact]
    public void An_engine_the_town_does_not_list_is_an_error_that_suggests_the_real_one()
    {
        using var f = MiniWithEngines("cosmosdb");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(f.Path));

        Assert.Contains("aa.yaml", e.Message);
        Assert.Contains("engine 'cosmosdb' of 'aa.orders-db' is not in town.yaml databaseEngines", e.Message);
        Assert.Contains("Did you mean 'cosmos'?", e.Message);
    }

    [Fact]
    public void An_engine_without_a_list_in_the_town_says_where_to_put_it()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/aa.yaml", "name: Orders DB, role: db", "name: Orders DB, role: db, engine: cosmos");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(f.Path));

        Assert.Contains("town.yaml defines no databaseEngines", e.Message);
    }

    [Fact]
    public void Only_a_database_runs_on_an_engine()
    {
        using var f = MiniWithEngines();
        f.Replace("pillars/aa.yaml", "role: api", "role: api, engine: cosmos");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(f.Path));

        Assert.Contains("only a database (role: db) runs on one", e.Message);
    }

    [Theory]
    [InlineData("  cosmos: { name: Cosmos DB, type: documents }\n", "type 'documents', which is not a database type", "Did you mean 'document'?")]
    [InlineData("  cosmos: { name: Cosmos DB, type: search }\n", "type 'search', which is not a database type", "relational, document, key-value")]
    [InlineData("  cosmos: { name: '', type: document }\n", "needs a name", "town.yaml")]
    [InlineData("  Cosmos_DB: { name: Cosmos DB, type: document }\n", "must be lowercase kebab-case", "town.yaml")]
    public void A_badly_written_engine_in_the_town_is_an_error_even_in_a_running_app(string entry, string expected, string hint)
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Write("town.yaml", f.Read("town.yaml").TrimEnd() + "\ndatabaseEngines:\n" + entry);

        var strict = Assert.Throws<RegistryException>(() => RegistryLoader.Load(f.Path));
        var resilient = Assert.Throws<RegistryException>(() => RegistryLoader.LoadResilient(f.Path));

        Assert.Contains(expected, strict.Message);
        Assert.Contains(hint, strict.Message);
        Assert.Contains(expected, resilient.Message);
    }

    [Fact]
    public void A_bad_engine_in_a_pillar_skips_that_pillar_in_a_running_app_and_the_rest_carries_on()
    {
        using var f = MiniWithEngines("nonsense");

        var registry = RegistryLoader.LoadResilient(f.Path);

        Assert.NotNull(registry.Groups.Single(g => g.Id == "aa").ConfigError);
        Assert.Null(registry.Groups.Single(g => g.Id == "bb").ConfigError);
    }

    [Fact]
    public void The_validator_warns_about_a_database_with_no_engine_once_the_town_lists_engines()
    {
        using var f = MiniWithEngines();

        var r = RegistryValidator.Validate(f.Path);

        var hits = r.Findings.Where(x => x.Rule == "db-engine").ToList();
        Assert.Equal(3, hits.Count); // bb.ledger-db, cc.notify-db and the hub's database; aa.orders-db has one
        Assert.All(hits, h => Assert.Equal(Severity.Warning, h.Severity));
        Assert.Contains(hits, h => h.Message.Contains("'bb.ledger-db'") && h.Message.Contains("cosmos, sqlserver"));
        Assert.DoesNotContain(hits, h => h.Message.Contains("aa.orders-db"));
    }

    [Fact]
    public void The_validator_is_quiet_about_engines_in_a_town_that_lists_none()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);

        Assert.DoesNotContain(RegistryValidator.Validate(f.Path).Findings, x => x.Rule == "db-engine");
    }

    [Fact]
    public async Task The_snapshot_names_the_engine_and_its_type_for_a_database_and_for_nothing_else()
    {
        using var f = MiniWithEngines();
        var registry = RegistryLoader.Load(f.Path);
        var clock = new FakeTimeProvider();
        var state = new LatestState();
        var fake = new FakeSource(FakeProfiles.Load(f.Path), new FakeOptions(), clock);
        clock.Advance(TimeSpan.FromSeconds(1));
        state.Update(await fake.PollAsync(registry, TestContext.Current.CancellationToken));

        var s = new SnapshotBuilder(registry, state, clock).Build();
        var nodes = s.Groups.SelectMany(g => g.Nodes).ToDictionary(n => n.Id);

        Assert.Equal(new DatabaseEngineSnapshot("cosmos", "Cosmos DB", "document", "Document"), nodes["aa.orders-db"].Engine);
        Assert.Null(nodes["bb.ledger-db"].Engine);
        Assert.All(nodes.Values.Where(n => n.Kind != NodeKind.Database), n => Assert.Null(n.Engine));
    }

    [Fact]
    public void The_config_drawer_lists_the_engine_of_a_database()
    {
        using var f = MiniWithEngines();
        var registry = RegistryLoader.Load(f.Path);
        var db = registry.AllNodes.Single(n => n.Id == "aa.orders-db");

        var rows = SystemDetails.Config(db);

        Assert.Contains(rows, r => r.Key == "engine" && r.Value == "cosmos");
    }

    [Fact]
    public void Island_order_and_ring_size_are_read_from_town_yaml()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("town.yaml", "islands: [aa, bb, cc]", "islands: [cc, aa, bb]\nringCapacity: 6");

        var registry = RegistryLoader.Load(f.Path);

        Assert.Equal(["cc", "aa", "bb"], registry.Groups.Where(g => !g.IsHub).Select(g => g.Id));
        Assert.Equal(6, registry.RingCapacity);
    }
}
