using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Tests;

public class ServiceCodeTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private const string Original = "id: aa.orders-api, service: orders, serviceCode: ord, name: Orders API,";

    private static RegistryNode Load(string edit)
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("pillars/aa.yaml", Original, edit);
        return RegistryLoader.Load(copy.Path).AllNodes.Single(n => n.Id == "aa.orders-api");
    }

    [Fact]
    public void A_service_code_is_shown_and_the_building_name_stays_plain()
    {
        var node = Load(Original);

        Assert.Equal("ord", node.ShownServiceCode);
        Assert.Equal("Orders API", node.Name);
    }

    [Fact]
    public void A_code_that_is_the_service_name_is_not_shown()
    {
        Assert.Null(Load("id: aa.orders-api, service: orders, serviceCode: Orders, name: Orders API,").ShownServiceCode);
    }

    [Fact]
    public void Without_a_code_none_is_shown()
    {
        Assert.Null(Load("id: aa.orders-api, service: orders, name: Orders API,").ShownServiceCode);
    }
}
