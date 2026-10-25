using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>The biggest town the design allows: 24 islands, from 2 systems to 25 on one island.</summary>
public class StressTownTests
{
    private static readonly int[] Sizes = [2, 25, 3, 18, 5, 12, 4, 22, 6, 9, 2, 15, 7, 20, 3, 11, 8, 25, 4, 14, 6, 10, 2, 16];

    private sealed class Rig
    {
        public readonly FakeTimeProvider Clock = new(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        public readonly Registry Registry = RegistryLoader.Load(TestPaths.Stress24);
        public readonly LatestState State = new();
        public readonly FakeSource Fake;
        public readonly SnapshotBuilder Builder;

        public Rig()
        {
            Fake = new FakeSource(FakeProfiles.Load(TestPaths.Stress24), new FakeOptions(), Clock);
            Builder = new SnapshotBuilder(Registry, State, Clock) { DayFraction = () => Fake.DayFraction };
        }

        public async Task<Snapshot> Tick(int seconds = 1)
        {
            Clock.Advance(TimeSpan.FromSeconds(seconds));
            State.Update(await Fake.PollAsync(Registry, default));
            return Builder.Build();
        }
    }

    [Fact]
    public void Loads_twenty_four_islands_of_very_different_sizes_in_layout_order()
    {
        var registry = RegistryLoader.Load(TestPaths.Stress24);
        var pillars = registry.Groups.Where(g => !g.IsHub).ToList();

        Assert.Equal(24, pillars.Count);
        Assert.Equal(Sizes, pillars.Select(p => p.Nodes.Count));
        Assert.Equal(Enumerable.Range(1, 24).Select(i => $"p{i:00}"), pillars.Select(p => p.Id));
        Assert.Equal(Sizes.Sum() + 4, registry.AllNodes.Count());
    }

    [Fact]
    public async Task Every_island_reports_every_system_and_a_calm_town_is_healthy()
    {
        var snapshot = await new Rig().Tick();

        Assert.Equal(25, snapshot.Groups.Count); // 24 pillars and the hub
        Assert.All(snapshot.Groups.SelectMany(g => g.Nodes), n => Assert.Equal(HealthState.Healthy, n.State));
        Assert.Empty(snapshot.Notices);
    }

    [Fact]
    public async Task A_bad_island_stays_on_its_island()
    {
        var rig = new Rig();
        await rig.Tick();
        rig.Fake.Add("p02", FakeEffectKind.Down, 1); // the 25-system island
        rig.Fake.Add("p01", FakeEffectKind.Errors, 1); // the 2-system island
        var s = await rig.Tick();

        Assert.Equal(25, s.Totals.Down);
        Assert.All(s.Groups.Single(g => g.Id == "p02").Nodes, n => Assert.Equal(HealthState.Down, n.State));
        Assert.All(s.Groups.Where(g => g.Id is not ("p01" or "p02")).SelectMany(g => g.Nodes), n => Assert.Equal(HealthState.Healthy, n.State));
    }

    [Fact]
    public async Task The_town_keeps_up_with_many_ticks_and_the_snapshot_stays_a_sensible_size()
    {
        var rig = new Rig();
        Snapshot last = null!;
        var clock = Stopwatch.StartNew();
        for (var i = 0; i < 120; i++) last = await rig.Tick();
        clock.Stop();

        // 120 ticks of 253 systems: a few hundred milliseconds in practice. The ceiling only catches something accidentally quadratic.
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(10), $"took {clock.Elapsed}");
        var bytes = JsonSerializer.SerializeToUtf8Bytes(last, new JsonSerializerOptions(JsonSerializerDefaults.Web)).Length;
        Assert.InRange(bytes, 10_000, 600_000);
    }
}
