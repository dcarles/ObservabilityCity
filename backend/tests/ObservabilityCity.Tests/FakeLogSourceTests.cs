using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>
/// The inspector's Logs tab in a demo town. The fake source makes up entries that fit what it is doing to the system: 5xx requests in proportion to the
/// error rate, slow requests over the SLA, throttling on a store that turns requests away, dead letters on a consumer, and the exceptions behind the
/// errors. They come in the same four sections as a live town's, grouped with a count and newest first, steady from one read to the next, and a system
/// with no fresh data has none.
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

        public SystemLogs Logs_(string id) =>
            Logs.Recent(Registry.AllNodes.Concat(Registry.Vendors.Select(v => v.Node)).Single(n => n.Id == id));

        public IReadOnlyList<LogGroup> Section(string id, string section) => Logs_(id).Sections.Single(s => s.Id == section).Groups;
    }

    [Fact]
    public async Task A_healthy_system_has_the_sections_and_next_to_nothing_in_them()
    {
        var rig = new Rig();
        await rig.Run();

        var logs = rig.Logs_("aa.orders-api");

        Assert.True(logs.Configured);
        Assert.Equal(["failed", "slow", "logs", "exceptions"], logs.Sections.Select(s => s.Id));
        Assert.All(logs.Sections, s => Assert.InRange(s.Groups.Sum(g => g.Count), 0, FakeLogSource.Steps / 10));
    }

    [Fact]
    public async Task The_same_moment_gives_the_same_entries()
    {
        var rig = new Rig();
        rig.Fake.Add("aa.orders-api", FakeEffectKind.Errors, 0.6);
        await rig.Run();

        Assert.Equal(rig.Logs_("aa.orders-api").Sections.Select(s => s.Groups), rig.Logs_("aa.orders-api").Sections.Select(s => s.Groups));
    }

    [Fact]
    public async Task Errors_show_up_as_500_requests_grouped_with_a_count_and_their_exceptions()
    {
        var rig = new Rig();
        rig.Fake.Add("aa.orders-api", FakeEffectKind.Errors, 0.6);
        await rig.Run();

        var failed = rig.Section("aa.orders-api", "failed");

        Assert.NotEmpty(failed);
        Assert.All(failed, g => Assert.Equal("500", g.Result));
        Assert.True(failed.Sum(g => g.Count) >= 10, "most moments should leave a failed request");
        Assert.True(failed.Count < failed.Sum(g => g.Count), "repeats are one group with a count");
        Assert.Equal(failed.OrderByDescending(g => g.At).Select(g => g.At), failed.Select(g => g.At));
        Assert.NotEmpty(rig.Section("aa.orders-api", "exceptions"));
    }

    [Fact]
    public async Task A_slow_system_has_slow_requests_and_the_sla_they_are_measured_against()
    {
        var rig = new Rig();
        rig.Fake.Add("aa.orders-api", FakeEffectKind.Latency, 1);
        await rig.Run();

        var logs = rig.Logs_("aa.orders-api");

        Assert.NotEmpty(logs.Sections.Single(s => s.Id == "slow").Groups);
        Assert.Equal(rig.Registry.AllNodes.Single(n => n.Id == "aa.orders-api").SlaP99Ms, logs.SlowOverMs);
    }

    [Fact]
    public async Task A_system_that_is_down_logs_only_failures()
    {
        var rig = new Rig();
        rig.Fake.Add("aa.orders-api", FakeEffectKind.Down, 1);
        await rig.Run();

        var logs = rig.Section("aa.orders-api", "logs");

        Assert.NotEmpty(logs);
        Assert.All(logs, g => Assert.Equal(LogLevel.Error, g.Level));
    }

    [Fact]
    public async Task A_worker_has_only_the_logs_and_exceptions_sections()
    {
        var rig = new Rig();
        await rig.Run();

        Assert.Equal(["logs", "exceptions"], rig.Logs_("aa.orders-worker").Sections.Select(s => s.Id));
    }

    [Fact]
    public async Task A_consumer_that_parks_messages_logs_dead_letters()
    {
        var rig = new Rig();
        rig.Fake.Add("aa.orders-worker", FakeEffectKind.Poison, 1);
        await rig.Run(8);

        Assert.Contains(rig.Section("aa.orders-worker", "logs"), g => g.Level == LogLevel.Warn && g.Text.Contains("dead-letter"));
    }

    [Fact]
    public async Task A_store_that_turns_requests_away_logs_throttling_and_a_tenant_store_names_the_tenants_database()
    {
        var rig = new Rig(tenants: true);
        rig.Fake.Add("aa.orders-db#acme", FakeEffectKind.Saturate, 1);
        await rig.Run();

        var throttled = rig.Section("aa.orders-db", "logs").Where(g => g.Text.Contains("429")).ToList();

        Assert.NotEmpty(throttled);
        Assert.Contains(throttled, g => g.Text.StartsWith("merchant-acme-db: "));
    }

    [Fact]
    public async Task A_system_with_no_fresh_data_has_empty_sections()
    {
        var rig = new Rig();
        rig.Fake.Add("aa.orders-api", FakeEffectKind.Errors, 0.6);
        await rig.Run();
        Assert.NotEmpty(rig.Section("aa.orders-api", "failed"));

        rig.Clock.Advance(TimeSpan.FromSeconds(10)); // nothing polls: the reading is older than the stale limit

        Assert.All(rig.Logs_("aa.orders-api").Sections, s => Assert.Empty(s.Groups));
    }

    [Fact]
    public void A_system_never_heard_from_has_empty_sections()
    {
        var rig = new Rig();

        Assert.All(rig.Logs_("aa.orders-api").Sections, s => Assert.Empty(s.Groups));
    }

    [Fact]
    public async Task The_async_call_reads_the_same_entries()
    {
        var rig = new Rig();
        rig.Fake.Add("aa.orders-api", FakeEffectKind.Errors, 0.6);
        await rig.Run();
        var node = rig.Registry.AllNodes.Single(n => n.Id == "aa.orders-api");

        var viaInterface = await ((ILogSource)rig.Logs).RecentAsync(node, TestContext.Current.CancellationToken);

        Assert.Equal(rig.Logs_("aa.orders-api").Sections.Select(s => s.Groups), viaInterface.Sections.Select(s => s.Groups));
    }
}
