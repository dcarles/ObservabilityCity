using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>The wall block in town.yaml: the town's defaults for wall mode. Each key is optional; missing means the page uses its own default.</summary>
public class WallConfigTests
{
    private static Snapshot Snap(Registry registry) => new SnapshotBuilder(registry, new LatestState(), TimeProvider.System).Build();

    [Fact]
    public void A_town_that_does_not_say_has_no_wall_defaults()
    {
        var registry = RegistryLoader.Load(TestPaths.MiniTown);

        Assert.Null(registry.Town.Wall);
        Assert.Null(Snap(registry).Wall);
    }

    [Fact]
    public void A_town_that_sets_them_gets_them_in_the_registry_and_the_snapshot()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("town.yaml", "mode: demo", "mode: demo\nwall:\n  holdSeconds: 30\n  overviewSeconds: 20\n  overviewIslandSeconds: 4\n  light: day");

        var registry = RegistryLoader.Load(f.Path);

        Assert.Equal(new WallSettings(30, 20, 4, "day"), registry.Town.Wall);
        Assert.Equal(new WallSettingsSnapshot(30, 20, 4, "day"), Snap(registry).Wall);
    }

    [Fact]
    public void A_key_left_out_stays_unset_so_the_page_default_applies()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("town.yaml", "mode: demo", "mode: demo\nwall:\n  overviewSeconds: 0");

        var wall = RegistryLoader.Load(f.Path).Town.Wall;

        Assert.Equal(new WallSettings(null, 0, null, null), wall);
    }

    [Theory]
    [InlineData("holdSeconds: 0.5")]
    [InlineData("overviewSeconds: 0")]
    [InlineData("overviewIslandSeconds: 0")]
    [InlineData("light: dusk")]
    public void The_ends_of_the_range_are_allowed(string line)
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("town.yaml", "mode: demo", $"mode: demo\nwall:\n  {line}");

        Assert.NotNull(RegistryLoader.Load(f.Path).Town.Wall);
    }

    [Theory]
    [InlineData("holdSeconds: 0.1", "wall.holdSeconds")]
    [InlineData("holdSeconds: -5", "wall.holdSeconds")]
    [InlineData("overviewSeconds: -1", "wall.overviewSeconds")]
    [InlineData("overviewIslandSeconds: -1", "wall.overviewIslandSeconds")]
    [InlineData("light: night", "wall.light")]
    public void A_value_out_of_range_stops_the_load_and_names_the_key(string line, string key)
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("town.yaml", "mode: demo", $"mode: demo\nwall:\n  {line}");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(f.Path));

        Assert.Contains($"town.yaml: {key}", e.Message);
    }

    [Fact]
    public void An_unknown_light_says_which_are_known()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("town.yaml", "mode: demo", "mode: demo\nwall:\n  light: night");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(f.Path));

        Assert.Contains("Use dusk or day", e.Message);
    }
}
