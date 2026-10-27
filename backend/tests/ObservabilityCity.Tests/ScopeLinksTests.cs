using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// A system's resources can carry addresses that open them somewhere else (a cloud portal, a console). The core knows no portal: every address is a
/// template in the environment's scope rules. Two towns with differently shaped templates prove it; the rest proves escaping, the scheme check and that
/// an environment without links shows none.
/// </summary>
public class ScopeLinksTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-b");

    private static ScopeInfo Info(string folder, string system)
    {
        var view = RegistryLoader.Load(folder).ForEnvironment("prod");
        var store = new ScopeStore();
        store.Update(ResourceGraphInventory.FromRecording(File.ReadAllText(Path.Combine(folder, "inventory.json"))), DateTimeOffset.UtcNow);
        return ScopeInfos.Of(view, store, system)!;
    }

    private static string Load(string env, string folder)
    {
        using var copy = new RegistryCopy(folder);
        File.WriteAllText(copy.FilePath("environments/prod.yaml"), env);
        return Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;
    }

    private const string Head = "name: Production\nsources:\n  inventory: { kind: resourcegraph }\nscope:\n  variables: { directory: example.test }\n";

    [Fact]
    public void Town_A_makes_a_portal_address_from_the_resource_id_and_its_own_variable()
    {
        var api = Info(TownA, "aa.orders-api").Resources.Single(r => r.Name == "api-acme-al-ord-northeurope1x");

        var link = Assert.Single(api.Links!);
        Assert.Equal("Cloud portal", link.Name);
        Assert.Equal("https://portal.example.test/#@example.test/resource/subscriptions/00000000-0000-0000-0000-0000000000a1/resourceGroups/rg/providers/microsoft.web/sites/api-acme-al-ord-northeurope1x", link.Url);
    }

    [Fact]
    public void Town_A_gives_every_tenant_account_of_a_database_its_own_address()
    {
        var accounts = Info(TownA, "aa.orders-db").Resources;

        Assert.Equal(3, accounts.Count);
        Assert.All(accounts, a => Assert.EndsWith("/databaseaccounts/" + a.Name, Assert.Single(a.Links!).Url));
        Assert.Equal(3, accounts.Select(a => a.Links![0].Url).Distinct().Count());
    }

    [Fact]
    public void Town_B_with_other_shapes_gives_each_resource_type_its_own_address()
    {
        var app = Info(TownB, "aa.orders-api").Resources.Single();
        var accounts = Info(TownB, "aa.orders-db").Resources;

        var console = Assert.Single(app.Links!);
        Assert.Equal(("Console", "https://console.example.test/subscriptions/00000000-0000-0000-0000-0000000000b1/apps/orders-api"), (console.Name, console.Url));
        var acme = accounts.Single(a => a.Tenant == "Acme Bank");
        var customer = Assert.Single(acme.Links!);
        Assert.Equal("Customer page", customer.Name);
        Assert.StartsWith("https://admin.example.test/customers/", customer.Url);
        Assert.EndsWith("?name=Acme%20Bank&env=prod", customer.Url);
        Assert.DoesNotContain("portal.example.test", customer.Url); // nothing of town A is in the core
    }

    [Fact]
    public void An_environment_without_links_shows_none()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "  links:\n    - { name: Cloud portal, url: \"https://portal.example.test/#@{directory}/resource{resourceId}\" }\n", "");
        var view = RegistryLoader.Load(copy.Path).ForEnvironment("prod");
        var store = new ScopeStore();
        store.Update(ResourceGraphInventory.FromRecording(File.ReadAllText(Path.Combine(TownA, "inventory.json"))), DateTimeOffset.UtcNow);

        var info = ScopeInfos.Of(view, store, "aa.orders-api")!;

        Assert.NotEmpty(info.Resources);
        Assert.All(info.Resources, r => Assert.Null(r.Links));
    }

    [Fact]
    public void A_link_for_other_types_leaves_a_resource_without_one()
    {
        var resource = new ResolvedResource("/subscriptions/s/providers/t/x", "x", "microsoft.other/things", null, null, "rule");
        var rules = new ScopeRules { Links = [new ResourceLinkRule("Portal", "https://p.example.test/{name}", ["microsoft.web/sites"])] };

        Assert.Null(ScopeLinks.For(rules, "prod", resource, "s", null));
    }

    [Fact]
    public void Values_are_percent_encoded_and_a_resource_id_keeps_its_slashes()
    {
        var resource = new ResolvedResource("/subscriptions/s/providers/t/a b?x#y", "a b?x#y", "t", "north europe", "ff", "rule");
        var rules = new ScopeRules
        {
            Variables = new Dictionary<string, string> { ["tail"] = "../x&y" },
            Links = [new ResourceLinkRule("Portal", "https://p.example.test/r{resourceId}?n={name}&r={region}&t={tail}", [])],
        };

        var link = Assert.Single(ScopeLinks.For(rules, "prod", resource, "s", null)!);

        Assert.Equal("https://p.example.test/r/subscriptions/s/providers/t/a%20b%3Fx%23y?n=a%20b%3Fx%23y&r=north%20europe&t=..%2Fx%26y", link.Url);
    }

    [Fact]
    public void An_address_that_does_not_come_out_as_http_or_https_is_dropped()
    {
        var resource = new ResolvedResource("/s", "x", "t", null, null, "rule");
        var rules = new ScopeRules { Links = [new ResourceLinkRule("Bad", "javascript:alert({name})", [])] };

        Assert.Null(ScopeLinks.For(rules, "prod", resource, null, null));
    }

    [Fact]
    public void A_template_must_start_with_the_scheme_written_out()
    {
        var message = Load(Head + "  links:\n    - { name: Portal, url: '{directory}/x' }\n", TownA);

        Assert.Contains("links 'Portal'", message);
        Assert.Contains("https://", message);
    }

    [Fact]
    public void A_template_with_an_unknown_variable_is_named()
    {
        var message = Load(Head + "  links:\n    - { name: Portal, url: 'https://p.example.test/{resourceid}' }\n", TownA);

        Assert.Contains("{resourceid} is not a variable here", message);
        Assert.Contains("{resourceId}", message);
    }

    [Fact]
    public void A_link_needs_a_name_and_names_are_unique()
    {
        Assert.Contains("needs a name", Load(Head + "  links:\n    - { name: '', url: 'https://p.example.test/' }\n", TownA));
        Assert.Contains("'Portal' is listed twice", Load(Head + "  links:\n    - { name: Portal, url: 'https://a.example.test/' }\n    - { name: Portal, url: 'https://b.example.test/' }\n", TownA));
    }
}
