using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>The scenario effects the UI tests drive, checked here against the data they produce and the way it calms down again.</summary>
public class FakeEffectsTests
{
    private sealed class Rig
    {
        public readonly FakeTimeProvider Clock = new(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        public readonly Registry Registry = RegistryLoader.Load(TestPaths.MiniTown);
        public readonly LatestState State = new();
        public readonly FakeSource Fake;
        public readonly SnapshotBuilder Builder;

        public Rig()
        {
            Fake = new FakeSource(FakeProfiles.Load(TestPaths.MiniTown), new FakeOptions(), Clock) { Calm = true };
            Builder = new SnapshotBuilder(Registry, State, Clock) { StaleAfter = TimeSpan.FromSeconds(3) };
        }

        public async Task<Snapshot> Tick(int seconds = 1)
        {
            Clock.Advance(TimeSpan.FromSeconds(seconds));
            State.Update(await Fake.PollAsync(Registry, default));
            return Builder.Build();
        }

        public async Task<Snapshot> Run(int seconds)
        {
            Snapshot s = null!;
            for (var i = 0; i < seconds; i++) s = await Tick();
            return s;
        }
    }

    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == id);

    [Fact]
    public async Task The_mini_town_is_calm_and_healthy_at_the_start()
    {
        var s = await new Rig().Run(3);

        Assert.All(s.Groups.SelectMany(g => g.Nodes), n => Assert.Equal(HealthState.Healthy, n.State));
        Assert.Equal(2, Node(s, "aa.orders-api").InstancesTotal);
    }

    [Fact]
    public async Task A_stale_source_ages_the_node_into_stale_and_recovers_when_it_answers_again()
    {
        var rig = new Rig();
        await rig.Run(2);
        var fx = rig.Fake.Add("aa.orders-api", FakeEffectKind.Stale, 1);

        var s = await rig.Run(5);
        Assert.Equal(HealthState.Stale, Node(s, "aa.orders-api").State);
        Assert.Equal(HealthState.Healthy, Node(s, "aa.orders-db").State); // only the target goes quiet

        rig.Fake.Remove(fx.Id);
        s = await rig.Tick();
        Assert.Equal(HealthState.Healthy, Node(s, "aa.orders-api").State);
    }

    [Fact]
    public async Task Saturating_a_database_throttles_it_and_the_town_calms_after_reset()
    {
        var rig = new Rig();
        await rig.Run(2);
        rig.Fake.Add("bb.ledger-db", FakeEffectKind.Saturate, 1);

        var db = Node(await rig.Tick(), "bb.ledger-db");
        Assert.True(db.Throttled >= db.ThrottleRed, $"throttled {db.Throttled}");

        rig.Fake.Reset();
        db = Node(await rig.Tick(), "bb.ledger-db");
        Assert.Equal(HealthState.Healthy, db.State);
        Assert.True(db.Throttled < db.ThrottleAmber);
    }

    [Fact]
    public async Task A_backlog_builds_and_poison_fills_the_dead_letter_queue_until_reset()
    {
        var rig = new Rig();
        await rig.Run(2);
        rig.Fake.Add("cc.notify-worker", FakeEffectKind.Backlog, 1);
        rig.Fake.Add("aa.orders-worker", FakeEffectKind.Poison, 1);

        var s = await rig.Run(12);
        var slow = Node(s, "cc.notify-worker");
        Assert.True(slow.QueueDepth > 50, $"queue {slow.QueueDepth}");
        Assert.True(slow.OldestMessageSeconds >= slow.BacklogAmber, $"oldest {slow.OldestMessageSeconds}");
        Assert.Equal(HealthState.Degraded, slow.State);
        Assert.True(Node(s, "aa.orders-worker").DeadLetters > 20);

        rig.Fake.Reset();
        s = await rig.Tick();
        Assert.Equal(0, Node(s, "aa.orders-worker").DeadLetters);
        Assert.Equal(HealthState.Healthy, Node(s, "cc.notify-worker").State);
    }

    [Fact]
    public async Task Without_a_reset_the_backlog_drains_but_dead_letters_stay_until_someone_clears_them()
    {
        var rig = new Rig();
        await rig.Run(2);
        var backlog = rig.Fake.Add("cc.notify-worker", FakeEffectKind.Backlog, 1);
        var poison = rig.Fake.Add("cc.notify-worker", FakeEffectKind.Poison, 1);
        await rig.Run(10);
        rig.Fake.Remove(backlog.Id);
        rig.Fake.Remove(poison.Id);

        var s = await rig.Run(60);

        var w = Node(s, "cc.notify-worker");
        Assert.Equal(HealthState.Healthy, w.State); // the late consumer caught up
        Assert.True(w.DeadLetters > 0); // parked messages do not go away by themselves
    }
}
