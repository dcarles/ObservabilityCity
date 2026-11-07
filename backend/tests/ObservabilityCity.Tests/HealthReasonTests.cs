using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>The line that says why a system is amber or red: present exactly when the state is not healthy, and built from the thresholds that set the state.</summary>
public class HealthReasonTests
{
    private static async Task<Snapshot> Run(Action<FakeSource>? effects = null)
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        var registry = RegistryLoader.Load(TestPaths.MiniTown);
        var state = new LatestState();
        var fake = new FakeSource(FakeProfiles.Load(TestPaths.MiniTown), new FakeOptions(), clock) { Calm = true };
        effects?.Invoke(fake);
        var builder = new SnapshotBuilder(registry, state, clock) { StaleAfter = TimeSpan.FromSeconds(3), IncidentSources = [fake] };
        for (var i = 0; i < 2; i++)
        {
            clock.Advance(TimeSpan.FromSeconds(1));
            state.Update(await fake.PollAsync(registry, default));
        }
        return builder.Build();
    }

    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == id);

    [Fact]
    public async Task A_healthy_system_has_no_reason()
    {
        var s = await Run();

        Assert.All(s.Groups.SelectMany(g => g.Nodes).Where(n => n.State == HealthState.Healthy), n => Assert.Null(n.Reason));
    }

    [Fact]
    public async Task Errors_give_the_error_rate_as_the_reason()
    {
        var s = await Run(f => f.Add("aa.orders-api", FakeEffectKind.Errors, 0.6));

        var n = Node(s, "aa.orders-api");
        Assert.NotEqual(HealthState.Healthy, n.State);
        Assert.Contains("error rate", n.Reason);
    }

    [Fact]
    public async Task Slow_responses_give_the_p99_as_the_reason()
    {
        var s = await Run(f => f.Add("aa.orders-api", FakeEffectKind.Latency, 1));

        Assert.Contains("p99", Node(s, "aa.orders-api").Reason);
    }

    [Fact]
    public async Task High_cpu_gives_the_cpu_as_the_reason()
    {
        var s = await Run(f => f.Add("aa.orders-api", FakeEffectKind.HighCpu, 1));

        Assert.Contains("CPU", Node(s, "aa.orders-api").Reason);
    }

    [Fact]
    public async Task Every_system_that_is_not_healthy_has_a_reason_and_every_healthy_one_has_none()
    {
        var s = await Run(f =>
        {
            f.Add("aa.orders-api", FakeEffectKind.Errors, 0.6);
            f.Add("bb", FakeEffectKind.UnhealthyInstances, 0.5);
        });

        foreach (var n in s.Groups.SelectMany(g => g.Nodes).Where(n => n.State != HealthState.Stale))
            Assert.Equal(n.State != HealthState.Healthy, !string.IsNullOrEmpty(n.Reason));
    }
}

/// <summary>The snapshot's list of configured sources: when each last reported and whether it is overdue.</summary>
public class SourceFreshnessTests
{
    [Fact]
    public async Task Each_configured_source_reports_when_it_last_read_and_whether_it_is_overdue()
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        var registry = RegistryLoader.Load(TestPaths.MiniTown);
        var state = new LatestState();
        var fake = new FakeSource(FakeProfiles.Load(TestPaths.MiniTown), new FakeOptions(), clock) { Calm = true };
        var builder = new SnapshotBuilder(registry, state, clock)
        {
            StaleAfter = TimeSpan.FromSeconds(30),
            SourceIntervals = new Dictionary<string, TimeSpan> { [fake.Name] = TimeSpan.FromSeconds(10), ["quiet"] = TimeSpan.FromSeconds(60) },
        };
        clock.Advance(TimeSpan.FromSeconds(1));
        state.Update(fake.Name, await fake.PollAsync(registry, TestContext.Current.CancellationToken));

        var fresh = builder.Build().Sources!;
        Assert.Equal(new[] { "quiet", fake.Name }.Order(StringComparer.Ordinal), fresh.Select(s => s.Name));
        Assert.Equal(10, fresh.Single(s => s.Name == fake.Name).IntervalSeconds);
        Assert.NotNull(fresh.Single(s => s.Name == fake.Name).LastRead);
        Assert.False(fresh.Single(s => s.Name == fake.Name).Overdue);
        Assert.Null(fresh.Single(s => s.Name == "quiet").LastRead);

        clock.Advance(TimeSpan.FromSeconds(31)); // past the limit for the 10 s source; the 60 s one is allowed 120 s
        var late = builder.Build().Sources!;
        Assert.True(late.Single(s => s.Name == fake.Name).Overdue);
        Assert.False(late.Single(s => s.Name == "quiet").Overdue);

        clock.Advance(TimeSpan.FromSeconds(100));
        Assert.True(builder.Build().Sources!.Single(s => s.Name == "quiet").Overdue); // never read, and past its limit
    }

    [Fact]
    public void A_town_with_no_configured_source_lists_none()
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        var builder = new SnapshotBuilder(RegistryLoader.Load(TestPaths.MiniTown), new LatestState(), clock);

        Assert.Null(builder.Build().Sources);
    }
}
