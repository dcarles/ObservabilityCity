using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Links;
using ObservabilityCity.Core.Logs;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Validate;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// The core asks what a source kind can do (read the logs, find links, read the inventory, report the cloud's health), never what it is called. Each
/// module declares it for its kinds. A second module with kind names no core code has seen (<c>metricstore</c>, <c>inventorylist</c>, <c>platformstats</c>,
/// <c>healthfeed</c>) runs the same recordings as the Azure kinds, and the town it gives is the same: anything that differed could only come from the core
/// looking at a kind's name.
/// </summary>
public class SourceCapabilityTests
{
    private static string HealthTown => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "health-town-a");
    private static string DiscoveryTown => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "discovery-town");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T01:00:00Z");

    /// <summary>Each Azure kind and the name the second module gives the same source.</summary>
    private static readonly Dictionary<string, string> OtherNames = new()
    {
        ["resourcegraph"] = "inventorylist",
        ["loganalytics"] = "metricstore",
        ["azuremonitor"] = "platformstats",
        ["resourcehealth"] = "healthfeed",
    };

    private sealed class RenamedFactory(string kind, IMetricSourceFactory inner) : IMetricSourceFactory
    {
        public string Kind => kind;
        public IMetricSource Create(SourceContext context) => inner.Create(context);
    }

    /// <summary>
    /// A module whose sources are the Azure ones on a fixed clock, under the names it is given, with the capabilities the Azure module declares for them. With
    /// the Azure names it is the Azure town; with the other names it is a cloud the core has never heard of.
    /// </summary>
    private sealed class FixedClockCloud(string name, Func<string, string> rename, TimeProvider time) : IAdapterModule
    {
        public string Name => name;

        public void Register(IAdapterRegistry registry)
        {
            foreach (var inner in new IMetricSourceFactory[] { new ResourceGraphSourceFactory(time: time), new LogAnalyticsSourceFactory(time: time), new AzureMonitorSourceFactory(time: time), new ResourceHealthSourceFactory(time: time) })
            {
                var kind = rename(inner.Kind);
                registry.AddSourceKind(new SourceKindInfo(kind) { Capabilities = AdapterContract.CapabilitiesOf(new AzureAdapters(), inner.Kind) });
                registry.AddSource(new RenamedFactory(kind, inner));
            }
        }
    }

    private static AdapterCatalog AzureAt(TimeProvider time) => new([new FixedClockCloud("azure-fixed", k => k, time)]);
    private static AdapterCatalog OtherAt(TimeProvider time) => new([new FixedClockCloud("other-cloud", k => OtherNames[k], time)]);

    /// <summary>A copy of the town with every Azure kind in its environment file written as the other module's kind.</summary>
    private static RegistryCopy Renamed(string town)
    {
        var copy = new RegistryCopy(town);
        var text = copy.Read("environments/prod.yaml");
        foreach (var (azure, other) in OtherNames) text = text.Replace($"kind: {azure}", $"kind: {other}");
        Assert.DoesNotContain("kind: resourcegraph", text);
        Assert.DoesNotContain("kind: loganalytics", text);
        copy.Write("environments/prod.yaml", text);
        return copy;
    }

    private static async Task<(Snapshot Snapshot, SourceSet Set, TownRegistry Registry)> Run(string folder, AdapterCatalog catalog, FakeTimeProvider time)
    {
        var registry = RegistryLoader.Load(folder).ForEnvironment("prod", null, catalog);
        var set = catalog.Build(registry.ActiveEnvironment!, folder);
        Assert.Empty(set.Problems);
        var state = new LatestState();
        foreach (var source in set.Sources) state.Update(source.Name, await source.PollAsync(registry, CancellationToken.None)); // the inventory is the first source
        var builder = new SnapshotBuilder(registry, state, time) { Environment = "prod", ScopeSource = set.Scope, HealthSources = set.Sources.OfType<IHealthEventSource>().ToList() };
        return (builder.Build(), set, registry);
    }

    // ---- what each module declares ----

    [Fact]
    public void The_azure_module_declares_what_each_of_its_kinds_can_serve()
    {
        var catalog = new AdapterCatalog([new AzureAdapters()]);

        Assert.Equal(SourceCapabilities.Inventory, catalog.CapabilitiesOf("resourcegraph"));
        Assert.Equal(SourceCapabilities.Logs | SourceCapabilities.Links, catalog.CapabilitiesOf("loganalytics"));
        Assert.Equal(SourceCapabilities.HealthEvents, catalog.CapabilitiesOf("resourcehealth"));
        foreach (var kind in new[] { "azuremonitor", "servicebus", "functionjobs", "fake", "prometheus", "grafana-irm" })
            Assert.Equal(SourceCapabilities.None, catalog.CapabilitiesOf(kind));
        Assert.Equal(SourceCapabilities.None, catalog.CapabilitiesOf("nobody-knows-this"));
        Assert.Equal(["loganalytics"], catalog.KindsThatCan(SourceCapabilities.Logs));
        Assert.Equal(["resourcegraph"], catalog.KindsThatCan(SourceCapabilities.Inventory));
    }

    [Fact]
    public void A_second_module_declares_the_same_capabilities_under_its_own_kind_names()
    {
        var catalog = OtherAt(TimeProvider.System);

        Assert.Equal(["metricstore"], catalog.KindsThatCan(SourceCapabilities.Logs));
        Assert.Equal(["metricstore"], catalog.KindsThatCan(SourceCapabilities.Links));
        Assert.Equal(["inventorylist"], catalog.KindsThatCan(SourceCapabilities.Inventory));
        Assert.Equal(["healthfeed"], catalog.KindsThatCan(SourceCapabilities.HealthEvents));
        Assert.False(catalog.Knows("loganalytics"));
    }

    // ---- logs ----

    private const string Logs = "\nlogs:\n  source: telemetry\n  query: \"AppRequests | where AppRoleName in ({roles})\"\n";

    private static IReadOnlyList<string> Problems(AdapterCatalog catalog, RegistryCopy copy) => catalog.Check(RegistryLoader.Load(copy.Path).Environments.Single());

    [Fact]
    public void Logs_must_name_a_source_whose_kind_can_read_logs_whatever_the_kind_is_called()
    {
        using var copy = Renamed(HealthTown);
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + Logs);
        Assert.Empty(Problems(OtherAt(TimeProvider.System), copy));

        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml").Replace("  source: telemetry", "  source: inventory"));
        Assert.Contains("environments/prod.yaml: logs.source 'inventory' has kind inventorylist, which cannot read the logs. Name a source of a kind that can: metricstore", Problems(OtherAt(TimeProvider.System), copy));
    }

    [Fact]
    public void A_kind_no_module_knows_is_named_once_and_nothing_is_guessed_about_what_it_can_do()
    {
        // the files are checked without any module: what a kind can do is only known once a module for it is loaded
        using var copy = Renamed(HealthTown);
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + Logs);
        var environment = RegistryLoader.Load(copy.Path).Environments.Single();

        var problems = new AdapterCatalog([new AzureAdapters()]).Check(environment);

        Assert.Contains(problems, p => p.Contains("source 'telemetry' has kind 'metricstore', which is not a kind of source this build knows"));
        Assert.DoesNotContain(problems, p => p.Contains("logs.source"));
        Assert.Equal(0, RegistryValidator.Validate(copy.Path).Errors);
    }

    [Fact]
    public async Task The_logs_tab_reads_the_same_rows_from_a_source_of_another_kind()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-01T12:00:00Z"));
        using var other = Renamed(DiscoveryTown);

        async Task<string> Logs(string folder, AdapterCatalog catalog)
        {
            var holder = new RegistryHolder(RegistryLoader.Load(folder));
            var view = new EnvironmentRegistry(holder, "prod", kinds: catalog);
            var set = catalog.Build(view.Current.ActiveEnvironment!, folder);
            Assert.Empty(set.Problems);
            var logs = new QueryLogSource(set.Sources, view, set.Scope!, time);
            var api = view.Current.AllNodes.Single(n => n.Id == "aa.orders-api");
            return JsonSerializer.Serialize(await logs.RecentAsync(api, TestContext.Current.CancellationToken));
        }

        var azure = await Logs(DiscoveryTown, AzureAt(time));
        Assert.Contains("\"Configured\":true", azure);
        Assert.Equal(azure, await Logs(other.Path, OtherAt(time)));
    }

    // ---- links ----

    private sealed class Dependencies(string name, IReadOnlyList<DependencyRow> rows) : IMetricSource, IDependencySource
    {
        public string Name => name;
        public TimeSpan PollInterval => TimeSpan.FromSeconds(30);
        public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct) => Task.FromResult<IReadOnlyDictionary<string, NodeReading>>(new Dictionary<string, NodeReading>());
        public bool CanReadDependencies => true;
        public Task<IReadOnlyList<DependencyRow>> ReadDependenciesAsync(TownRegistry registry, string query, IReadOnlyCollection<string> roles, DateTimeOffset from, DateTimeOffset to, CancellationToken ct) => Task.FromResult(rows);
    }

    /// <summary>A module of one kind, written from scratch: a metrics store that can also answer the link discovery query.</summary>
    private sealed class MetricStore(IReadOnlyList<DependencyRow> rows) : IAdapterModule, IMetricSourceFactory
    {
        public string Name => "metric-store";
        public string Kind => "metricstore";
        public void Register(IAdapterRegistry registry)
        {
            registry.AddSourceKind(new SourceKindInfo(Kind) { Capabilities = SourceCapabilities.Links });
            registry.AddSource(this);
        }
        public IMetricSource Create(SourceContext context) => new Dependencies(context.Source.Name, rows);
    }

    [Fact]
    public void Links_must_name_a_source_whose_kind_can_read_dependencies()
    {
        using var copy = Renamed(DiscoveryTown);
        Assert.Empty(Problems(OtherAt(TimeProvider.System), copy));

        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml").Replace("links:\n  source: telemetry", "links:\n  source: platform"));
        Assert.Contains("environments/prod.yaml: links.source 'platform' has kind platformstats, which cannot read the dependencies link discovery needs. Name a source of a kind that can: metricstore", Problems(OtherAt(TimeProvider.System), copy));
    }

    [Fact]
    public async Task Link_discovery_finds_links_through_a_source_of_another_kind()
    {
        var now = DateTimeOffset.Parse("2026-10-31T00:00:00Z");
        var clock = new FakeTimeProvider(now);
        using var copy = Renamed(DiscoveryTown);
        var days = new[] { DateOnly.Parse("2026-10-27"), DateOnly.Parse("2026-10-29") };
        var module = new MetricStore([new DependencyRow("OrdersWorker", "ledger-worker.be.a.example.test", null, days, 100)]);
        var catalog = new AdapterCatalog([new FixedClockCloud("other-cloud", k => OtherNames[k], clock), module]); // the hand-written module comes last, so metricstore is its own
        var holder = new RegistryHolder(RegistryLoader.Load(copy.Path));
        var set = catalog.Build(holder.Current.Environments.Single(), copy.Path);
        var store = new DiscoveredLinks();

        // the host's choice: the source links.source names, if it can read dependencies; its kind is not looked at
        var source = set.Sources.OfType<IDependencySource>().Single(s => s.CanReadDependencies && ((IMetricSource)s).Name == holder.Current.Environments.Single().Links!.Source);
        await new LinkDiscoveryRunner(source, set.Scope!, new EnvironmentRegistry(holder, "prod", store, clock), store, clock, NullLogger<LinkDiscoveryRunner>.Instance).RunOnceAsync(CancellationToken.None);

        var worker = new EnvironmentRegistry(holder, "prod", store, clock).Current.AllNodes.Single(n => n.Id == "aa.orders-worker");
        Assert.Equal(DateOnly.Parse("2026-10-29"), worker.FoundCalls["bb.ledger-worker"]);
    }

    // ---- the inventory ----

    [Fact]
    public void The_scope_inventory_must_name_a_source_whose_kind_can_read_an_inventory()
    {
        using var copy = Renamed(HealthTown);
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml").Replace("  inventory: inventory\n", "  inventory: telemetry\n"));

        Assert.Contains("environments/prod.yaml: scope.inventory 'telemetry' has kind metricstore, which cannot read the inventory. Name a source of a kind that can: inventorylist", Problems(OtherAt(TimeProvider.System), copy));
    }

    [Fact]
    public async Task The_inspector_says_the_inventory_is_waiting_or_read_for_an_inventory_source_of_any_kind_and_none_without_one()
    {
        using var copy = Renamed(HealthTown);
        var time = new FakeTimeProvider(T0);
        var registry = RegistryLoader.Load(copy.Path).ForEnvironment("prod");

        var unknown = new AdapterCatalog([]).Build(registry.ActiveEnvironment!, copy.Path).Scope!;
        Assert.Equal("none", ScopeInfos.Of(registry, unknown, "aa.orders-api")!.InventoryState); // nothing loaded says inventorylist reads one

        var set = OtherAt(time).Build(registry.ActiveEnvironment!, copy.Path);
        Assert.True(set.Scope!.HasInventorySource);
        Assert.Equal("waiting", ScopeInfos.Of(registry, set.Scope, "aa.orders-api")!.InventoryState);
        await set.Sources.Single(s => s.Name == "inventory").PollAsync(registry, CancellationToken.None);
        Assert.Equal("read", ScopeInfos.Of(registry, set.Scope, "aa.orders-api")!.InventoryState);
    }

    // ---- the cloud's health reports ----

    [Fact]
    public void A_health_report_source_of_any_kind_is_not_named_as_unused_and_without_the_modules_nothing_is_known_of_it()
    {
        using var copy = Renamed(HealthTown);
        var registry = RegistryLoader.Load(copy.Path);
        const string unused = "defines source 'health', but no signal uses it";

        Assert.DoesNotContain(registry.ForEnvironment("prod", null, OtherAt(TimeProvider.System)).Warnings, w => w.Contains(unused));
        Assert.DoesNotContain(RegistryLoader.Load(HealthTown).ForEnvironment("prod", null, new AdapterCatalog([new AzureAdapters()])).Warnings, w => w.Contains(unused));
        Assert.Contains(registry.ForEnvironment("prod", null, new AdapterCatalog([new AzureAdapters()])).Warnings, w => w.Contains(unused)); // healthfeed means nothing to the Azure module
        Assert.Contains(registry.ForEnvironment("prod").Warnings, w => w.Contains(unused));
    }

    // ---- the whole town ----

    [Fact]
    public void A_town_on_the_other_kinds_loads_and_passes_the_validator_with_its_module()
    {
        using var copy = Renamed(DiscoveryTown);

        _ = RegistryLoader.Load(copy.Path);
        var result = RegistryValidator.Validate(copy.Path, OtherAt(TimeProvider.System));

        Assert.Equal(0, result.Errors);
        Assert.Equal(RegistryValidator.Validate(DiscoveryTown, new AdapterCatalog([new AzureAdapters()])).Findings.Select(f => f.Message), result.Findings.Select(f => f.Message));
    }

    [Fact]
    public async Task A_town_on_the_other_kinds_gives_the_same_snapshot_as_on_the_azure_kinds()
    {
        using var copy = Renamed(HealthTown);

        var azure = await Run(HealthTown, AzureAt(new FakeTimeProvider(T0)), new FakeTimeProvider(T0));
        var other = await Run(copy.Path, OtherAt(new FakeTimeProvider(T0)), new FakeTimeProvider(T0));

        Assert.Contains(azure.Snapshot.Groups.SelectMany(g => g.Nodes), n => n.RequestsPerSecond > 0); // the comparison is of a town with data in it
        Assert.Single(other.Set.Sources.OfType<IHealthEventSource>());
        Assert.NotEmpty(other.Set.Sources.OfType<IHealthEventSource>().Single().Current());
        Assert.Equal(JsonSerializer.Serialize(azure.Snapshot), JsonSerializer.Serialize(other.Snapshot));
        Assert.Equal(azure.Registry.Warnings, other.Registry.Warnings);
    }
}
