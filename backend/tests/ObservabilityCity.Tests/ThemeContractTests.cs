using System.Text.Json;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// What every theme has to be able to draw comes from the snapshot the backend sends: the kinds of building and the four health states. The
/// frontend holds every theme to the same file (shared-test-data/themes/theme-contract.json), so a kind added here without a model in each theme,
/// or a health state without a beacon, fails on both sides.
/// </summary>
public class ThemeContractTests
{
    private static readonly JsonElement Contract = JsonDocument.Parse(File.ReadAllText(Path.Combine(TestPaths.RepoRoot, "shared-test-data", "themes", "theme-contract.json"))).RootElement;

    private static string[] List(string name) => Contract.GetProperty(name).EnumerateArray().Select(e => e.GetString()!).ToArray();

    [Fact]
    public void Every_kind_of_building_in_the_snapshot_is_one_the_themes_must_draw()
    {
        Assert.Equal(List("buildingKinds"), Enum.GetNames<NodeKind>());
    }

    [Fact]
    public void Every_health_state_has_a_beacon_in_every_theme()
    {
        Assert.Equal(List("healthStates"), Enum.GetNames<HealthState>());
        Assert.Equal(["green", "amber", "red", "grey"], Contract.GetProperty("beacons").EnumerateObject().Select(p => p.Name));
    }

    [Fact]
    public void The_sample_towns_use_every_kind_of_building_so_a_theme_is_tried_on_all_of_them()
    {
        var used = new[] { TestPaths.Registry, TestPaths.DroidShop }
            .Select(RegistryLoader.Load)
            .SelectMany(r => r.AllNodes.Select(n => n.Kind).Concat(r.Vendors.Select(v => v.Node.Kind)))
            .Distinct()
            .Select(k => k.ToString())
            .Order();

        Assert.Equal(List("buildingKinds").Order(), used);
    }

    [Fact]
    public void The_snapshot_fixtures_the_themes_are_drawn_from_only_hold_kinds_the_themes_know()
    {
        var known = List("buildingKinds").ToHashSet();
        foreach (var file in Directory.GetFiles(TestPaths.Fixtures, "*.json"))
        {
            var kinds = JsonDocument.Parse(File.ReadAllText(file)).RootElement.GetProperty("groups").EnumerateArray()
                .SelectMany(g => g.GetProperty("nodes").EnumerateArray())
                .Select(n => n.GetProperty("kind").GetString()!);
            Assert.All(kinds, k => Assert.Contains(k, known));
        }
    }

    [Fact]
    public void The_themes_the_frontend_offers_are_the_ones_the_contract_names()
    {
        Assert.Equal(["harbour-town", "space", "factory"], List("themes"));
    }
}
