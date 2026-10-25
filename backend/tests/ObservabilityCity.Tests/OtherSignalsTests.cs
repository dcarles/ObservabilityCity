using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>Slice 4: incident weather, outside callers (the airport), third-party health, the dependency overlay and stale data.</summary>
public class OtherSignalsTests
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
            Builder = new SnapshotBuilder(Registry, State, Clock) { StaleAfter = TimeSpan.FromSeconds(3), IncidentSources = [Fake] };
        }

        public async Task<Snapshot> Run(int seconds = 1)
        {
            for (var i = 0; i < seconds; i++)
            {
                Clock.Advance(TimeSpan.FromSeconds(1));
                State.Update(await Fake.PollAsync(Registry, default));
            }
            return Builder.Build();
        }
    }

    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).Concat(s.Vendors.Select(v => v.Node)).Single(n => n.Id == id);
    private static GroupSnapshot Group(Snapshot s, string id) => s.Groups.Single(g => g.Id == id);

    // ── incidents ──────────────────────────────────────────────────────────

    [Fact]
    public async Task A_calm_town_has_a_clear_sky()
    {
        var s = await new Rig().Run(2);

        Assert.All(s.Groups, g => Assert.Empty(g.Incidents));
        Assert.Equal(0, s.Totals.Incidents);
    }

    [Theory]
    [InlineData(0.2, 4)]
    [InlineData(0.4, 3)]
    [InlineData(0.7, 2)]
    [InlineData(1.0, 1)]
    public async Task An_incident_effect_puts_weather_over_the_target_island_only(double intensity, int severity)
    {
        var rig = new Rig();
        rig.Fake.Add("bb", FakeEffectKind.Incident, intensity);

        var s = await rig.Run(2);

        Assert.Equal(severity, Assert.Single(Group(s, "bb").Incidents).Severity);
        Assert.All(s.Groups.Where(g => g.Id != "bb"), g => Assert.Empty(g.Incidents));
        Assert.Equal(1, s.Totals.Incidents);
    }

    [Fact]
    public async Task An_incident_aimed_at_a_system_lands_on_its_island_and_the_worst_comes_first()
    {
        var rig = new Rig();
        rig.Fake.Add("aa.orders-api", FakeEffectKind.Incident, 0.4);
        rig.Fake.Add("aa", FakeEffectKind.Incident, 1.0);

        var incidents = Group(await rig.Run(), "aa").Incidents;

        Assert.Equal([1, 3], incidents.Select(i => i.Severity));
        Assert.Equal(rig.Clock.GetUtcNow(), incidents[0].StartedAt.AddSeconds(1)); // opened the second before the poll
    }

    [Fact]
    public async Task An_incident_for_the_whole_town_covers_the_hub_too_and_reset_clears_it()
    {
        var rig = new Rig();
        rig.Fake.Add("*", FakeEffectKind.Incident, 0.7);

        var s = await rig.Run();
        Assert.All(s.Groups, g => Assert.Single(g.Incidents));
        Assert.True(Group(s, "hub").IsHub);

        rig.Fake.Reset();
        Assert.Equal(0, (await rig.Run()).Totals.Incidents);
    }

    [Fact]
    public async Task Incidents_for_a_group_the_registry_does_not_have_are_ignored()
    {
        var rig = new Rig();
        var builder = new SnapshotBuilder(rig.Registry, rig.State, rig.Clock)
        {
            IncidentSources = [new Fixed(new Incident("x", "nowhere", 1, "Lost", rig.Clock.GetUtcNow()))],
        };
        await rig.Run();

        Assert.Equal(0, builder.Build().Totals.Incidents);
    }

    private sealed class Fixed(params Incident[] incidents) : IIncidentSource
    {
        public string Name => "fixed";
        public IReadOnlyList<Incident> Current(Registry registry) => incidents;
    }

    // ── third parties ──────────────────────────────────────────────────────

    [Fact]
    public async Task Vendors_come_from_third_parties_yaml_and_start_healthy()
    {
        var s = await new Rig().Run(2);

        Assert.Equal(["ext.bureau", "ext.mailer"], s.Vendors.Select(v => v.Node.Id));
        Assert.Equal(["cc.notify-worker", "bb.ledger-worker"], s.Vendors[1].CalledBy);
        Assert.All(s.Vendors, v => Assert.Equal(HealthState.Healthy, v.Node.State));
        // one opaque service: no instances to count and no CPU or memory to show
        Assert.All(s.Vendors, v => { Assert.Equal(1, v.Node.InstancesTotal); Assert.Null(v.Node.Cpu); Assert.Null(v.Node.Memory); });
    }

    [Fact]
    public async Task A_vendor_that_is_down_shows_down_and_its_callers_start_failing()
    {
        var rig = new Rig();
        var before = Node(await rig.Run(2), "aa.orders-api");
        rig.Fake.Add("ext.bureau", FakeEffectKind.Down, 1);

        var s = await rig.Run();

        Assert.Equal(HealthState.Down, Node(s, "ext.bureau").State);
        var caller = Node(s, "aa.orders-api");
        Assert.True(caller.ErrorRate > before.ErrorRate + 0.2, $"caller errors {caller.ErrorRate}");
        Assert.Equal(HealthState.Down, Node(s, "ext.bureau").State);
        Assert.Equal(HealthState.Healthy, Node(s, "ext.mailer").State); // only that vendor and its callers
        Assert.Equal(HealthState.Healthy, Node(s, "cc.notify-api").State);
        Assert.Equal(1, s.Totals.Down);
    }

    [Fact]
    public async Task A_vendor_that_is_slow_is_degraded_against_its_own_threshold()
    {
        var rig = new Rig();
        rig.Fake.Add("ext.bureau", FakeEffectKind.Latency, 0.6);

        var bureau = Node(await rig.Run(), "ext.bureau");

        Assert.True(bureau.P99Ms > bureau.SlaP99Ms);
        Assert.Equal(HealthState.Degraded, bureau.State);
        Assert.Equal(1500, bureau.SlaP99Ms); // from third-parties.yaml
    }

    [Fact]
    public async Task A_vendor_whose_calls_we_cannot_read_goes_grey()
    {
        var rig = new Rig();
        await rig.Run(2);
        rig.Fake.Add("ext", FakeEffectKind.Stale, 1);

        var s = await rig.Run(5);

        Assert.All(s.Vendors, v => Assert.Equal(HealthState.Stale, v.Node.State));
        Assert.Equal(0, s.Totals.Down);
    }

    // ── outside callers and dependencies ───────────────────────────────────

    [Fact]
    public async Task Outside_callers_bring_in_the_traffic_of_the_systems_they_reach()
    {
        var s = await new Rig().Run(2);

        var mobile = s.ExternalCallers.Single(c => c.Id == "mobile-app");
        Assert.Equal(["aa.orders-api", "bb.ledger-api"], mobile.Calls);
        Assert.Equal(Node(s, "aa.orders-api").RequestsPerSecond + Node(s, "bb.ledger-api").RequestsPerSecond, mobile.RequestsPerSecond, 3);
    }

    [Fact]
    public async Task Outside_callers_share_a_system_they_both_reach()
    {
        using var copy = new RegistryCopy(TestPaths.MiniTown);
        copy.Replace("hub.yaml", "calls: [cc.notify-api] }", "calls: [cc.notify-api, aa.orders-api] }");
        var registry = RegistryLoader.Load(copy.Path);
        var state = new LatestState();
        var clock = new FakeTimeProvider(DateTimeOffset.Parse("2026-10-25T12:00:00Z"));
        var fake = new FakeSource(FakeProfiles.Load(copy.Path), new FakeOptions(), clock) { Calm = true };
        clock.Advance(TimeSpan.FromSeconds(1));
        state.Update(await fake.PollAsync(registry, TestContext.Current.CancellationToken));

        var s = new SnapshotBuilder(registry, state, clock).Build();

        var orders = Node(s, "aa.orders-api").RequestsPerSecond;
        Assert.Equal(orders / 2, s.ExternalCallers.Single(c => c.Id == "partner").RequestsPerSecond - Node(s, "cc.notify-api").RequestsPerSecond, 3);
    }

    [Fact]
    public async Task Dependencies_follow_gateway_calls_and_vendor_calls_between_groups_only()
    {
        var s = await new Rig().Run(2);

        // cc -> aa and cc -> bb through the gateway, aa -> ext.bureau and cc, bb -> ext.mailer to the vendor
        Assert.Contains(s.Dependencies, d => d is { From: "cc", To: "bb" });
        Assert.Contains(s.Dependencies, d => d is { From: "cc", To: "aa" });
        Assert.Contains(s.Dependencies, d => d is { From: "aa", To: "ext.bureau" });
        Assert.Contains(s.Dependencies, d => d is { From: "cc", To: "ext.mailer" });
        Assert.Contains(s.Dependencies, d => d is { From: "bb", To: "ext.mailer" });
        Assert.DoesNotContain(s.Dependencies, d => d.From == d.To); // calls inside an island are not listed
        Assert.Equal(Node(s, "bb.ledger-api").RequestsPerSecond, s.Dependencies.Single(d => d is { From: "cc", To: "bb" }).RequestsPerSecond, 3);
        // a vendor's rate is shared evenly between the systems that call it
        Assert.Equal(Node(s, "ext.mailer").RequestsPerSecond / 2, s.Dependencies.Single(d => d is { From: "cc", To: "ext.mailer" }).RequestsPerSecond, 3);
    }

    [Fact]
    public async Task A_stale_callee_leaves_the_overlay()
    {
        var rig = new Rig();
        await rig.Run(2);
        rig.Fake.Add("bb.ledger-api", FakeEffectKind.Stale, 1);

        var s = await rig.Run(5);

        Assert.DoesNotContain(s.Dependencies, d => d is { From: "cc", To: "bb" });
        Assert.Contains(s.Dependencies, d => d is { From: "cc", To: "aa" });
    }

    // ── registry rules ─────────────────────────────────────────────────────

    [Fact]
    public void A_vendor_calledBy_an_unknown_system_is_refused_with_a_hint()
    {
        using var copy = new RegistryCopy(TestPaths.MiniTown);
        copy.Replace("third-parties.yaml", "calledBy: [aa.orders-api]", "calledBy: [aa.order-api]");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("third-parties.yaml: 'ext.bureau' is called by 'aa.order-api'", e.Message);
        Assert.Contains("aa.orders-api", e.Message);
    }

    [Theory]
    [InlineData("id: ext.bureau,", "id: bureau,", "must look like 'ext.some-name'")]
    [InlineData("id: ext.mailer,", "id: ext.bureau,", "is used twice")]
    [InlineData("calledBy: [aa.orders-api]", "calledBy: []", "needs calledBy")]
    public void Bad_vendor_entries_name_the_file_and_the_problem(string from, string to, string expected)
    {
        using var copy = new RegistryCopy(TestPaths.MiniTown);
        copy.Replace("third-parties.yaml", from, to);

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("third-parties.yaml", e.Message);
        Assert.Contains(expected, e.Message);
    }

    [Fact]
    public void A_gateway_call_to_a_system_on_the_same_island_is_refused()
    {
        using var copy = new RegistryCopy(TestPaths.MiniTown);
        copy.Replace("pillars/cc.yaml", "gatewayCalls: [aa.orders-api, bb.ledger-api]", "gatewayCalls: [cc.notify-worker]");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("'cc.notify-api' lists 'cc.notify-worker' under gatewayCalls, but it is on the same island: use calls", e.Message);
    }

    [Fact]
    public void A_town_without_third_parties_yaml_has_no_vendors()
    {
        var registry = RegistryLoader.Load(TestPaths.Stress24);

        Assert.Empty(registry.Vendors);
    }
}
