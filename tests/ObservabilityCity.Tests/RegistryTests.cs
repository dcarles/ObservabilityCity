using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Tests;

public class RegistryTests
{
    [Fact]
    public void Sample_town_loads_with_hub_first()
    {
        var registry = RegistryLoader.Load(TestPaths.Registry);

        Assert.Equal("Galactic Credit", registry.Town.Name);
        Assert.True(registry.Groups[0].IsHub);
        Assert.Contains(registry.AllNodes, n => n.Id == "cl.ledger-api");
    }

    [Fact]
    public void Defaults_cascade_system_over_pillar_over_app()
    {
        var registry = RegistryLoader.Load(TestPaths.Registry);
        RegistryNode Node(string id) => registry.AllNodes.Single(n => n.Id == id);

        Assert.Equal(800, Node("cl.gateway-api").SlaP99Ms); // system override
        Assert.Equal(300, Node("cl.ledger-api").SlaP99Ms);  // pillar default for api
        Assert.Equal(30000, Node("cl.posting-worker").SlaP99Ms); // app default for worker
        Assert.Equal(0.005, Node("cl.ledger-db").ErrorAmber); // app default for db
    }

    [Fact]
    public void Id_prefix_must_match_its_pillar_file()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(dir, "pillars"));
            File.WriteAllText(Path.Combine(dir, "town.yaml"), "id: t\nname: T\n");
            File.WriteAllText(Path.Combine(dir, "hub.yaml"), "resources: []\n");
            File.WriteAllText(Path.Combine(dir, "pillars", "aa.yaml"),
                "pillar: aa\ndisplayName: A\nsystems:\n  - { id: bb.thing, role: api }\n");

            var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(dir));
            Assert.Contains("aa.yaml", e.Message);
            Assert.Contains("bb.thing", e.Message);
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void Unknown_role_names_the_file_and_the_choices()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(dir, "pillars"));
            File.WriteAllText(Path.Combine(dir, "town.yaml"), "id: t\nname: T\n");
            File.WriteAllText(Path.Combine(dir, "hub.yaml"), "resources: []\n");
            File.WriteAllText(Path.Combine(dir, "pillars", "aa.yaml"),
                "pillar: aa\ndisplayName: A\nsystems:\n  - { id: aa.thing, role: castle }\n");

            var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(dir));
            Assert.Contains("castle", e.Message);
        }
        finally { Directory.Delete(dir, true); }
    }
}
