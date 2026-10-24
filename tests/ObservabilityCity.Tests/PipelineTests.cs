using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

public class PipelineTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
    };

    private sealed class Rig
    {
        public readonly FakeTimeProvider Clock = new(new DateTimeOffset(2026, 10, 24, 12, 0, 0, TimeSpan.Zero));
        public readonly Registry Registry = RegistryLoader.Load(TestPaths.Registry);
        public readonly LatestState State = new();
        public readonly FakeSource Fake;
        public readonly SnapshotBuilder Builder;

        public Rig()
        {
            Fake = new FakeSource(FakeProfiles.Load(TestPaths.Registry), new FakeOptions(), Clock);
            Builder = new SnapshotBuilder(Registry, State, Clock) { DayFraction = () => Fake.DayFraction };
        }

        public async Task<Snapshot> Tick(int seconds = 1)
        {
            Clock.Advance(TimeSpan.FromSeconds(seconds));
            State.Update(await Fake.PollAsync(Registry, default));
            return Builder.Build();
        }
    }

    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == id);

    [Fact]
    public async Task Calm_town_is_all_healthy_and_matches_the_golden_fixture()
    {
        var rig = new Rig { Fake = { Calm = true } };
        var snapshot = await rig.Tick();

        Assert.All(snapshot.Groups.SelectMany(g => g.Nodes), n => Assert.Equal(HealthState.Healthy, n.State));

        var actual = JsonSerializer.Serialize(snapshot, Json).ReplaceLineEndings("\n");
        var path = Path.Combine(TestPaths.Fixtures, "calm.json");
        if (Environment.GetEnvironmentVariable("UPDATE_GOLDEN") == "1" || !File.Exists(path))
            File.WriteAllText(path, actual + "\n");
        Assert.Equal(File.ReadAllText(path).ReplaceLineEndings("\n").TrimEnd(), actual.TrimEnd());
    }

    [Fact]
    public async Task Errors_effect_degrades_only_its_target()
    {
        var rig = new Rig();
        await rig.Tick();
        rig.Fake.Add("cl.ledger-api", FakeEffectKind.Errors, 0.5);
        var s = await rig.Tick();

        Assert.Equal(HealthState.Degraded, Node(s, "cl.ledger-api").State);
        Assert.True(Node(s, "cl.ledger-api").ErrorRate > Node(s, "cl.ledger-api").ErrorAmber);
        Assert.Equal(HealthState.Healthy, Node(s, "cl.ledger-db").State);
    }

    [Fact]
    public async Task Down_effect_marks_down_and_zeroes_traffic()
    {
        var rig = new Rig();
        rig.Fake.Add("cl", FakeEffectKind.Down, 1);
        var s = await rig.Tick();

        var n = Node(s, "cl.ledger-db");
        Assert.Equal(HealthState.Down, n.State);
        Assert.Equal(0, n.InstancesHealthy);
        Assert.Equal(0, n.RequestsPerSecond);
        Assert.Equal(HealthState.Healthy, Node(s, "hub.apim").State);
    }

    [Fact]
    public async Task Unhealthy_instances_show_as_partly_healthy_fleet()
    {
        var rig = new Rig { Fake = { Calm = true } };
        rig.Fake.Add("cl.posting-api", FakeEffectKind.UnhealthyInstances, 0.5);
        var n = Node(await rig.Tick(), "cl.posting-api");

        Assert.Equal(HealthState.Degraded, n.State);
        Assert.InRange(n.InstancesHealthy, 1, n.InstancesTotal - 1);
    }

    [Fact]
    public async Task A_saturated_database_reports_utilisation_and_throttles()
    {
        var rig = new Rig { Fake = { Calm = true } };
        var calm = Node(await rig.Tick(), "cl.ledger-db");
        Assert.InRange(calm.Utilisation!.Value, 0.2, 0.8);
        Assert.Equal(0, calm.Throttled);
        Assert.Equal(HealthState.Healthy, calm.State);
        Assert.Null(calm.Cpu);

        rig.Fake.Add("cl.ledger-db", FakeEffectKind.Saturate, 1);
        var hot = Node(await rig.Tick(), "cl.ledger-db");
        Assert.True(hot.Utilisation > 0.95);
        Assert.True(hot.Throttled > hot.ThrottleAmber);
        Assert.Equal(HealthState.Degraded, hot.State);
    }

    [Fact]
    public async Task High_cpu_degrades_an_app_and_apps_report_cpu_and_memory()
    {
        var rig = new Rig { Fake = { Calm = true } };
        var calm = Node(await rig.Tick(), "cl.ledger-api");
        Assert.InRange(calm.Cpu!.Value, 0.1, 0.7);
        Assert.InRange(calm.Memory!.Value, 0.1, 0.7);
        Assert.Null(calm.Utilisation);
        Assert.Equal(HealthState.Healthy, calm.State);

        rig.Fake.Add("cl.ledger-api", FakeEffectKind.HighCpu, 1);
        var hot = Node(await rig.Tick(), "cl.ledger-api");
        Assert.True(hot.Cpu >= hot.ResourceAmber);
        Assert.Equal(HealthState.Degraded, hot.State);
    }

    [Fact]
    public async Task Readings_that_stop_arriving_go_stale_not_green()
    {
        var rig = new Rig();
        await rig.Tick();
        rig.Clock.Advance(TimeSpan.FromSeconds(60)); // the source stops answering

        var s = rig.Builder.Build();

        Assert.All(s.Groups.SelectMany(g => g.Nodes), n => Assert.Equal(HealthState.Stale, n.State));
    }

    [Fact]
    public async Task Traffic_effect_scales_instances_up()
    {
        var rig = new Rig();
        var before = Node(await rig.Tick(), "cl.ledger-api").InstancesTotal;
        rig.Fake.Add("cl.ledger-api", FakeEffectKind.Traffic, 1);
        Snapshot s = null!;
        for (var i = 0; i < 10; i++) s = await rig.Tick();

        Assert.True(Node(s, "cl.ledger-api").InstancesTotal > before);
    }
}
