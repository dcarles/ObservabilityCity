using ObservabilityCity.Contracts;
using ObservabilityCity.Core.History;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Slice 2: the town of a past time is built by the same builder and rules as the live town, from what each source can say about that time. A source that cannot read the past leaves
/// its signals out, the inventory stands as it is now, and a source that fails fails the frame.
/// </summary>
public class PastFrameTests
{
    private static string Town => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-01-01T12:00:00Z");
    private static readonly DateTimeOffset Then = DateTimeOffset.Parse("2025-12-30T09:05:00Z");

    private sealed class Past(string name, Func<DateTimeOffset, IReadOnlyDictionary<string, NodeReading>> at, bool can = true) : IPastMetricSource
    {
        public int Asked;
        public string Name => name;
        public TimeSpan PollInterval => TimeSpan.FromSeconds(30);
        public bool CanReadPast => can;
        public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct) => Task.FromResult(at(Now));
        public Task<IReadOnlyDictionary<string, NodeReading>> PollAtAsync(TownRegistry registry, DateTimeOffset when, CancellationToken ct) { Asked++; return Task.FromResult(at(when)); }
    }

    private sealed class Inventory(string name) : IMetricSource
    {
        public string Name => name;
        public TimeSpan PollInterval => TimeSpan.FromMinutes(5);
        public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct) => throw new InvalidOperationException("a past frame must not ask the inventory");
    }

    private static NodeReading Reading(DateTimeOffset at, double rps, int instances = 0) => new(at, true, instances, instances, 0, rps, 0.001, 50);

    private static (PastFrameBuilder Frames, TownRegistry Registry) Frames(params IMetricSource[] sources) => FramesLogged(null, sources);

    private static (PastFrameBuilder Frames, TownRegistry Registry) FramesLogged(Microsoft.Extensions.Logging.ILogger? log, params IMetricSource[] sources)
    {
        var registry = RegistryLoader.Load(Town).ForEnvironment("prod");
        var liveState = new LatestState();
        liveState.Update("inventory", new Dictionary<string, NodeReading> { ["aa.orders-api"] = Reading(Now, 0, 3) });
        var live = new SnapshotBuilder(registry, liveState, new FixedClock(Now)) { Environment = "prod" };
        return (new PastFrameBuilder(live, liveState, new RegistryHolder(registry), sources, log), registry);
    }

    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).First(n => n.Id == id);

    [Fact]
    public async Task A_frame_is_the_town_at_that_time_with_todays_inventory_and_fresh_readings()
    {
        var telemetry = new Past("telemetry", at => new Dictionary<string, NodeReading> { ["aa.orders-api"] = Reading(at, 7) });
        var (frames, _) = Frames(telemetry, new Inventory("inventory"));

        var snapshot = await frames.BuildAsync(Then, CancellationToken.None);

        var api = Node(snapshot, "aa.orders-api");
        Assert.Equal(7, api.RequestsPerSecond); // what the source said for then
        Assert.Equal(3, api.InstancesTotal); // today's count: the cloud's history of it is not read
        Assert.NotEqual(HealthState.Stale, api.State); // the reading is as fresh as the frame's own clock says
        Assert.Equal(Then, snapshot.GeneratedAt);
        Assert.Equal(1, telemetry.Asked);
    }

    [Fact]
    public async Task A_source_that_cannot_read_the_past_leaves_its_signals_out()
    {
        var recorded = new Past("telemetry", at => new Dictionary<string, NodeReading> { ["aa.orders-api"] = Reading(at, 7) }, can: false);
        var (frames, _) = Frames(recorded, new Inventory("inventory"));

        var snapshot = await frames.BuildAsync(Then, CancellationToken.None);

        Assert.Equal(0, recorded.Asked);
        Assert.NotEqual(7, Node(snapshot, "aa.orders-api").RequestsPerSecond);
    }

    [Fact]
    public async Task A_source_that_fails_fails_the_frame()
    {
        var failing = new Past("telemetry", _ => throw new HttpRequestException("Log Analytics answered 429"));
        var (frames, _) = Frames(failing, new Inventory("inventory"));

        await Assert.ThrowsAsync<HttpRequestException>(() => frames.BuildAsync(Then, CancellationToken.None));
    }

    [Fact]
    public async Task A_frame_has_no_health_reports_of_the_cloud_and_a_slow_or_failing_source_is_logged()
    {
        var log = new Lines();
        var (logged, _) = FramesLogged(log, new Past("telemetry", at => throw new HttpRequestException("Log Analytics answered 429")), new Inventory("inventory"));
        await Assert.ThrowsAsync<HttpRequestException>(() => logged.BuildAsync(Then, CancellationToken.None));
        Assert.Contains(log.Messages, m => m.Contains("telemetry") && m.Contains("429"));

        var (ok, _) = Frames(new Past("telemetry", at => new Dictionary<string, NodeReading> { ["aa.orders-api"] = Reading(at, 7) }), new Inventory("inventory"));
        Assert.Empty((await ok.BuildAsync(Then, CancellationToken.None)).HealthEvents ?? []);
    }

    private sealed class Lines : Microsoft.Extensions.Logging.ILogger
    {
        public List<string> Messages { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(Microsoft.Extensions.Logging.LogLevel level) => true;
        public void Log<TState>(Microsoft.Extensions.Logging.LogLevel level, Microsoft.Extensions.Logging.EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter) => Messages.Add(formatter(state, exception));
    }
}
