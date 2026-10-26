using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Environments: environments/*.yaml next to the shared pillar files. The tenants-town registry has dev (test tenants only, with a whole
/// island not deployed), staging (customers and test tenants) and prod (the default).
/// </summary>
public class EnvironmentTests
{
    private static Registry Load() => RegistryLoader.Load(TestPaths.TenantsTown);

    [Fact]
    public void Environments_come_in_picker_order_and_one_is_the_default()
    {
        var registry = Load();

        Assert.Equal(["dev", "staging", "prod"], registry.Environments.Select(e => e.Id));
        Assert.Equal(["Development", "Staging", "Production"], registry.Environments.Select(e => e.Name));
        Assert.Equal("prod", registry.DefaultEnvironmentId);
    }

    [Fact]
    public void Without_a_default_marker_the_first_environment_is_the_default()
    {
        using var copy = new RegistryCopy(TestPaths.TenantsTown);
        copy.Replace("environments/prod.yaml", "default: true\n", "");

        Assert.Equal("dev", RegistryLoader.Load(copy.Path).DefaultEnvironmentId);
    }

    [Fact]
    public void A_town_without_an_environments_folder_has_the_one_demo_environment()
    {
        var registry = RegistryLoader.Load(TestPaths.MiniTown);

        Assert.Empty(registry.Environments);
        Assert.Equal(Registry.DemoEnvironmentId, registry.DefaultEnvironmentId);
        Assert.Same(registry, registry.ForEnvironment("demo")); // nothing to cut away
    }

    [Fact]
    public void Tenants_have_a_name_and_a_kind()
    {
        var staging = Load().Environments.Single(e => e.Id == "staging");

        Assert.Equal(["acme", "borealis", "qa", "smoke"], staging.Tenants.Select(t => t.Id));
        Assert.Equal([TenantKind.Customer, TenantKind.Customer, TenantKind.Test, TenantKind.Test], staging.Tenants.Select(t => t.Kind));
        Assert.Equal("Acme", staging.Tenants[0].Name);
        Assert.Equal(["ghost-co"], staging.UndeclaredTenants);
    }

    [Fact]
    public void A_tenant_without_a_name_is_called_by_its_id_and_without_a_kind_is_a_customer()
    {
        using var copy = new RegistryCopy(TestPaths.TenantsTown);
        copy.Write("environments/prod.yaml", "default: true\ntenants:\n  - { id: plain }\n");

        var tenant = Assert.Single(RegistryLoader.Load(copy.Path).Environments.Single(e => e.Id == "prod").Tenants);
        Assert.Equal(new RegistryTenant("plain", "plain", TenantKind.Customer), tenant);
    }

    [Fact]
    public void An_environment_leaves_out_what_it_excludes_and_what_hung_on_it()
    {
        var registry = Load();
        var dev = registry.ForEnvironment("dev");
        var prod = registry.ForEnvironment("prod");

        // dev: bravo has no system left, so the island is gone; the cron is gone from alpha
        Assert.DoesNotContain(dev.Groups, g => g.Id == "bb");
        Assert.Equal(["aa.orders-api", "aa.audit-cache", "aa.orders-worker", "aa.orders-db"], dev.Groups.Single(g => g.Id == "aa").Nodes.Select(n => n.Id));
        Assert.DoesNotContain(dev.ExternalCallers.SelectMany(c => c.Calls), id => id.StartsWith("bb."));
        // prod: everything
        Assert.Contains(prod.Groups, g => g.Id == "bb");
        Assert.Equal(registry.AllNodes.Count(), prod.AllNodes.Count());
        // the other environments' lists do not leak in
        Assert.Equal("dev", dev.ActiveEnvironment!.Id);
        Assert.Equal(3, dev.ActiveEnvironment.Tenants.Count);
    }

    [Fact]
    public void Excluding_a_system_drops_the_calls_that_lead_to_it_and_the_subscriptions_of_a_worker_that_is_gone()
    {
        using var copy = new RegistryCopy(TestPaths.TenantsTown);
        copy.Replace("pillars/aa.yaml", "messaging:\n  topics: [orders]\n", "messaging:\n  topics: [orders]\n  subscriptions:\n    - { topic: hub-egress, consumer: aa.orders-worker, legacy: true }\n");
        copy.Replace("environments/dev.yaml", "aa.tools-cron]", "aa.tools-cron, aa.audit-cache, aa.orders-worker]");

        var full = RegistryLoader.Load(copy.Path);
        var dev = full.ForEnvironment("dev");

        Assert.Single(full.Subscriptions);
        Assert.Empty(dev.Subscriptions);
        Assert.DoesNotContain("aa.audit-cache", dev.AllNodes.Single(n => n.Id == "aa.orders-api").Calls);
        Assert.Contains("aa.orders-db", dev.AllNodes.Single(n => n.Id == "aa.orders-api").Calls);
        // the topic of the service stays while a system of that service is deployed
        Assert.Contains(dev.Topics, t => t.Name == "aa-orders-outbox");
    }

    [Fact]
    public void The_registry_view_of_an_environment_is_made_once_per_registry()
    {
        var holder = new RegistryHolder(Load());
        var dev = new EnvironmentRegistry(holder, "dev");

        Assert.Same(dev.Current, dev.Current);
        var before = dev.Current;
        holder.Replace(Load());
        Assert.NotSame(before, dev.Current);
        Assert.DoesNotContain(dev.Current.Groups, g => g.Id == "bb");
    }

    [Fact]
    public void An_environment_with_tenant_databases_but_no_tenants_is_warned_about()
    {
        using var copy = new RegistryCopy(TestPaths.TenantsTown);
        copy.Write("environments/prod.yaml", "default: true\n");

        var prod = RegistryLoader.Load(copy.Path).ForEnvironment("prod");

        Assert.Contains(prod.Warnings, w => w.Contains("Environment 'prod' lists no tenants") && w.Contains("2 tenant databases"));
        Assert.DoesNotContain(Load().ForEnvironment("prod").Warnings, w => w.Contains("no tenants"));
    }

    // ── mistakes in the files ─────────────────────────────────────────────────

    private static string FailWith(Action<RegistryCopy> edit)
    {
        using var copy = new RegistryCopy(TestPaths.TenantsTown);
        edit(copy);
        return Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;
    }

    [Fact]
    public void Mistakes_in_an_environment_file_are_named_with_the_file()
    {
        Assert.Contains("environments/prod.yaml: tenant 'acme' has kind 'customerr'. Use customer or test. Did you mean 'customer'?",
            FailWith(c => c.Replace("environments/prod.yaml", "{ id: acme, name: Acme, kind: customer }", "{ id: acme, name: Acme, kind: customerr }")));
        Assert.Contains("environments/prod.yaml: tenant 'acme' is listed twice",
            FailWith(c => c.Replace("environments/prod.yaml", "{ id: borealis, name: Borealis, kind: customer }", "{ id: acme, name: Again, kind: customer }")));
        Assert.Contains("environments/prod.yaml: tenant id 'Acme Bank' must be lowercase kebab-case, because it is part of the tenant's database names",
            FailWith(c => c.Replace("environments/prod.yaml", "{ id: cygnus,", "{ id: Acme Bank,")));
        Assert.Contains("environments/prod.yaml (line 4): unknown key 'tenantz'. Did you mean 'tenants'?",
            FailWith(c => c.Replace("environments/prod.yaml", "tenants:", "tenantz:")));
    }

    [Fact]
    public void An_exclusion_must_name_a_system_that_exists_and_not_a_resource_of_the_hub()
    {
        Assert.Contains("environments/dev.yaml: excludes 'bb.billing-apii', which is not in this town. Did you mean 'bb.billing-api'?",
            FailWith(c => c.Replace("environments/dev.yaml", "bb.billing-api,", "bb.billing-apii,")));
        Assert.Contains("environments/dev.yaml: excludes 'hub.egress', a resource of the hub. The hub is the same in every environment",
            FailWith(c => c.Replace("environments/dev.yaml", "aa.tools-cron]", "aa.tools-cron, hub.egress]")));
    }

    [Fact]
    public void A_source_must_have_a_kebab_case_name_and_a_known_kind()
    {
        Assert.Contains("environments/staging.yaml: source name 'Metrics' must be lowercase kebab-case",
            FailWith(c => c.Replace("environments/staging.yaml", "  metrics:", "  Metrics:")));
        Assert.Contains("environments/staging.yaml: source 'metrics' has kind 'azure-monitor', which is not a kind of source. Use fake, resourcegraph, loganalytics, azuremonitor, servicebus, prometheus, grafana-irm. Did you mean 'azuremonitor'?",
            FailWith(c => c.Replace("environments/staging.yaml", "kind: fake", "kind: azure-monitor")));
    }

    [Fact]
    public void Only_one_environment_can_be_the_default()
    {
        Assert.Contains("'staging' and 'prod' are all marked default",
            FailWith(c => c.Replace("environments/staging.yaml", "order: 2", "order: 2\ndefault: true")));
    }

    [Fact]
    public void An_undeclared_tenant_cannot_also_be_listed()
    {
        Assert.Contains("environments/staging.yaml: 'acme' is both listed under tenants and an undeclared tenant",
            FailWith(c => c.Replace("environments/staging.yaml", "undeclaredTenants: [ghost-co]", "undeclaredTenants: [acme]")));
    }

    [Fact]
    public void A_tenant_pattern_belongs_on_a_database_and_must_say_where_the_tenant_goes()
    {
        Assert.Contains("aa.yaml: tenantPattern 'merchant-db' of 'aa.orders-db' must contain {tenant} exactly once",
            FailWith(c => c.Replace("pillars/aa.yaml", "merchant-{tenant}-db", "merchant-db")));
        Assert.Contains("aa.yaml: tenantPattern 'a-{tenant}-{tenant}' of 'aa.orders-db' must contain {tenant} exactly once",
            FailWith(c => c.Replace("pillars/aa.yaml", "merchant-{tenant}-db", "a-{tenant}-{tenant}")));
        Assert.Contains("aa.yaml: 'aa.orders-worker' has a tenantPattern, but only a database (role: db) keeps one database per tenant",
            FailWith(c => c.Replace("pillars/aa.yaml", "{ id: aa.orders-worker,", "{ id: aa.orders-worker, tenantPattern: \"x-{tenant}\",")));
    }

    [Fact]
    public void A_broken_environment_file_is_left_out_of_a_running_town_and_the_rest_carry_on()
    {
        using var copy = new RegistryCopy(TestPaths.TenantsTown);
        copy.Replace("environments/staging.yaml", "kind: customer }\n  - { id: borealis", "kind: customerr }\n  - { id: borealis");

        var registry = RegistryLoader.LoadResilient(copy.Path);

        Assert.Equal(["dev", "prod"], registry.Environments.Select(e => e.Id));
        Assert.Contains(registry.Notices, n => n.StartsWith("environments/staging.yaml:"));
        Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));
    }
}
