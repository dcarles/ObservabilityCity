using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Tests;

/// <summary>The second sample town, Droid Shop: a web shop with Kafka, direct calls between teams and three vendors.</summary>
public class DroidShopTests
{
    private static readonly Registry Shop = RegistryLoader.Load(TestPaths.DroidShop);

    [Fact]
    public void The_shop_loads_with_no_notices_and_no_warnings()
    {
        Assert.Empty(Shop.Notices);
        Assert.Empty(Shop.Warnings);
    }

    [Fact]
    public void It_is_a_direct_topology_town_of_teams()
    {
        Assert.Equal("droid-shop", Shop.Town.Id);
        Assert.Equal("Droid Shop", Shop.Town.Name);
        Assert.Equal("direct", Shop.Town.Topology);
        Assert.Equal("Team", Shop.Town.GroupLabel);
    }

    [Fact]
    public void Its_six_teams_stand_round_the_platform_in_the_order_of_the_layout()
    {
        var teams = Shop.Groups.Where(g => !g.IsHub && !g.IsLostFound).Select(g => g.DisplayName);

        Assert.Equal(["Web", "Mobile", "Checkout", "Inventory", "Shipping", "Notifications"], teams);
    }

    [Fact]
    public void The_broker_on_the_platform_is_Kafka()
    {
        var hub = Shop.Groups.Single(g => g.IsHub);

        var broker = Assert.Single(hub.Nodes, n => n.Kind == NodeKind.Broker);
        Assert.Equal("Kafka", broker.Name);
    }

    [Fact]
    public void It_has_a_payment_gateway_a_courier_and_a_push_service_as_vendors()
    {
        Assert.Equal(["Payment gateway", "Courier", "Push service"], Shop.Vendors.Select(v => v.Node.Name));
    }

    [Fact]
    public void Checkout_publishes_orders_and_shipping_and_notifications_read_them()
    {
        var subscribersToOrders = Shop.Subscriptions.Where(s => s.Topic == "chk-orders-outbox").Select(s => s.ConsumerGroupId).Order().ToList();

        Assert.Equal(["inv", "ntf", "shp"], subscribersToOrders);
    }

    [Fact]
    public void Mobile_has_no_messaging_so_no_pier()
    {
        Assert.DoesNotContain(Shop.Topics, t => t.GroupId == "mob");
        Assert.DoesNotContain(Shop.Subscriptions, s => s.ConsumerGroupId == "mob");
    }

    [Fact]
    public void The_flash_sale_story_only_names_things_the_shop_has()
    {
        var known = Shop.AllNodes.Select(n => n.Id).Concat(Shop.Vendors.Select(v => v.Node.Id)).Concat(Shop.Groups.Select(g => g.Id)).ToHashSet();
        var (stories, notices) = StoryFiles.Load(TestPaths.DroidShop);

        Assert.Empty(notices);
        var story = Assert.Single(stories);
        var targets = story.Steps.SelectMany(s => s.Apply.Select(a => a.Target).Concat(s.Ramp.Select(r => r.Target)).Concat(s.Clear.Select(c => c.Target)).Concat([s.Camera]))
            .Where(t => t is not null).Select(t => t!);
        Assert.All(targets, t => Assert.Contains(t, known));
    }

    [Fact]
    public void Every_system_has_a_baseline_in_the_fake_source()
    {
        var profiles = FakeProfiles.Load(TestPaths.DroidShop);

        var missing = Shop.AllNodes.Concat(Shop.Vendors.Select(v => v.Node)).Select(n => n.Id).Where(id => !profiles.ContainsKey(id)).ToList();

        Assert.Empty(missing);
    }
}
