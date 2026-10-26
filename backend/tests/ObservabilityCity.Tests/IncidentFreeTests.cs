using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>"All systems healthy, 3 h since the last incident": the snapshot says since when the islands on screen have had no open incident.</summary>
public class IncidentFreeTests
{
    private sealed class Rig
    {
        public readonly FakeTimeProvider Clock = new(new DateTimeOffset(2026, 10, 26, 8, 0, 0, TimeSpan.Zero));
        public readonly Registry Registry = RegistryLoader.Load(TestPaths.MiniTown);
        public readonly LatestState State = new();
        public readonly FakeSource Fake;
        public readonly SnapshotBuilder Builder;

        public Rig()
        {
            Fake = new FakeSource(FakeProfiles.Load(TestPaths.MiniTown), new FakeOptions(), Clock) { Calm = true };
            Builder = new SnapshotBuilder(Registry, State, Clock) { IncidentSources = [Fake] };
        }

        public async Task<Snapshot> Run(int seconds, IReadOnlyCollection<string>? islands = null)
        {
            Snapshot s = null!;
            for (var i = 0; i < seconds; i++)
            {
                Clock.Advance(TimeSpan.FromSeconds(1));
                State.Update(await Fake.PollAsync(Registry, default));
                s = Builder.Build(islands);
            }
            return s;
        }
    }

    [Fact]
    public async Task A_town_that_never_had_an_incident_is_free_since_the_server_started_and_says_none_was_seen()
    {
        var rig = new Rig();
        var start = rig.Clock.GetUtcNow();

        var s = await rig.Run(5);

        Assert.Equal(start, s.IncidentFreeSince);
        Assert.False(s.IncidentsSeen);
    }

    [Fact]
    public async Task While_an_incident_is_open_there_is_no_free_time_and_after_it_the_clock_starts_from_when_it_ended()
    {
        var rig = new Rig();
        await rig.Run(3);
        rig.Fake.Add("aa", FakeEffectKind.Incident, 0.5);

        var during = await rig.Run(4);
        rig.Fake.Clear();
        var endedBy = rig.Clock.GetUtcNow();
        var after = await rig.Run(10);

        Assert.Null(during.IncidentFreeSince);
        Assert.True(during.IncidentsSeen);
        Assert.True(after.IncidentsSeen);
        Assert.InRange(after.IncidentFreeSince!.Value, endedBy - TimeSpan.FromSeconds(1), endedBy + TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task A_view_looks_only_at_its_own_islands()
    {
        var rig = new Rig();
        await rig.Run(2);
        rig.Fake.Add("aa", FakeEffectKind.Incident, 0.5);
        await rig.Run(3);

        var other = await rig.Run(1, ["cc"]);
        var same = await rig.Run(1, ["aa"]);

        Assert.NotNull(other.IncidentFreeSince);
        Assert.False(other.IncidentsSeen); // cc never had one, whatever aa is going through
        Assert.Null(same.IncidentFreeSince);
        Assert.True(same.IncidentsSeen);
    }
}
