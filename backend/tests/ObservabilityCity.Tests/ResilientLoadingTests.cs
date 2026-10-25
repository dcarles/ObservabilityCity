using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>A broken registry file must not take the town down: it is skipped and shown, and the rest keeps rendering.</summary>
public class ResilientLoadingTests
{
    private static GroupSnapshot Group(Snapshot s, string id) => s.Groups.Single(g => g.Id == id);

    [Fact]
    public void A_pillar_with_an_unknown_role_is_skipped_and_the_rest_loads()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/bb.yaml", "role: worker", "role: castle");

        Assert.Throws<RegistryException>(() => RegistryLoader.Load(f.Path)); // strict load still refuses it

        var registry = RegistryLoader.LoadResilient(f.Path);
        var bb = registry.Groups.Single(g => g.Id == "bb");
        Assert.Empty(bb.Nodes);
        Assert.Contains("castle", bb.ConfigError);
        Assert.Equal(["aa", "bb", "cc"], registry.Groups.Where(g => !g.IsHub).Select(g => g.Id)); // still in layout order
        Assert.Equal(3, registry.Groups.Single(g => g.Id == "aa").Nodes.Count);
        Assert.Equal(3, registry.Groups.Single(g => g.Id == "cc").Nodes.Count);
        Assert.Contains(registry.Notices, n => n.Contains("bb.yaml was skipped"));
    }

    [Fact]
    public void A_pillar_file_that_is_not_valid_yaml_is_skipped()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Write("pillars/cc.yaml", "pillar: cc\nsystems: [this is: not : valid\n  - nope");

        var registry = RegistryLoader.LoadResilient(f.Path);

        Assert.NotNull(registry.Groups.Single(g => g.Id == "cc").ConfigError);
        Assert.Equal(3, registry.Groups.Single(g => g.Id == "aa").Nodes.Count);
    }

    [Fact]
    public void A_misspelt_key_is_a_config_error_for_that_pillar_only()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/aa.yaml", "calls: [aa.orders-db] }\n  - { id: aa.orders-worker", "cals: [aa.orders-db] }\n  - { id: aa.orders-worker");

        var registry = RegistryLoader.LoadResilient(f.Path);

        Assert.Contains("cals", registry.Groups.Single(g => g.Id == "aa").ConfigError);
        Assert.Null(registry.Groups.Single(g => g.Id == "bb").ConfigError);
    }

    [Fact]
    public void A_skipped_pillars_ids_are_released_and_calls_into_it_are_dropped_quietly()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        // bb is fine on its own, but calls into aa, which is broken
        f.Replace("pillars/aa.yaml", "role: db", "role: nonsense");
        f.Replace("pillars/bb.yaml", "calls: [bb.ledger-db] }\n  - { id: bb.ledger-worker", "calls: [bb.ledger-db, aa.orders-api] }\n  - { id: bb.ledger-worker");

        var registry = RegistryLoader.LoadResilient(f.Path);

        Assert.DoesNotContain(registry.AllNodes, n => n.Id.StartsWith("aa."));
        var api = registry.AllNodes.Single(n => n.Id == "bb.ledger-api");
        Assert.Equal(["bb.ledger-db"], api.Calls);
        Assert.DoesNotContain(registry.Notices, n => n.Contains("bb.ledger-api")); // not bb's fault
        // the external caller that reached aa's front door loses that link and nothing else
        Assert.Equal(["bb.ledger-api"], registry.ExternalCallers.Single(c => c.Id == "mobile-app").Calls);
    }

    [Fact]
    public void A_call_to_a_system_that_does_not_exist_is_dropped_with_a_notice()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/bb.yaml", "calls: [bb.ledger-db] }\n  - { id: bb.ledger-worker", "calls: [bb.ledger-db, bb.missing] }\n  - { id: bb.ledger-worker");

        var registry = RegistryLoader.LoadResilient(f.Path);

        Assert.Null(registry.Groups.Single(g => g.Id == "bb").ConfigError);
        Assert.Equal(["bb.ledger-db"], registry.AllNodes.Single(n => n.Id == "bb.ledger-api").Calls);
        Assert.Contains(registry.Notices, n => n.Contains("bb.missing"));
        Assert.Contains(registry.Problems, n => n.Contains("bb.missing"));
    }

    [Fact]
    public void An_island_listed_in_layout_with_no_file_is_a_notice_not_a_failure()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("layout.yaml", "[aa, bb, cc]", "[aa, bb, cc, dd]");

        var registry = RegistryLoader.LoadResilient(f.Path);

        Assert.Equal(3, registry.Groups.Count(g => !g.IsHub));
        Assert.Contains(registry.Notices, n => n.Contains("dd"));
    }

    [Fact]
    public void A_healthy_registry_has_no_notices()
    {
        var registry = RegistryLoader.LoadResilient(TestPaths.Stress24);

        Assert.Empty(registry.Notices);
        Assert.Empty(registry.Problems);
    }

    [Theory]
    [InlineData("town.yaml")]
    [InlineData("hub.yaml")]
    [InlineData("layout.yaml")]
    public void The_files_every_pillar_depends_on_must_be_sound(string file)
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Write(file, "bogus: [unclosed\n");

        Assert.Throws<RegistryException>(() => RegistryLoader.LoadResilient(f.Path));
    }

    [Fact]
    public void A_failed_reload_keeps_the_last_good_registry_and_says_so()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        var holder = new RegistryHolder(RegistryLoader.LoadResilient(f.Path));
        var reloader = new RegistryReloader(holder, f.Path, TimeSpan.Zero, NullLogger<RegistryReloader>.Instance);
        var good = holder.Current;

        f.Write("hub.yaml", "this is: [not valid");
        Assert.False(reloader.Reload());

        Assert.Same(good, holder.Current);
        Assert.Contains(holder.Notices, n => n.StartsWith("Reload failed, still showing the last good registry"));

        f.Write("hub.yaml", File.ReadAllText(Path.Combine(TestPaths.MiniTown, "hub.yaml")));
        Assert.True(reloader.Reload());
        Assert.NotSame(good, holder.Current);
        Assert.Empty(holder.Notices);
    }

    [Fact]
    public void A_reload_picks_up_a_new_system_and_a_newly_broken_pillar()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        var holder = new RegistryHolder(RegistryLoader.LoadResilient(f.Path));
        var reloader = new RegistryReloader(holder, f.Path, TimeSpan.Zero, NullLogger<RegistryReloader>.Instance);

        f.Replace("pillars/cc.yaml", "role: db }", "role: db }\n  - { id: cc.extra-cache, name: Extra, role: cache }");
        f.Replace("pillars/bb.yaml", "role: db }", "role: dbb }");
        Assert.True(reloader.Reload());

        Assert.Contains(holder.Current.AllNodes, n => n.Id == "cc.extra-cache");
        Assert.NotNull(holder.Current.Groups.Single(g => g.Id == "bb").ConfigError);
    }

    [Fact]
    public async Task The_snapshot_shows_the_config_error_island_and_the_notices_while_the_rest_stays_live()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/bb.yaml", "role: worker", "role: castle");
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        var holder = new RegistryHolder(RegistryLoader.LoadResilient(f.Path));
        var fake = new FakeSource(FakeProfiles.Load(f.Path), new FakeOptions(), clock) { Calm = true };
        var state = new LatestState();
        var builder = new SnapshotBuilder(holder, state, clock);

        clock.Advance(TimeSpan.FromSeconds(1));
        state.Update(await fake.PollAsync(holder.Current, TestContext.Current.CancellationToken));
        var snapshot = builder.Build();

        var bb = Group(snapshot, "bb");
        Assert.NotNull(bb.ConfigError);
        Assert.Empty(bb.Nodes);
        Assert.All(Group(snapshot, "aa").Nodes, n => Assert.Equal(HealthState.Healthy, n.State));
        Assert.Contains(snapshot.Notices, n => n.Contains("bb.yaml"));
        Assert.Equal(0, snapshot.Totals.Down);
    }

    [Fact]
    public async Task The_publisher_keeps_going_after_a_tick_that_fails()
    {
        var clock = new FakeTimeProvider();
        var registry = RegistryLoader.LoadResilient(TestPaths.MiniTown);
        var builder = new SnapshotBuilder(registry, new LatestState(), clock);
        var store = new SnapshotStore();
        var notifier = new FlakyNotifier();
        using var publisher = new SnapshotPublisher(builder, store, notifier, TimeSpan.FromMilliseconds(20));

        await publisher.StartAsync(TestContext.Current.CancellationToken);
        await WaitFor(() => notifier.Published >= 3);
        await publisher.StopAsync(TestContext.Current.CancellationToken);

        Assert.True(notifier.Failed >= 1);
        Assert.True(notifier.Published >= 3);
        Assert.NotNull(store.Latest);
    }

    private static async Task WaitFor(Func<bool> condition)
    {
        for (var i = 0; i < 200 && !condition(); i++) await Task.Delay(25);
        Assert.True(condition(), "timed out");
    }

    private sealed class FlakyNotifier : ISnapshotNotifier
    {
        public int Published, Failed;

        public Task PublishAsync(Snapshot snapshot, CancellationToken ct)
        {
            if (Interlocked.Increment(ref Published) == 1)
            {
                Interlocked.Increment(ref Failed);
                throw new InvalidOperationException("the first publish fails");
            }
            return Task.CompletedTask;
        }
    }
}
