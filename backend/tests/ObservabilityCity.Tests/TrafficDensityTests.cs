using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>trafficDensity in town.yaml: how many cars appear, as a multiple of the usual number. Missing means 1.</summary>
public class TrafficDensityTests
{
    [Fact]
    public void A_town_that_does_not_say_has_the_usual_traffic()
    {
        var registry = RegistryLoader.Load(TestPaths.MiniTown);

        Assert.Equal(1, registry.Town.TrafficDensity);
        Assert.Equal(1, new SnapshotBuilder(registry, new LatestState(), TimeProvider.System).Build().TrafficDensity);
    }

    [Fact]
    public void A_town_that_sets_it_gets_it_in_the_registry_and_the_snapshot()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("town.yaml", "mode: demo", "mode: demo\ntrafficDensity: 3");

        var registry = RegistryLoader.Load(f.Path);

        Assert.Equal(3, registry.Town.TrafficDensity);
        Assert.Equal(3, new SnapshotBuilder(registry, new LatestState(), TimeProvider.System).Build().TrafficDensity);
    }

    [Theory]
    [InlineData("0.25")]
    [InlineData("10")]
    public void The_ends_of_the_range_are_allowed(string value)
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("town.yaml", "mode: demo", $"mode: demo\ntrafficDensity: {value}");

        Assert.Equal(double.Parse(value, System.Globalization.CultureInfo.InvariantCulture), RegistryLoader.Load(f.Path).Town.TrafficDensity);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("0.1")]
    [InlineData("-2")]
    [InlineData("11")]
    public void A_number_out_of_range_stops_the_load_and_says_the_range(string value)
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("town.yaml", "mode: demo", $"mode: demo\ntrafficDensity: {value}");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(f.Path));

        Assert.Contains("town.yaml: trafficDensity", e.Message);
        Assert.Contains("from 0.25 to 10", e.Message);
    }
}
