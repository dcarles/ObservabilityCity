using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Tests;

public class DisplayNameTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");

    private static RegistryNode Load(string edit, string id)
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("pillars/aa.yaml", "id: aa.orders-api, service: orders, serviceCode: ord, name: Orders API,", edit);
        return RegistryLoader.Load(copy.Path).AllNodes.Single(n => n.Id == id);
    }

    [Fact]
    public void A_service_code_is_added_to_the_name_the_interface_shows()
    {
        var node = Load("id: aa.orders-api, service: orders, serviceCode: ord, name: Orders API,", "aa.orders-api");

        Assert.Equal("Orders API (ord)", node.DisplayName);
        Assert.Equal("Orders API", node.Name); // scope templates still read the plain name
    }

    [Fact]
    public void A_name_that_already_says_the_code_is_left_alone()
    {
        Assert.Equal("Orders API (ORD)", Load("id: aa.orders-api, service: orders, serviceCode: ord, name: Orders API (ORD),", "aa.orders-api").DisplayName);
    }

    [Fact]
    public void A_code_equal_to_the_name_is_not_repeated()
    {
        Assert.Equal("ord", Load("id: aa.orders-api, service: orders, serviceCode: ord, name: ord,", "aa.orders-api").DisplayName);
    }

    [Fact]
    public void Without_a_code_the_name_stays_as_it_is()
    {
        Assert.Equal("Orders API", Load("id: aa.orders-api, service: orders, name: Orders API,", "aa.orders-api").DisplayName);
    }
}
