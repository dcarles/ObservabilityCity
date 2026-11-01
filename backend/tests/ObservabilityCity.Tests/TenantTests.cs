using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>
/// Tenant databases. A store with a tenantPattern keeps one database for each tenant of the environment, and its snapshot carries one unit for
/// each: its own utilisation, throttling and state. A test tenant raises amber at most; a tenant the data shows but the environment does not list
/// is "unknown". The store's own numbers follow the tenants that count.
/// </summary>
public class TenantTests
{
    private const string Store = "aa.orders-db";

    private sealed class Rig
    {
        public readonly FakeTimeProvider Clock = new(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        public readonly Registry Registry;
        public readonly LatestState State = new();
        public readonly FakeSource Fake;
        public readonly SnapshotBuilder Builder;

        public Rig(string environment)
        {
            Registry = RegistryLoader.Load(TestPaths.TenantsTown).ForEnvironment(environment);
            Fake = new FakeSource(FakeProfiles.Load(TestPaths.TenantsTown), new FakeOptions(), Clock) { Calm = true };
            Builder = new SnapshotBuilder(Registry, State, Clock) { Environment = environment };
        }

        public async Task<Snapshot> Run(int seconds = 2)
        {
            Snapshot s = null!;
            for (var i = 0; i < seconds; i++)
            {
                Clock.Advance(TimeSpan.FromSeconds(1));
                State.Update(await Fake.PollAsync(Registry, default));
                s = Builder.Build();
            }
            return s;
        }
    }

    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == id);
    private static TenantUnitSnapshot Unit(Snapshot s, string tenant, string store = Store) => Node(s, store).Tenants!.Single(u => u.Id == tenant);

    [Fact]
    public async Task A_tenant_store_has_one_unit_for_each_tenant_in_the_environments_order()
    {
        var s = await new Rig("prod").Run();

        var units = Node(s, Store).Tenants!;
        Assert.Equal(["acme", "borealis", "cygnus", "smoke"], units.Select(u => u.Id));
        Assert.Equal([TenantKind.Customer, TenantKind.Customer, TenantKind.Customer, TenantKind.Test], units.Select(u => u.Kind));
        Assert.Equal("Acme", units[0].Name);
        Assert.All(units, u => Assert.Equal(HealthState.Healthy, u.State));
        Assert.All(units, u => Assert.InRange(u.Utilisation!.Value, 0.05, 0.9));
    }

    [Fact]
    public async Task The_database_name_is_the_pattern_with_the_tenant_in_it()
    {
        var s = await new Rig("prod").Run();

        Assert.Equal("merchant-acme-db", Unit(s, "acme").Database);
        Assert.Equal("bill-cygnus", Unit(s, "cygnus", "bb.billing-db").Database);
    }

    [Fact]
    public async Task Only_stores_with_a_pattern_have_units()
    {
        var s = await new Rig("prod").Run();

        Assert.NotNull(Node(s, "bb.billing-db").Tenants);
        Assert.Null(Node(s, "bb.shared-db").Tenants);
        Assert.Null(Node(s, "hub.customer-db").Tenants);
        Assert.Null(Node(s, "aa.orders-api").Tenants);
    }

    [Fact]
    public async Task Each_environment_has_its_own_tenants()
    {
        var dev = await new Rig("dev").Run();
        var staging = await new Rig("staging").Run();

        Assert.Equal(["dev-one", "dev-two", "dev-three"], Node(dev, Store).Tenants!.Select(u => u.Id));
        Assert.Equal(["acme", "borealis", "qa", "smoke", "ghost-co"], Node(staging, Store).Tenants!.Select(u => u.Id));
    }

    [Fact]
    public async Task A_tenant_the_environment_does_not_list_is_unknown_and_stands_last()
    {
        var s = await new Rig("staging").Run();

        var ghost = Unit(s, "ghost-co");
        Assert.Equal(TenantKind.Unknown, ghost.Kind);
        Assert.Equal("ghost-co", ghost.Name);
        Assert.Equal("merchant-ghost-co-db", ghost.Database);
        Assert.Equal(TenantKind.Unknown, Node(s, Store).Tenants!.Last().Kind);
        Assert.Contains(s.Tenants, t => t.Id == "ghost-co" && t.Kind == TenantKind.Unknown);
    }

    [Fact]
    public async Task A_listed_tenant_whose_database_is_not_found_is_grey()
    {
        var rig = new Rig("prod");
        await rig.Run();
        // the source stops finding the database of one tenant
        var reading = rig.State.Get(Store)!;
        rig.State.Update(new Dictionary<string, NodeReading> { [Store] = reading with { At = rig.Clock.GetUtcNow(), Tenants = reading.Tenants!.Where(t => t.TenantId != "cygnus").ToList() } });

        var s = rig.Builder.Build();

        var missing = Unit(s, "cygnus");
        Assert.Equal(HealthState.Stale, missing.State);
        Assert.Null(missing.Utilisation);
        Assert.Equal(HealthState.Healthy, Unit(s, "acme").State);
        Assert.Equal(HealthState.Healthy, Node(s, Store).State); // one missing database is not an outage of the store
    }

    [Fact]
    public async Task A_store_with_no_fresh_data_shows_every_tenant_grey()
    {
        var rig = new Rig("prod");
        await rig.Run();
        rig.Fake.Add(Store, FakeEffectKind.Stale, 1);
        rig.Clock.Advance(TimeSpan.FromSeconds(1));
        rig.State.Update(await rig.Fake.PollAsync(rig.Registry, default));
        rig.Clock.Advance(TimeSpan.FromSeconds(40));

        var node = Node(rig.Builder.Build(), Store);

        Assert.Equal(HealthState.Stale, node.State);
        Assert.Equal(4, node.Tenants!.Count);
        Assert.All(node.Tenants, u => Assert.Equal(HealthState.Stale, u.State));
    }

    // ── trouble ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task Saturating_one_tenants_database_throttles_that_tenant_only()
    {
        var rig = new Rig("prod");
        rig.Fake.Add($"{Store}#acme", FakeEffectKind.Saturate, 1);

        var s = await rig.Run();

        var acme = Unit(s, "acme");
        Assert.True(acme.Throttled > 0);
        Assert.Equal(HealthState.Down, acme.State); // a customer past the red thresholds is red
        // the store itself is only amber and counts as degraded, never down: the top bar and the lists both go by this
        Assert.Equal(HealthState.Degraded, s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == Store).State);
        Assert.Equal(0, s.Totals.Down);
        Assert.All(new[] { "borealis", "cygnus", "smoke" }, id =>
        {
            Assert.Equal(0, Unit(s, id).Throttled);
            Assert.Equal(HealthState.Healthy, Unit(s, id).State);
        });
        // the store follows its worst customer
        var store = Node(s, Store);
        Assert.Equal(acme.Utilisation, store.Utilisation);
        Assert.Equal(acme.Throttled, store.Throttled);
        Assert.Equal(HealthState.Degraded, store.State);
    }

    [Fact]
    public async Task Saturating_the_store_for_everyone_hits_every_tenant()
    {
        var rig = new Rig("prod");
        rig.Fake.Add(Store, FakeEffectKind.Saturate, 1);

        var s = await rig.Run();

        Assert.All(Node(s, Store).Tenants!, u => Assert.True(u.Throttled > 0, u.Id));
    }

    [Fact]
    public async Task A_tenant_aimed_effect_in_every_store_hits_that_tenant_in_each()
    {
        var rig = new Rig("prod");
        rig.Fake.Add("*#cygnus", FakeEffectKind.Saturate, 1);

        var s = await rig.Run();

        Assert.True(Unit(s, "cygnus").Throttled > 0);
        Assert.True(Unit(s, "cygnus", "bb.billing-db").Throttled > 0);
        Assert.Equal(0, Unit(s, "acme").Throttled);
        Assert.Null(Node(s, "bb.shared-db").Tenants); // a store without tenants has no tenant to hit
        Assert.Equal(HealthState.Healthy, Node(s, "bb.shared-db").State);
    }

    [Fact]
    public async Task A_test_tenant_in_trouble_is_amber_never_red_and_does_not_turn_the_store_red()
    {
        var rig = new Rig("prod");
        rig.Fake.Add($"{Store}#smoke", FakeEffectKind.Saturate, 1);

        var s = await rig.Run();

        var smoke = Unit(s, "smoke");
        Assert.True(smoke.Throttled > Node(s, Store).ThrottleRed); // it is past the red threshold...
        Assert.Equal(HealthState.Degraded, smoke.State); // ...and still only amber
        var store = Node(s, Store); // the store goes by its customers, so it stays calm
        Assert.Equal(HealthState.Healthy, store.State);
        Assert.Equal(0, store.Throttled);
    }

    [Fact]
    public async Task Where_there_are_only_test_tenants_the_store_turns_amber_and_never_red()
    {
        var rig = new Rig("dev");
        rig.Fake.Add(Store, FakeEffectKind.Saturate, 1);

        var s = await rig.Run();

        var store = Node(s, Store);
        Assert.Equal(HealthState.Degraded, store.State);
        Assert.True(store.Throttled >= store.ThrottleAmber);
        Assert.True(store.Throttled < store.ThrottleRed);
        Assert.True(store.Utilisation < store.ResourceRed);
        Assert.All(store.Tenants!, u => Assert.Equal(HealthState.Degraded, u.State));
    }

    [Fact]
    public async Task An_unknown_tenant_counts_with_the_customers()
    {
        var rig = new Rig("staging");
        rig.Fake.Add($"{Store}#ghost-co", FakeEffectKind.Saturate, 1);

        var s = await rig.Run();

        Assert.Equal(HealthState.Down, Unit(s, "ghost-co").State);
        Assert.Equal(HealthState.Degraded, Node(s, Store).State);
    }

    [Fact]
    public void Only_saturation_can_be_aimed_at_one_tenant()
    {
        var fake = new FakeSource(new Dictionary<string, FakeProfile>(), new FakeOptions(), TimeProvider.System);

        Assert.Throws<ArgumentException>(() => fake.Add($"{Store}#acme", FakeEffectKind.Errors, 1));
        Assert.Throws<ArgumentException>(() => fake.Add($"{Store}#", FakeEffectKind.Saturate, 1));
        Assert.Throws<ArgumentException>(() => fake.Add("#acme", FakeEffectKind.Saturate, 1));
        var ok = fake.Add($"{Store}#acme", FakeEffectKind.Saturate, 1);
        Assert.Equal((Store, "acme"), (ok.Scope, ok.Tenant));
    }

    // ── tenants in the town ───────────────────────────────────────────────────

    [Fact]
    public async Task The_town_lists_its_tenants_and_the_share_of_traffic_each_brings()
    {
        var s = await new Rig("prod").Run();

        Assert.Equal(["acme", "borealis", "cygnus", "smoke"], s.Tenants.Select(t => t.Id));
        Assert.Equal(1.0, s.Tenants.Sum(t => t.Share), 6);
        var smoke = s.Tenants.Single(t => t.Id == "smoke");
        Assert.True(smoke.Share < 0.05, "a test tenant brings next to no traffic");
        Assert.All(s.Tenants.Where(t => t.Kind == TenantKind.Customer), t => Assert.InRange(t.Share, 0.2, 0.5));
    }

    [Fact]
    public async Task Until_a_database_reports_the_shares_are_even_and_a_test_tenant_counts_a_tenth()
    {
        var rig = new Rig("prod");
        rig.Clock.Advance(TimeSpan.FromSeconds(1)); // nothing polled yet

        var s = rig.Builder.Build();

        Assert.Equal(1.0, s.Tenants.Sum(t => t.Share), 6);
        Assert.Equal(s.Tenants.Single(t => t.Id == "acme").Share / 10, s.Tenants.Single(t => t.Id == "smoke").Share, 6);
    }

    [Fact]
    public async Task A_town_without_tenants_lists_none()
    {
        var registry = RegistryLoader.Load(TestPaths.MiniTown);
        var clock = new FakeTimeProvider();
        var state = new LatestState();
        var fake = new FakeSource(FakeProfiles.Load(TestPaths.MiniTown), new FakeOptions(), clock);
        clock.Advance(TimeSpan.FromSeconds(1));
        state.Update(await fake.PollAsync(registry, default));

        var s = new SnapshotBuilder(registry, state, clock).Build();

        Assert.Empty(s.Tenants);
        Assert.Equal(["demo"], s.Environments.Select(e => e.Id));
        Assert.Equal("demo", s.Environment);
    }

    [Fact]
    public async Task A_snapshot_names_its_environment_and_lists_all_of_them()
    {
        var s = await new Rig("staging").Run();

        Assert.Equal("staging", s.Environment);
        Assert.Equal("Staging", s.EnvironmentName);
        Assert.Equal(["dev", "staging", "prod"], s.Environments.Select(e => e.Id));
        Assert.Equal(["prod"], s.Environments.Where(e => e.IsDefault).Select(e => e.Id));
    }

    [Fact]
    public async Task An_island_that_is_not_deployed_is_not_in_that_environments_snapshot()
    {
        var dev = await new Rig("dev").Run();
        var prod = await new Rig("prod").Run();

        Assert.DoesNotContain(dev.Groups, g => g.Id == "bb");
        Assert.Contains(prod.Groups, g => g.Id == "bb");
        Assert.DoesNotContain(dev.Groups.SelectMany(g => g.Nodes), n => n.Id == "aa.tools-cron");
    }

    // ── the same numbers on both sides ────────────────────────────────────────

    /// <summary>The frontend's unit tests read this file too, so both sides agree on what the tenant yard shows.</summary>
    [Fact]
    public async Task The_tenants_town_snapshot_matches_the_golden_fixture()
    {
        var rig = new Rig("staging");
        rig.Fake.Add($"{Store}#acme", FakeEffectKind.Saturate, 1);
        rig.Fake.Add($"{Store}#qa", FakeEffectKind.Saturate, 1);
        rig.Fake.Add($"{Store}#ghost-co", FakeEffectKind.Saturate, 0.4);
        var snapshot = await rig.Run();

        var actual = System.Text.Json.JsonSerializer.Serialize(snapshot, Golden.Json).ReplaceLineEndings("\n");
        var path = Path.Combine(TestPaths.Fixtures, "tenants-town.json");
        if (Environment.GetEnvironmentVariable("UPDATE_GOLDEN") == "1" || !File.Exists(path))
            File.WriteAllText(path, actual + "\n");
        Assert.Equal(File.ReadAllText(path).ReplaceLineEndings("\n").TrimEnd(), actual.TrimEnd());
    }
}

internal static class Golden
{
    public static readonly System.Text.Json.JsonSerializerOptions Json = new(System.Text.Json.JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowNamedFloatingPointLiterals,
    };
}
