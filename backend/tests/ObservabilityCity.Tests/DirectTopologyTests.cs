using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// In a town whose islands call each other directly nothing goes through the central island: islands reach each other, the airport and the third
/// parties over the outer ring road, and the central island's bridges lead only to the shared resources that are really called.
/// </summary>
public class DirectTopologyTests
{
    private static readonly Registry Shop = RegistryLoader.Load(TestPaths.DroidShop);
    private static readonly IReadOnlyDictionary<string, GroupLinks> ShopLinks = TownLinks.Of(Shop);

    [Fact]
    public void Only_the_teams_that_call_a_shared_resource_have_a_bridge_to_the_central_island()
    {
        Assert.True(ShopLinks["web"].HasBridge); // calls hub.accounts-db
        Assert.True(ShopLinks["mob"].HasBridge); // calls hub.accounts-db
        foreach (var id in new[] { "chk", "inv", "shp", "ntf" }) Assert.False(ShopLinks[id].HasBridge, id);
    }

    [Fact]
    public void Every_team_with_an_API_or_a_call_to_another_team_has_a_bridge_to_the_ring_road()
    {
        foreach (var id in new[] { "web", "mob", "chk", "inv", "shp", "ntf" }) Assert.True(ShopLinks[id].HasRingBridge, id);
    }

    [Fact]
    public void The_central_island_has_neither_bridge()
    {
        Assert.False(ShopLinks["hub"].HasBridge);
        Assert.False(ShopLinks["hub"].HasRingBridge);
    }

    [Fact]
    public void A_team_that_is_linked_only_by_a_call_to_another_team_still_reaches_the_ring()
    {
        // an island with no API of its own that calls into another island: it gets the ring road, and no hub bridge
        using var copy = new RegistryCopy(TestPaths.DroidShop);
        copy.Replace("pillars/ntf.yaml", "role: api", "role: worker");
        var links = TownLinks.Of(RegistryLoader.Load(copy.Path));

        Assert.False(links["ntf"].HasApi);
        Assert.True(links["ntf"].HasRingBridge); // shp.shipments-api calls ntf.dispatch-api
        Assert.False(links["ntf"].HasBridge);
    }

    [Fact]
    public void An_island_nothing_calls_and_with_no_API_stands_alone_in_a_direct_town()
    {
        using var copy = new RegistryCopy(TestPaths.DirectTown);
        copy.Write("pillars/zz.yaml", "pillar: zz\ndisplayName: Zed\ncolor: \"#aaaaaa\"\nsystems:\n  - { id: zz.db, name: Zed DB, role: db }\n");
        copy.Write("layout.yaml", "islands: [aa, bb, cc, zz]\n");
        var links = TownLinks.Of(RegistryLoader.Load(copy.Path));

        Assert.True(links["zz"].Standalone);
    }

    [Fact]
    public void In_the_direct_sample_town_islands_reach_each_other_over_the_ring_and_none_goes_to_the_hub()
    {
        var links = TownLinks.Of(RegistryLoader.Load(TestPaths.DirectTown));

        foreach (var id in new[] { "aa", "bb", "cc" })
        {
            Assert.True(links[id].HasRingBridge, id);
            Assert.False(links[id].HasBridge, id);
        }
    }

    [Fact]
    public void A_hub_and_spoke_town_is_unchanged_a_ring_bridge_only_for_a_team_that_calls_a_third_party()
    {
        var registry = RegistryLoader.Load(TestPaths.Registry);
        var links = TownLinks.Of(registry);

        Assert.Equal("hub-and-spoke", registry.Town.Topology);
        foreach (var g in registry.Groups.Where(g => !g.IsHub && g.ConfigError is null))
        {
            Assert.Equal(links[g.Id].CallsVendor, links[g.Id].HasRingBridge);
            if (links[g.Id].HasApi) Assert.True(links[g.Id].HasBridge, g.Id); // every API island still has its spoke to the hub
        }
    }
}
