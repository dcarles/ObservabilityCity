using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 3, slice 3: resources that are not systems (a key vault, a storage account, a configuration store) stand as small buildings without health. Which
/// resource types, what they are called and how a name ties one to a service are all rules in the environment file; two towns that write them differently
/// show the same kind of building, which is the proof that the program knows no convention.
/// </summary>
public class AssetBuildingTests
{
    private static string Town(string name) => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", name == "a" ? "function-town-a" : "function-town-b");

    private static async Task<Snapshot> TownSnapshot(string folder)
    {
        var registry = RegistryLoader.Load(folder).ForEnvironment("prod");
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, folder);
        Assert.Empty(set.Problems);
        var state = new LatestState();
        foreach (var source in set.Sources) state.Update(source.Name, await source.PollAsync(registry, CancellationToken.None));
        return new SnapshotBuilder(registry, state, new FakeTimeProvider(DateTimeOffset.Parse("2026-01-01T00:00:00Z"))) { Environment = "prod", ScopeSource = set.Scope }.Build();
    }

    private static IReadOnlyList<AssetSnapshot> Assets(Snapshot s) => s.Groups.Single(g => g.Id == "aa").Assets ?? [];

    [Fact]
    public async Task Town_a_finds_vaults_storage_and_a_store_by_their_names_and_ties_the_ones_that_name_a_service()
    {
        var assets = Assets(await TownSnapshot(Town("a")));

        Assert.Equal(
            [("aa.appcfg-acme-al", "App configuration", "settings", (string?)null), ("aa.kv-acme-al-ord", "Key vault", "vault", "orders"),
             ("aa.kv-acme-al-shared", "Key vault", "vault", null), ("aa.stacmealord", "Storage account", "store", "orders")],
            assets.Select(a => (a.Id, a.Label, a.Shape, a.Service)));
    }

    [Fact]
    public async Task Town_a_leaves_out_a_resource_that_names_another_pillar()
    {
        Assert.DoesNotContain(Assets(await TownSnapshot(Town("a"))), a => a.Name == "kv-acme-zz-ord");
    }

    [Fact]
    public async Task Town_b_has_other_names_other_words_and_other_shapes_and_gets_the_same_kind_of_building()
    {
        var assets = Assets(await TownSnapshot(Town("b")));

        Assert.Equal(
            [("aa.orders-blobs", "Blob store", "store", (string?)"orders"), ("aa.orders-vault", "Secret store", "vault", "orders"), ("aa.vault-main", "Shared secret store", "vault", null)],
            assets.Select(a => (a.Id, a.Label, a.Shape, a.Service)));
        Assert.Equal("ams", assets.First(a => a.Name == "orders-vault").Region);
    }

    [Theory]
    [InlineData("a", "https://portal.example.test/#resource/subscriptions/00000000-0000-0000-0000-0000000000f1/resourceGroups/rg/providers/microsoft.keyvault/vaults/kv-acme-al-ord")]
    [InlineData("b", "https://console.example.test/apps/orders-vault?env=prod")]
    public async Task An_asset_carries_the_addresses_the_environment_makes_for_its_resource(string town, string expected)
    {
        var vault = Assets(await TownSnapshot(Town(town))).First(a => a.Label.Contains("ecret") || a.Label == "Key vault" && a.Service == "orders");

        Assert.Equal(expected, Assert.Single(vault.Links!).Url);
    }

    [Fact]
    public async Task An_asset_is_not_a_system_so_it_adds_nothing_to_the_totals_or_to_the_nodes()
    {
        var snapshot = await TownSnapshot(Town("a"));

        Assert.DoesNotContain(snapshot.Groups.SelectMany(g => g.Nodes), n => n.Id.Contains("kv-acme"));
    }

    [Fact]
    public async Task A_town_without_assets_rules_or_without_a_scope_store_has_none()
    {
        var folder = Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
        var registry = RegistryLoader.Load(folder).ForEnvironment("prod");
        var snapshot = new SnapshotBuilder(registry, new LatestState(), new FakeTimeProvider(DateTimeOffset.UnixEpoch)) { Environment = "prod" }.Build();

        Assert.All(snapshot.Groups, g => Assert.Empty(g.Assets ?? []));
    }

    [Fact]
    public void An_assets_rule_needs_a_label_a_known_shape_types_and_a_pattern_that_only_uses_known_groups()
    {
        var folder = Directory.CreateTempSubdirectory().FullName;
        try
        {
            foreach (var file in Directory.GetFiles(Town("a"), "*", SearchOption.AllDirectories))
            {
                var target = Path.Combine(folder, Path.GetRelativePath(Town("a"), file));
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.Copy(file, target);
            }
            var prod = Path.Combine(folder, "environments", "prod.yaml");
            File.WriteAllText(prod, File.ReadAllText(prod).Replace("  assets:\n", "  assets:\n    - { name: bad-one, label: '', shape: castle, types: [], pattern: '(?<colour>x)' }\n"));

            var problems = Assert.Throws<RegistryException>(() => RegistryLoader.Load(folder)).Message;

            Assert.Contains("needs a label", problems);
            Assert.Contains("shape 'castle'", problems);
            Assert.Contains("needs types", problems);
            Assert.Contains("the group 'colour'", problems);
        }
        finally { Directory.Delete(folder, true); }
    }
}
