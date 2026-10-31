using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>The demo towns show the region view and the basic buildings without any cloud: the fake source makes up regions, and fake-assets.yaml lists the buildings.</summary>
public class DemoRegionsAndAssetsTests
{
    private static async Task<Snapshot> Run(string folder)
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 26, 8, 0, 0, TimeSpan.Zero));
        var registry = RegistryLoader.Load(folder);
        var fake = new FakeSource(FakeProfiles.Load(folder), new FakeOptions(), clock);
        var state = new LatestState();
        var builder = new SnapshotBuilder(registry, state, clock) { StaleAfter = TimeSpan.FromSeconds(3), FixedAssets = FakeAssets.Load(folder) };
        for (var i = 0; i < 3; i++)
        {
            clock.Advance(TimeSpan.FromSeconds(1));
            state.Update(await fake.PollAsync(registry, default));
        }
        return builder.Build();
    }

    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == id);

    [Theory]
    [InlineData("galactic-credit", "cl.ledger-api")]
    [InlineData("droid-shop", "web.catalog-api")]
    public async Task A_service_with_regions_in_fake_yaml_shows_each_with_its_instances_and_share(string town, string id)
    {
        var node = Node(await Run(Path.Combine(TestPaths.RepoRoot, "config", town)), id);

        Assert.Equal(2, node.Regions!.Count);
        Assert.All(node.Regions, r => Assert.NotNull(r.Instances));
        Assert.Equal(1.0, node.Regions.Sum(r => r.Share!.Value), 3);
    }

    [Fact]
    public async Task One_demo_service_sends_nearly_everything_to_a_region_so_the_skew_marker_shows()
    {
        var snapshot = await Run(Path.Combine(TestPaths.RepoRoot, "config", "galactic-credit"));

        Assert.Single(Node(snapshot, "pay.payments-api").Regions!, r => r.Skewed);
        Assert.DoesNotContain(Node(snapshot, "cl.ledger-api").Regions!, r => r.Skewed);
    }

    [Fact]
    public async Task A_service_without_regions_stays_one_set_of_numbers()
    {
        Assert.Null(Node(await Run(Path.Combine(TestPaths.RepoRoot, "config", "galactic-credit")), "cl.statements-api").Regions);
    }

    [Theory]
    [InlineData("galactic-credit", "cl", "ledger")]
    [InlineData("droid-shop", "web", "catalog")]
    public async Task The_demo_towns_have_basic_buildings_behind_a_service_and_in_the_back_yard(string town, string pillar, string service)
    {
        var group = (await Run(Path.Combine(TestPaths.RepoRoot, "config", town))).Groups.Single(g => g.Id == pillar);

        Assert.Contains(group.Assets, a => a.Service == service && a.Shape == "vault");
        Assert.Contains(group.Assets, a => a.Service is null);
        Assert.All(group.Assets, a => Assert.Contains(a.Shape, RegionAssetShapes));
    }

    private static readonly string[] RegionAssetShapes = ["box", "vault", "store", "settings"];

    [Fact]
    public async Task Every_demo_asset_names_a_pillar_and_a_service_the_town_has()
    {
        foreach (var town in new[] { "galactic-credit", "droid-shop" })
        {
            var folder = Path.Combine(TestPaths.RepoRoot, "config", town);
            var registry = RegistryLoader.Load(folder);
            foreach (var a in FakeAssets.Load(folder))
            {
                var group = registry.Groups.SingleOrDefault(g => g.Id == a.PillarId);
                Assert.True(group is not null, $"{town}: {a.Id} names no pillar");
                if (a.Service is not null) Assert.True(group!.Nodes.Any(n => n.ServiceCode == a.Service || n.Service == a.Service), $"{town}: {a.Id} names no service {a.Service}");
            }
        }
    }
}
