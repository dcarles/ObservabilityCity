using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>The daily traffic cycle of the fake generator: a day in a couple of minutes, floors added at the peak, and the calm switch that freezes it.</summary>
public class DailyCycleTests
{
    private sealed class Rig
    {
        public readonly FakeTimeProvider Clock = new(new DateTimeOffset(2026, 10, 26, 8, 0, 0, TimeSpan.Zero));
        public readonly Registry Registry = RegistryLoader.Load(TestPaths.MiniTown);
        public readonly LatestState State = new();
        public readonly FakeSource Fake;
        public readonly SnapshotBuilder Builder;

        public Rig(double dayLength = 120)
        {
            // the orders API is given room to scale: at 200 requests a second it needs from 4 floors at night to 8 at the peak
            var profiles = FakeProfiles.Load(TestPaths.MiniTown).ToDictionary(p => p.Key, p => p.Value);
            profiles["aa.orders-api"] = new FakeProfile { Rps = 200, PerInstanceRps = 40, MinInstances = 1, MaxInstances = 24, P99Ms = 200 };
            Fake = new FakeSource(profiles, new FakeOptions { DayLengthSeconds = dayLength }, Clock);
            Builder = new SnapshotBuilder(Registry, State, Clock) { StaleAfter = TimeSpan.FromSeconds(3), DayFraction = () => Fake.DayFraction };
        }

        public async Task<Snapshot> Run(double seconds)
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

    [Fact]
    public void A_day_takes_the_set_number_of_seconds_and_wraps()
    {
        var rig = new Rig(120);
        var start = rig.Fake.DayFraction;

        rig.Clock.Advance(TimeSpan.FromSeconds(60));
        Assert.Equal((start + 0.5) % 1, rig.Fake.DayFraction, 6);

        rig.Clock.Advance(TimeSpan.FromSeconds(60));
        Assert.Equal(start, rig.Fake.DayFraction, 6);
    }

    [Fact]
    public void Changing_the_length_of_a_day_keeps_the_time_of_day_and_runs_faster_from_there()
    {
        var rig = new Rig(120);
        rig.Clock.Advance(TimeSpan.FromSeconds(30));
        var now = rig.Fake.DayFraction;

        rig.Fake.DayLengthSeconds = 10;

        Assert.Equal(now, rig.Fake.DayFraction, 6);
        rig.Clock.Advance(TimeSpan.FromSeconds(5));
        Assert.Equal((now + 0.5) % 1, rig.Fake.DayFraction, 6);
        Assert.Equal(10, rig.Fake.DayLengthSeconds);
        rig.Fake.DayLengthSeconds = 0.1; // not shorter than the generator can follow
        Assert.Equal(5, rig.Fake.DayLengthSeconds);
    }

    [Fact]
    public async Task Traffic_follows_the_day_busy_in_the_afternoon_and_quiet_at_night()
    {
        var rig = new Rig(120);
        var rps = new List<(double Day, double Rps)>();
        for (var i = 0; i < 120; i++)
        {
            var s = await rig.Run(1);
            rps.Add((s.DayFraction, Node(s, "aa.orders-api").RequestsPerSecond));
        }

        var peak = rps.MaxBy(x => x.Rps);
        var night = rps.MinBy(x => x.Rps);
        Assert.InRange(peak.Day, 0.6, 0.8); // mid-afternoon
        Assert.True(night.Day is < 0.3 or > 0.9, $"quietest at {night.Day}");
        Assert.True(peak.Rps > night.Rps * 1.4);
    }

    [Fact]
    public async Task The_autoscaler_adds_floors_at_the_peak_and_takes_them_away_at_night()
    {
        var rig = new Rig(120);
        var floors = new List<(double Day, int Instances)>();
        for (var i = 0; i < 240; i++)
        {
            var s = await rig.Run(1);
            floors.Add((s.DayFraction, Node(s, "aa.orders-api").InstancesTotal));
        }

        Assert.True(floors.Max(f => f.Instances) > floors.Min(f => f.Instances), "the floors never changed");
        var night = floors.Where(f => f.Day is > 0.0 and < 0.15).Min(f => f.Instances);
        var peak = floors.Where(f => f.Day is > 0.6 and < 0.85).Max(f => f.Instances);
        Assert.True(peak >= night + 2, $"{night} floors at night, {peak} at the peak");
    }

    [Fact]
    public async Task Calm_freezes_the_day_and_the_noise_and_turning_it_off_lets_the_day_run_again()
    {
        var rig = new Rig(120) { };
        rig.Fake.Calm = true;
        var a = await rig.Run(20);
        var b = await rig.Run(20);

        Assert.Equal(0.5, a.DayFraction, 6);
        Assert.Equal(a.DayFraction, b.DayFraction, 6);
        Assert.Equal(Node(a, "aa.orders-api").RequestsPerSecond, Node(b, "aa.orders-api").RequestsPerSecond, 6);

        rig.Fake.Calm = false;
        var c = await rig.Run(30);
        Assert.NotEqual(0.5, c.DayFraction, 3);
    }

    [Fact]
    public async Task A_quick_day_changes_the_clock_in_the_snapshot_faster()
    {
        var slow = new Rig(120);
        var fast = new Rig(10);

        var s = await slow.Run(5);
        var f = await fast.Run(5);

        var slowMoved = Math.Abs(s.DayFraction - 0.3);
        var fastMoved = (f.DayFraction - 0.3 + 1) % 1;
        Assert.True(fastMoved > slowMoved * 5, $"fast {fastMoved}, slow {slowMoved}");
    }
}
