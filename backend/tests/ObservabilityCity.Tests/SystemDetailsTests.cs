using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;

namespace ObservabilityCity.Tests;

/// <summary>
/// Slice 5: what the inspector's Links and Config tabs show. Every setting comes with the layer of the defaults cascade it was taken from
/// (the system's own entry, its pillar's defaults, defaults.yaml, or the built-in default), and the links are read from the registry both ways.
/// </summary>
public class SystemDetailsTests
{
    private static readonly Registry Galactic = RegistryLoader.Load(TestPaths.Registry);
    private static readonly Registry Mini = RegistryLoader.Load(TestPaths.MiniTown);

    private static ConfigValue Setting(SystemDetail d, string key) => d.Config.Single(c => c.Key == key);

    [Fact]
    public void A_system_that_is_not_in_the_registry_has_no_detail()
    {
        Assert.Null(SystemDetails.Of(Mini, "aa.nothing"));
        Assert.Null(SystemDetails.Of(Mini, ""));
    }

    [Fact]
    public void A_value_in_the_systems_own_entry_comes_from_the_system()
    {
        // cl.ledger-api: slaP99Ms: 800 in its own entry
        var d = SystemDetails.Of(Galactic, "cl.ledger-api")!;

        var sla = Setting(d, "slaP99Ms");
        Assert.Equal("800 ms", sla.Value);
        Assert.Equal(SettingLayer.System, sla.Layer);
        Assert.Equal("pillars/cl.yaml, this system", sla.Source);
    }

    [Fact]
    public void A_value_the_system_leaves_out_comes_from_its_pillars_defaults_for_its_role()
    {
        // cl.statements-api has no slaP99Ms; pillars/cl.yaml says defaults: api: { slaP99Ms: 300 }
        var sla = Setting(SystemDetails.Of(Galactic, "cl.statements-api")!, "slaP99Ms");

        Assert.Equal("300 ms", sla.Value);
        Assert.Equal(SettingLayer.Pillar, sla.Layer);
        Assert.Equal("pillars/cl.yaml, pillar defaults for api", sla.Source);
    }

    [Fact]
    public void A_value_neither_names_comes_from_defaults_yaml()
    {
        var amber = Setting(SystemDetails.Of(Galactic, "cl.ledger-api")!, "errors.amber");

        Assert.Equal("1%", amber.Value);
        Assert.Equal(SettingLayer.App, amber.Layer);
        Assert.Equal("defaults.yaml, api", amber.Source);
    }

    [Fact]
    public void A_value_nothing_names_is_the_built_in_default()
    {
        // defaults.yaml has no resources block, so the 80% and 95% are the built-in ones
        var amber = Setting(SystemDetails.Of(Galactic, "cl.ledger-api")!, "resources.amber");

        Assert.Equal("80%", amber.Value);
        Assert.Equal(SettingLayer.BuiltIn, amber.Layer);
        Assert.Equal("built-in default", amber.Source);
    }

    [Fact]
    public void The_layers_are_told_apart_for_every_setting_of_one_system()
    {
        var layers = SystemDetails.Of(Galactic, "cl.ledger-api")!.Config.ToDictionary(c => c.Key, c => c.Layer);

        Assert.Equal(SettingLayer.System, layers["role"]);
        Assert.Equal(SettingLayer.System, layers["external"]); // external: true on the system
        Assert.Equal(SettingLayer.System, layers["slaP99Ms"]);
        Assert.Equal(SettingLayer.App, layers["errors.red"]);
        Assert.Equal(SettingLayer.BuiltIn, layers["resources.red"]);
    }

    [Fact]
    public void Only_the_settings_that_apply_to_the_kind_of_system_are_listed()
    {
        var api = SystemDetails.Of(Galactic, "cl.ledger-api")!.Config.Select(c => c.Key).ToList();
        var worker = SystemDetails.Of(Galactic, "cl.ledger-worker")!.Config.Select(c => c.Key).ToList();
        var db = SystemDetails.Of(Galactic, "cl.ledger-db")!.Config.Select(c => c.Key).ToList();

        Assert.DoesNotContain("backlog.amber", api);
        Assert.DoesNotContain("throttle.amber", api);
        Assert.Contains("backlog.amber", worker);
        Assert.Contains("throttle.amber", db);
        Assert.Contains("tenantPattern", db);
        Assert.DoesNotContain("tenantPattern", api);
    }

    [Fact]
    public void A_backlog_is_told_in_seconds_and_a_tenant_pattern_as_written()
    {
        var worker = SystemDetails.Of(Galactic, "cl.ledger-worker")!;
        var db = SystemDetails.Of(Galactic, "cl.ledger-db")!;

        Assert.Equal("60 s", Setting(worker, "backlog.amber").Value);
        Assert.Equal("merchant-{tenant}-db", Setting(db, "tenantPattern").Value);
        Assert.Equal("30 s", Setting(worker, "slaP99Ms").Value); // 30000 ms, said the short way
    }

    [Fact]
    public void The_detail_names_the_file_the_island_and_the_service()
    {
        var d = SystemDetails.Of(Galactic, "cl.ledger-api")!;

        Assert.Equal("pillars/cl.yaml", d.File);
        Assert.Equal("Core Ledger", d.IslandName);
        Assert.Equal("cl", d.IslandId);
        Assert.Equal("ledger", d.Service);
        Assert.Equal(NodeKind.Api, d.Kind);
        Assert.Equal("hub.yaml", SystemDetails.Of(Mini, "hub.apim")!.File);
        Assert.Equal("third-parties.yaml", SystemDetails.Of(Mini, "ext.bureau")!.File);
    }

    [Fact]
    public void Links_are_read_in_both_directions()
    {
        var d = SystemDetails.Of(Galactic, "cl.ledger-api")!;

        Assert.Equal(["cl.ledger-db", "cl.session-cache", "cl.posting-api"], d.Calls.Select(l => l.Id));
        Assert.Contains(d.CalledBy, l => l.Id == "cl.statements-api"); // calls: [cl.statements-db, cl.ledger-api]
        Assert.All(d.Calls, l => Assert.Equal(LinkKind.System, l.Kind));
        Assert.Equal("Core Ledger", d.Calls[0].IslandName);
    }

    [Fact]
    public void Calls_through_the_gateway_are_listed_apart_from_direct_ones()
    {
        var caller = SystemDetails.Of(Galactic, "cl.statements-api")!;
        var callee = SystemDetails.Of(Galactic, "ntf.dispatch-api")!;

        Assert.Equal(["ntf.dispatch-api"], caller.GatewayCalls.Select(l => l.Id));
        Assert.DoesNotContain(caller.Calls, l => l.Id == "ntf.dispatch-api");
        Assert.Contains(callee.GatewayCalledBy, l => l.Id == "cl.statements-api");
        Assert.Equal("Core Ledger", callee.GatewayCalledBy.Single(l => l.Id == "cl.statements-api").IslandName);
    }

    [Fact]
    public void A_third_party_a_system_calls_is_among_its_calls_and_the_third_party_lists_its_callers()
    {
        var caller = SystemDetails.Of(Mini, "aa.orders-api")!;
        var vendor = SystemDetails.Of(Mini, "ext.bureau")!;

        var link = Assert.Single(caller.Calls, l => l.Kind == LinkKind.Vendor);
        Assert.Equal("ext.bureau", link.Id);
        Assert.Equal("Credit bureau", link.Name);
        Assert.Equal("Third party", link.IslandName);
        Assert.Equal(["aa.orders-api"], vendor.CalledBy.Select(l => l.Id));
        Assert.Equal("Third party", vendor.IslandName);
    }

    [Fact]
    public void Outside_callers_are_named()
    {
        Assert.Equal(["Mobile app"], SystemDetails.Of(Mini, "aa.orders-api")!.OutsideCallers);
        Assert.Empty(SystemDetails.Of(Mini, "aa.orders-worker")!.OutsideCallers);
    }

    [Fact]
    public void A_service_lists_the_topics_it_publishes_and_a_worker_the_topics_it_reads()
    {
        var worker = SystemDetails.Of(Mini, "aa.orders-worker")!;

        Assert.Equal(["aa-orders-outbox"], worker.ServiceTopics);
        var sub = Assert.Single(worker.Subscriptions);
        Assert.Equal(("bb-ledger-outbox", "bb", false), (sub.Topic, sub.Publisher, sub.Legacy));
        Assert.Empty(SystemDetails.Of(Mini, "aa.orders-api")!.Subscriptions);
    }

    [Fact]
    public void A_legacy_read_is_marked()
    {
        var legacy = Galactic.Subscriptions.First(s => s.Legacy);

        var sub = SystemDetails.Of(Galactic, legacy.ConsumerId)!.Subscriptions.Single(s => s.Topic == legacy.Topic);

        Assert.True(sub.Legacy);
    }

    [Fact]
    public void An_environment_that_leaves_a_system_out_leaves_it_out_of_the_links()
    {
        var tenants = RegistryLoader.Load(TestPaths.TenantsTown);
        var dev = tenants.ForEnvironment("dev");

        Assert.NotNull(SystemDetails.Of(tenants, "aa.tools-cron"));
        Assert.Null(SystemDetails.Of(dev, "aa.tools-cron"));
        Assert.Contains(SystemDetails.Of(tenants, "aa.orders-api")!.CalledBy, l => l.Id == "aa.tools-cron");
        Assert.DoesNotContain(SystemDetails.Of(dev, "aa.orders-api")!.CalledBy, l => l.Id == "aa.tools-cron");
    }
}
