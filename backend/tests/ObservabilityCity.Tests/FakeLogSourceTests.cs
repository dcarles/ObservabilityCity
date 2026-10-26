using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>
/// Slice 5: the inspector's Logs tab. The fake source makes up lines that fit what it is doing to the system: errors in proportion to the error rate,
/// slow-request warnings over the SLA, throttling on a store that turns requests away, dead letters on a consumer. Lines are newest first, steady from
/// one read to the next, and a system with no fresh data has none.
/// </summary>
public class FakeLogSourceTests
{
    private sealed class Rig
    {
        public readonly FakeTimeProvider Clock = new(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        public readonly Registry Registry;
        public readonly LatestState State = new();
        public readonly FakeSource Fake;
        public readonly FakeLogSource Logs;

        public Rig(bool tenants = false)
        {
            var path = tenants ? TestPaths.TenantsTown : TestPaths.MiniTown;
            Registry = tenants ? RegistryLoader.Load(path).ForEnvironment("prod") : RegistryLoader.Load(path);
            Fake = new FakeSource(FakeProfiles.Load(path), new FakeOptions(), Clock) { Calm = true };
            Logs = new FakeLogSource(State, Clock, TimeSpan.FromSeconds(3));
        }

        public async Task Run(int seconds = 2)
        {
            for (var i = 0; i < seconds; i++)
            {
                Clock.Advance(TimeSpan.FromSeconds(1));
                State.Update(await Fake.PollAsync(Registry, default));
            }
        }

        public IReadOnlyList<LogLine> Lines(string id, int limit = 60) =>
            Logs.Recent(Registry.AllNodes.Concat(Registry.Vendors.Select(v => v.Node)).Single(n => n.Id == id), limit);
    }

    [Fact]
    public async Task A_healthy_system_logs_ordinary_lines_newest_first()
    {
        var rig = new Rig();
        await rig.Run();

        var lines = rig.Lines("aa.orders-api");

        Assert.Equal(60, lines.Count);
        Assert.True(lines.Count(l => l.Level == LogLevel.Info) >= 50, "a healthy system's log is nearly all ordinary lines");
        Assert.Equal(lines.OrderByDescending(l => l.At).Select(l => l.At), lines.Select(l => l.At));
        Assert.Contains(lines, l => l.Message.Contains("/api/orders/"));
        Assert.All(lines, l => Assert.True(l.At <= rig.Clock.GetUtcNow()));
    }

    [Fact]
    public async Task The_same_moment_gives_the_same_lines()
    {
        var rig = new Rig();
        await rig.Run();

        Assert.Equal(rig.Lines("aa.orders-api"), rig.Lines("aa.orders-api"));
        Assert.NotEqual(rig.Lines("aa.orders-api").Select(l => l.Message), rig.Lines("bb.ledger-api").Select(l => l.Message));
    }

    [Fact]
    public async Task A_line_keeps_its_text_and_time_while_newer_lines_arrive_above_it()
    {
        var rig = new Rig();
        await rig.Run();
        var before = rig.Lines("aa.orders-api", 20);

        rig.Clock.Advance(TimeSpan.FromSeconds(3));
        rig.State.Update(await rig.Fake.PollAsync(rig.Registry, default));
        var after = rig.Lines("aa.orders-api", 20);

        Assert.Equal(before.Take(19), after.Skip(1).Take(19));
    }

    [Fact]
    public async Task The_limit_is_respected_and_capped()
    {
        var rig = new Rig();
        await rig.Run();

        Assert.Equal(5, rig.Lines("aa.orders-api", 5).Count);
        Assert.Empty(rig.Lines("aa.orders-api", 0));
        Assert.Equal(FakeLogSource.MaxLines, rig.Lines("aa.orders-api", 5000).Count);
    }

    [Fact]
    public async Task Errors_show_up_as_error_lines()
    {
        var rig = new Rig();
        rig.Fake.Add("aa.orders-api", FakeEffectKind.Errors, 0.6);
        await rig.Run();

        var lines = rig.Lines("aa.orders-api");

        Assert.True(lines.Count(l => l.Level == LogLevel.Error) >= 10, "most of the lines should be errors");
        Assert.Contains(lines, l => l.Level == LogLevel.Error && l.Message.Contains(" 500 "));
    }

    [Fact]
    public async Task A_slow_system_logs_slow_request_warnings_with_its_sla()
    {
        var rig = new Rig();
        rig.Fake.Add("aa.orders-api", FakeEffectKind.Latency, 1);
        await rig.Run();

        var lines = rig.Lines("aa.orders-api", 100);

        var warn = lines.Where(l => l.Level == LogLevel.Warn).ToList();
        Assert.NotEmpty(warn);
        Assert.All(warn, l => Assert.Contains("SLA", l.Message));
    }

    [Fact]
    public async Task A_system_that_is_down_logs_only_failures()
    {
        var rig = new Rig();
        rig.Fake.Add("aa.orders-api", FakeEffectKind.Down, 1);
        await rig.Run();

        var lines = rig.Lines("aa.orders-api");

        Assert.NotEmpty(lines);
        Assert.All(lines, l => Assert.Equal(LogLevel.Error, l.Level));
    }

    [Fact]
    public async Task A_consumer_that_parks_messages_logs_dead_letters()
    {
        var rig = new Rig();
        rig.Fake.Add("aa.orders-worker", FakeEffectKind.Poison, 1);
        await rig.Run(8);

        var lines = rig.Lines("aa.orders-worker", 100);

        Assert.Contains(lines, l => l.Level == LogLevel.Warn && l.Message.Contains("dead-letter"));
    }

    [Fact]
    public async Task A_store_that_turns_requests_away_logs_throttling_and_a_tenant_store_names_the_tenants_database()
    {
        var rig = new Rig(tenants: true);
        rig.Fake.Add("aa.orders-db#acme", FakeEffectKind.Saturate, 1);
        await rig.Run();

        var lines = rig.Lines("aa.orders-db", 100);

        var throttled = lines.Where(l => l.Message.Contains("429")).ToList();
        Assert.NotEmpty(throttled);
        Assert.Contains(throttled, l => l.Message.StartsWith("merchant-acme-db: "));
    }

    [Fact]
    public async Task A_system_with_no_fresh_data_has_no_logs()
    {
        var rig = new Rig();
        await rig.Run();
        Assert.NotEmpty(rig.Lines("aa.orders-api"));

        rig.Clock.Advance(TimeSpan.FromSeconds(10)); // nothing polls: the reading is older than the stale limit

        Assert.Empty(rig.Lines("aa.orders-api"));
    }

    [Fact]
    public void A_system_never_heard_from_has_no_logs()
    {
        var rig = new Rig();

        Assert.Empty(rig.Lines("aa.orders-api"));
    }

    [Fact]
    public async Task The_async_call_reads_the_same_lines()
    {
        var rig = new Rig();
        await rig.Run();
        var node = rig.Registry.AllNodes.Single(n => n.Id == "aa.orders-api");

        var viaInterface = await ((ILogSource)rig.Logs).RecentAsync(node, 10, default);

        Assert.Equal(rig.Lines("aa.orders-api", 10), viaInterface);
    }
}
