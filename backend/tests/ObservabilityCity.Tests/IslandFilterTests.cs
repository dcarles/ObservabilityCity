using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>
/// Slice 5: the island filter. Showing some islands shows them and the hub, and nothing else counts: the totals, the third parties, the airport's rate and
/// the dependency arcs hold only what is on screen. The traffic that crosses the edge is listed so the renderer can say where it goes.
/// Mini town: aa, bb and cc. cc.notify-api reaches aa.orders-api and bb.ledger-api through the gateway. ext.bureau is called from aa, ext.mailer from bb and cc.
/// </summary>
public class IslandFilterTests
{
    private sealed class Rig
    {
        public readonly FakeTimeProvider Clock = new(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        public readonly Registry Registry;
        public readonly LatestState State = new();
        public readonly FakeSource Fake;
        public readonly SnapshotBuilder Builder;

        public Rig(string folder = "mini")
        {
            var path = folder == "mini" ? TestPaths.MiniTown : TestPaths.TenantsTown;
            Registry = folder == "mini" ? RegistryLoader.Load(path) : RegistryLoader.Load(path).ForEnvironment("prod");
            Fake = new FakeSource(FakeProfiles.Load(path), new FakeOptions(), Clock) { Calm = true };
            Builder = new SnapshotBuilder(Registry, State, Clock) { StaleAfter = TimeSpan.FromSeconds(3), IncidentSources = [Fake] };
        }

        public async Task Run(int seconds = 2)
        {
            for (var i = 0; i < seconds; i++)
            {
                Clock.Advance(TimeSpan.FromSeconds(1));
                State.Update(await Fake.PollAsync(Registry, default));
            }
        }
    }

    private static IEnumerable<NodeSnapshot> Nodes(Snapshot s) => s.Groups.SelectMany(g => g.Nodes);
    private static NodeSnapshot Node(Snapshot s, string id) => Nodes(s).Concat(s.Vendors.Select(v => v.Node)).Single(n => n.Id == id);

    [Fact]
    public async Task Without_a_filter_the_whole_town_is_shown_and_the_view_is_empty()
    {
        var rig = new Rig();
        await rig.Run();

        var s = rig.Builder.Build();
        var empty = rig.Builder.Build(Array.Empty<string>());

        Assert.Equal(["hub", "aa", "bb", "cc"], s.Groups.Select(g => g.Id));
        Assert.Empty(s.View.Islands);
        Assert.Empty(s.View.Hidden);
        Assert.Empty(s.View.Links);
        Assert.Empty(s.View.Unknown);
        Assert.Equal(s.Groups.Select(g => g.Id), empty.Groups.Select(g => g.Id)); // an empty filter is no filter
    }

    [Fact]
    public async Task The_snapshot_says_how_islands_reach_each_other()
    {
        var rig = new Rig();
        await rig.Run();

        Assert.Equal("hub-and-spoke", rig.Builder.Build().Topology);
        Assert.Equal("hub-and-spoke", rig.Builder.Build(["aa"]).Topology);
    }

    [Fact]
    public async Task A_filter_shows_those_islands_and_always_the_hub()
    {
        var rig = new Rig();
        await rig.Run();

        var s = rig.Builder.Build(["bb"]);

        Assert.Equal(["hub", "bb"], s.Groups.Select(g => g.Id));
        Assert.Equal(["bb"], s.View.Islands);
        Assert.Equal(["aa", "cc"], s.View.Hidden.Select(h => h.Id));
        Assert.Equal(["Alpha", "Gamma"], s.View.Hidden.Select(h => h.DisplayName));
    }

    [Fact]
    public async Task The_order_the_ids_come_in_and_repeats_make_no_difference()
    {
        var rig = new Rig();
        await rig.Run();

        var a = rig.Builder.Build(["cc", "aa", "aa"]);
        var b = rig.Builder.Build(["aa", "cc"]);

        Assert.Equal(["aa", "cc"], a.View.Islands);
        Assert.Equal(b.Groups.Select(g => g.Id), a.Groups.Select(g => g.Id));
    }

    [Fact]
    public async Task Totals_count_only_what_is_on_screen()
    {
        var rig = new Rig();
        await rig.Run();
        var whole = rig.Builder.Build();

        var aa = rig.Builder.Build(["aa"]);

        var onScreen = Nodes(aa).Where(n => n.State != HealthState.Stale).ToList();
        Assert.Equal(onScreen.Sum(n => n.RequestsPerSecond), aa.Totals.RequestsPerSecond, 6);
        Assert.True(aa.Totals.RequestsPerSecond < whole.Totals.RequestsPerSecond);
        Assert.Equal(Nodes(whole).Where(n => n.Id.StartsWith("hub.") || n.Id.StartsWith("aa.")).Sum(n => n.RequestsPerSecond), aa.Totals.RequestsPerSecond, 6);
    }

    [Fact]
    public async Task Showing_every_island_gives_the_same_totals_as_showing_the_town()
    {
        var rig = new Rig();
        await rig.Run();

        var all = rig.Builder.Build(["aa", "bb", "cc"]);
        var whole = rig.Builder.Build();

        Assert.Equal(whole.Totals, all.Totals);
        Assert.Equal(whole.Vendors.Select(v => v.Node.Id), all.Vendors.Select(v => v.Node.Id));
        Assert.Equal(whole.Dependencies, all.Dependencies);
        Assert.Empty(all.View.Hidden);
        Assert.Empty(all.View.Links);
    }

    [Fact]
    public async Task A_system_that_is_down_off_screen_is_not_counted_and_one_on_screen_is()
    {
        var rig = new Rig();
        rig.Fake.Add("bb.ledger-api", FakeEffectKind.Down, 1);
        rig.Fake.Add("cc", FakeEffectKind.Incident, 1);
        await rig.Run();

        var aa = rig.Builder.Build(["aa"]);
        var bb = rig.Builder.Build(["bb"]);
        var whole = rig.Builder.Build();

        Assert.Equal(0, aa.Totals.Down);
        Assert.Equal(1, bb.Totals.Down);
        Assert.Equal(1, whole.Totals.Down);
        Assert.Equal(0, aa.Totals.Incidents); // the storm over cc is off screen
        Assert.Equal(1, whole.Totals.Incidents);
    }

    [Fact]
    public async Task Dead_letters_off_screen_do_not_count_in_the_town_total()
    {
        var rig = new Rig();
        rig.Fake.Add("cc.notify-worker", FakeEffectKind.Poison, 1);
        await rig.Run(8);

        Assert.True(rig.Builder.Build(["cc"]).Totals.DeadLetters > 0);
        Assert.Equal(0, rig.Builder.Build(["aa"]).Totals.DeadLetters);
    }

    [Fact]
    public async Task A_third_party_shows_while_an_island_that_calls_it_does()
    {
        var rig = new Rig();
        await rig.Run();

        var aa = rig.Builder.Build(["aa"]);
        var bb = rig.Builder.Build(["bb"]);
        var both = rig.Builder.Build(["bb", "cc"]);

        Assert.Equal(["ext.bureau"], aa.Vendors.Select(v => v.Node.Id));
        Assert.Equal(["ext.mailer"], bb.Vendors.Select(v => v.Node.Id));
        // the callers listed are the ones on screen
        Assert.Equal(["bb.ledger-worker"], bb.Vendors.Single().CalledBy);
        Assert.Equal(new[] { "bb.ledger-worker", "cc.notify-worker" }, both.Vendors.Single().CalledBy.Order(StringComparer.Ordinal));
        // a hidden third party takes no part in the counts
        Assert.Equal(0, rig.Builder.Build(["cc"]).Vendors.Count(v => v.Node.Id == "ext.bureau"));
    }

    [Fact]
    public async Task A_third_party_that_is_down_counts_only_while_it_is_shown()
    {
        var rig = new Rig();
        rig.Fake.Add("ext.bureau", FakeEffectKind.Down, 1);
        await rig.Run();

        Assert.Equal(1, rig.Builder.Build(["aa"]).Totals.Down);
        Assert.Equal(0, rig.Builder.Build(["bb"]).Totals.Down);
    }

    [Fact]
    public async Task Arcs_join_only_what_is_on_screen()
    {
        var rig = new Rig();
        await rig.Run();

        Assert.Contains(rig.Builder.Build().Dependencies, d => d.From == "cc" && d.To == "aa");
        var ccAndAa = rig.Builder.Build(["cc", "aa"]).Dependencies;
        Assert.Contains(ccAndAa, d => d is { From: "cc", To: "aa" });
        Assert.DoesNotContain(ccAndAa, d => d.To == "bb" || d.From == "bb");
        Assert.DoesNotContain(rig.Builder.Build(["aa"]).Dependencies, d => d.From == "cc");
    }

    [Fact]
    public async Task The_airports_rate_counts_only_the_systems_on_screen()
    {
        var rig = new Rig();
        await rig.Run();
        var whole = rig.Builder.Build();

        var aa = rig.Builder.Build(["aa"]);

        var mobile = aa.ExternalCallers.Single(c => c.Id == "mobile-app");
        Assert.Equal(["aa.orders-api"], mobile.Calls);
        Assert.Equal(Node(aa, "aa.orders-api").RequestsPerSecond, mobile.RequestsPerSecond, 6);
        Assert.True(mobile.RequestsPerSecond < whole.ExternalCallers.Single(c => c.Id == "mobile-app").RequestsPerSecond);
        var partner = aa.ExternalCallers.Single(c => c.Id == "partner");
        Assert.Empty(partner.Calls);
        Assert.Equal(0, partner.RequestsPerSecond);
    }

    [Fact]
    public async Task Traffic_that_leaves_the_screen_is_listed_with_where_it_goes()
    {
        var rig = new Rig();
        await rig.Run();

        var cc = rig.Builder.Build(["cc"]);

        var links = cc.View.Links.Where(l => !l.Incoming).ToList();
        Assert.Equal(new[] { "aa", "bb" }, links.Select(l => l.IslandId).Order(StringComparer.Ordinal));
        Assert.All(links, l => Assert.Equal("cc.notify-api", l.NodeId));
        Assert.Equal("Alpha", links.Single(l => l.IslandId == "aa").IslandName);
        var whole = rig.Builder.Build();
        Assert.Equal(Node(whole, "aa.orders-api").RequestsPerSecond, links.Single(l => l.IslandId == "aa").RequestsPerSecond, 6); // its only caller
        Assert.DoesNotContain(cc.View.Links, l => l.Incoming);
    }

    [Fact]
    public async Task Traffic_that_comes_from_off_screen_is_listed_against_the_system_it_reaches()
    {
        var rig = new Rig();
        await rig.Run();

        var aa = rig.Builder.Build(["aa"]);

        var incoming = Assert.Single(aa.View.Links, l => l.Incoming);
        Assert.Equal("aa.orders-api", incoming.NodeId);
        Assert.Equal("cc", incoming.IslandId);
        Assert.Equal("Gamma", incoming.IslandName);
        Assert.True(incoming.RequestsPerSecond > 0);
        Assert.DoesNotContain(aa.View.Links, l => !l.Incoming); // nothing on aa calls out of it
    }

    [Fact]
    public async Task Traffic_between_two_hidden_islands_is_not_listed_and_none_is_when_both_ends_show()
    {
        var rig = new Rig();
        await rig.Run();

        // aa and cc talk to each other and neither is on screen: that is not listed. Only cc's call into bb crosses the edge.
        var bb = rig.Builder.Build(["bb"]).View.Links;
        var link = Assert.Single(bb);
        Assert.Equal(("bb.ledger-api", "cc", true), (link.NodeId, link.IslandId, link.Incoming));
        Assert.DoesNotContain(rig.Builder.Build(["aa", "cc"]).View.Links, l => l.IslandId == "cc");
    }

    [Fact]
    public async Task An_id_the_town_does_not_have_is_ignored_and_reported_never_replaced_by_the_whole_town()
    {
        var rig = new Rig();
        await rig.Run();

        var s = rig.Builder.Build(["aa", "nope"]);
        var onlyBad = rig.Builder.Build(["nope"]);

        Assert.Equal(["hub", "aa"], s.Groups.Select(g => g.Id));
        Assert.Equal(["nope"], s.View.Unknown);
        Assert.Equal(["aa"], s.View.Islands);
        Assert.Contains(s.Notices, n => n.Contains("'nope'") && n.Contains("not in this town"));
        Assert.Equal(["hub"], onlyBad.Groups.Select(g => g.Id)); // a typo must not leave anyone looking at the whole town
    }

    [Fact]
    public async Task Naming_the_hub_changes_nothing_because_it_is_always_shown()
    {
        var rig = new Rig();
        await rig.Run();

        var s = rig.Builder.Build(["hub", "aa"]);

        Assert.Equal(["hub", "aa"], s.Groups.Select(g => g.Id));
        Assert.Empty(s.View.Unknown);
    }

    [Fact]
    public async Task Tenant_shares_do_not_change_with_the_filter()
    {
        var rig = new Rig("tenants");
        await rig.Run();
        Assert.NotEmpty(rig.Builder.Build().Tenants);

        var whole = rig.Builder.Build();
        var bb = rig.Builder.Build(["bb"]);

        Assert.NotEmpty(whole.Tenants);
        Assert.Equal(whole.Tenants, bb.Tenants);
    }

    [Fact]
    public async Task The_filtered_snapshot_matches_the_golden_fixture()
    {
        var rig = new Rig();
        rig.Fake.Add("aa.orders-api", FakeEffectKind.Errors, 0.5);
        await rig.Run();
        var snapshot = rig.Builder.Build(["aa", "cc"]);

        var actual = System.Text.Json.JsonSerializer.Serialize(snapshot, Golden.Json).ReplaceLineEndings("\n");
        var path = Path.Combine(TestPaths.Fixtures, "island-filter.json");
        if (Environment.GetEnvironmentVariable("UPDATE_GOLDEN") == "1" || !File.Exists(path))
            File.WriteAllText(path, actual + "\n");
        Assert.Equal(File.ReadAllText(path).ReplaceLineEndings("\n").TrimEnd(), actual.TrimEnd());
    }
}
