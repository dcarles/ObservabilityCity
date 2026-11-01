using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Links;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Core.Snapshots;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// A vendor can be a group of services on one island, each recognised by the address its calls go to, and the calls link discovery finds are drawn
/// to the right building. The addresses are the town's own: the same logical calls in two towns with different hosts and paths find the same links.
/// </summary>
public class VendorIslandTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);
    private static string Town(string name) => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", name);
    private static DateOnly[] Days(params string[] days) => days.Select(DateOnly.Parse).ToArray();

    private const string ServicesA = """
        vendors:
          - { id: ext.bureau, name: Credit bureau, calledBy: [aa.orders-api], slaP99Ms: 1500 }
          - id: ext.shared
            name: Shared services
            internal: true
            slaP99Ms: 800
            services:
              - { id: credit, name: Credit, match: [{ host: shared.a.example.test, path: '^/credit' }] }
              - { id: identity, name: Identity, match: [{ host: shared.a.example.test, path: '^/identity' }, { host: id.a.example.test }], slaP99Ms: 300 }
        """;

    // Town B writes the same two services with other hosts, no path on one of them and a declared caller.
    private const string ServicesB = """
        vendors:
          - { id: ext.bureau, name: Credit bureau, calledBy: [aa.orders-api], slaP99Ms: 1500 }
          - id: ext.shared
            name: Shared services
            internal: true
            services:
              - { id: credit, name: Credit, match: [{ host: credit.platform.b.example.test }] }
              - { id: identity, name: Identity, calledBy: [bb.ledger-api], match: [{ host: platform.b.example.test, path: '^/who/' }] }
        """;

    private sealed class Harness : IDisposable
    {
        private readonly RegistryCopy _copy;
        public RegistryHolder Holder { get; }
        public DiscoveredLinks Store { get; } = new();
        public ScopeStore Scope { get; } = new();
        public FakeTimeProvider Clock { get; } = new(Now);
        public EnvironmentRegistry View => new(Holder, "prod", Store, Clock);

        public Harness(bool a, string vendors)
        {
            _copy = new RegistryCopy(Town(a ? "scope-town-a" : "scope-town-b"));
            _copy.Write("environments/prod.yaml", _copy.Read("environments/prod.yaml") + (a ? LinkDiscoveryTests.LinksA : LinkDiscoveryTests.LinksB));
            _copy.Write("third-parties.yaml", vendors);
            Holder = new RegistryHolder(RegistryLoader.Load(_copy.Path));
        }

        public string Role(string system) => Scope.Resolve(View.Current).Systems.First(s => s.SystemId == system).TelemetryRole!;

        public async Task Run(params (string Caller, string Host, string? Path)[] calls)
        {
            var rows = calls.Select(c => new DependencyRow(Role(c.Caller), c.Host, c.Path, Days("2026-10-28", "2026-10-30"), 100)).ToList();
            var runner = new LinkDiscoveryRunner(new Rows(rows), Scope, View, Store, Clock, NullLogger<LinkDiscoveryRunner>.Instance);
            await runner.RunOnceAsync(CancellationToken.None);
        }

        public void Dispose() => _copy.Dispose();
    }

    private sealed class Rows(IReadOnlyList<DependencyRow> rows) : IDependencySource
    {
        public bool CanReadDependencies => true;
        public Task<IReadOnlyList<DependencyRow>> ReadDependenciesAsync(TownRegistry registry, string query, IReadOnlyCollection<string> roles, DateTimeOffset from, DateTimeOffset to, CancellationToken ct) =>
            Task.FromResult(rows);
    }

    // ---- the registry ----

    [Fact]
    public void A_vendor_with_services_is_one_island_with_a_building_for_each_service()
    {
        using var town = new Harness(true, ServicesA);

        var shared = town.Holder.Current.Vendors.Where(v => v.IslandId == "ext.shared").ToList();

        Assert.Equal(["ext.shared-credit", "ext.shared-identity"], shared.Select(v => v.Node.Id));
        Assert.All(shared, v => { Assert.True(v.Internal); Assert.Equal("Shared services", v.IslandName); });
        Assert.Equal([800.0, 300.0], shared.Select(v => v.Node.SlaP99Ms)); // a service may override the vendor's target
        Assert.Equal(2, shared[1].Matches.Count);
        var bureau = town.Holder.Current.Vendors.Single(v => v.Node.Id == "ext.bureau");
        Assert.Null(bureau.IslandId); // a plain vendor stays its own island
        Assert.False(bureau.Internal);
    }

    [Fact]
    public void Services_need_a_match_and_calledBy_goes_on_each_service()
    {
        using var town = new Harness(true, ServicesA);
        var bad = ServicesA.Replace("internal: true", "internal: true\n    calledBy: [aa.orders-api]").Replace("match: [{ host: shared.a.example.test, path: '^/credit' }]", "match: []");
        var copy = new RegistryCopy(Town("scope-town-a"));
        using var _ = copy;
        copy.Write("third-parties.yaml", bad);

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("has services, so calledBy goes on each service", e.Message);
        Assert.Contains("service 'credit' of 'ext.shared' needs match", e.Message);
    }

    [Fact]
    public void A_path_that_is_not_a_pattern_is_reported()
    {
        var copy = new RegistryCopy(Town("scope-town-a"));
        using var _ = copy;
        copy.Write("third-parties.yaml", ServicesA.Replace("'^/credit'", "'(^/credit'"));

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("path '(^/credit' is not a valid pattern", e.Message);
    }

    [Fact]
    public void A_vendors_buildings_take_no_signals_from_the_environment()
    {
        using var town = new Harness(true, ServicesA);
        var registry = town.View.Current;
        var vendor = registry.Vendors.First(v => v.IslandId == "ext.shared").Node;
        var system = registry.AllNodes.First();

        // the environment names sources for the town's own systems; nothing reads them for a third party's building
        Assert.NotNull(registry.SourceFor(system, Signals.Requests));
        Assert.All(Signals.All, signal => Assert.Null(registry.SourceFor(vendor, signal)));
        Assert.Equal(Signals.All.Length, registry.AbsentSignals(vendor).Count);
    }

    // ---- the classifier ----

    private static LinkClassifier Classifier(IEnumerable<RegistryVendor> vendors) =>
        new(new LinkDiscovery("logs", "q", TimeSpan.FromHours(1), TimeSpan.FromDays(7), 2, TimeSpan.FromDays(30), [], [], new Dictionary<string, string>()), vendors, ["aa.orders-api"]);

    [Fact]
    public void A_call_goes_to_the_service_whose_host_and_path_fit_and_the_first_one_wins()
    {
        using var town = new Harness(true, ServicesA);
        var classifier = Classifier(town.Holder.Current.Vendors);
        Classified Of(string host, string? path) => classifier.Classify(new DependencyRow("x", host, path, Days("2026-10-29"), 10), "aa");

        Assert.Equal(new Classified(LinkOutcome.Found, "ext.shared-credit"), Of("shared.a.example.test", "/credit/v2/score"));
        Assert.Equal(new Classified(LinkOutcome.Found, "ext.shared-identity"), Of("shared.a.example.test", "/identity/me"));
        Assert.Equal(new Classified(LinkOutcome.Found, "ext.shared-identity"), Of("eu.id.a.example.test", null)); // a host entry without a path takes every path, subdomains included
        Assert.Equal(LinkOutcome.Unresolved, Of("shared.a.example.test", "/other").Outcome); // right host, no service for the path
        Assert.Equal(LinkOutcome.Unresolved, Of("shared.a.example.test", null).Outcome); // a pattern needs a path to look at
        Assert.Equal(LinkOutcome.Unresolved, Of("notshared.a.example.test", "/credit").Outcome);
    }

    // ---- discovery, in two towns with different addresses ----

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Calls_found_to_the_services_are_drawn_from_the_callers_to_the_right_buildings(bool a)
    {
        using var town = new Harness(a, a ? ServicesA : ServicesB);
        var (credit, identity) = a
            ? (("shared.a.example.test", "/credit/v1"), ("shared.a.example.test", "/identity/v1"))
            : (("credit.platform.b.example.test", (string?)null), ("platform.b.example.test", "/who/am"));

        await town.Run(("aa.orders-api", credit.Item1, credit.Item2), ("aa.orders-worker", credit.Item1, credit.Item2), ("bb.ledger-api", identity.Item1, identity.Item2));

        var vendors = town.View.Current.Vendors.ToDictionary(v => v.Node.Id);
        Assert.Equal(["aa.orders-api", "aa.orders-worker"], vendors["ext.shared-credit"].CalledBy.Order(StringComparer.Ordinal));
        Assert.Equal(["bb.ledger-api"], vendors["ext.shared-identity"].CalledBy);
        Assert.DoesNotContain(town.Store.Notices(5), n => n.StartsWith("Unresolved call"));
        // the snapshot carries the island, so the browser stands both buildings on one island
        var snapshot = new SnapshotBuilder(town.View, new ObservabilityCity.Core.Sources.LatestState(), town.Clock).Build();
        var onIsland = snapshot.Vendors.Where(v => v.IslandId == "ext.shared").ToList();
        Assert.Equal(2, onIsland.Count);
        Assert.All(onIsland, v => { Assert.True(v.Internal); Assert.Equal("Shared services", v.IslandName); });
        Assert.Equal("ext.bureau", snapshot.Vendors.Single(v => v.Node.Id == "ext.bureau").IslandId);
    }

    [Fact]
    public async Task A_caller_with_discoverLinks_off_adds_nothing_to_a_service()
    {
        var clock = new FakeTimeProvider(Now);
        using var town = new Harness(true, ServicesA);
        var copy = new RegistryCopy(Town("scope-town-a"));
        using var _ = copy;
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + LinkDiscoveryTests.LinksA);
        copy.Write("third-parties.yaml", ServicesA);
        copy.Replace("pillars/aa.yaml", "id: aa.orders-worker,", "id: aa.orders-worker, discoverLinks: false,");
        var holder = new RegistryHolder(RegistryLoader.Load(copy.Path));
        var store = new DiscoveredLinks();
        var scope = new ScopeStore();
        var view = new EnvironmentRegistry(holder, "prod", store, clock);
        var role = scope.Resolve(view.Current).Systems.First(s => s.SystemId == "aa.orders-api").TelemetryRole!;
        var rows = new[] { new DependencyRow(role, "shared.a.example.test", "/credit/x", Days("2026-10-28", "2026-10-30"), 100) };

        await new LinkDiscoveryRunner(new Rows(rows), scope, view, store, clock, NullLogger<LinkDiscoveryRunner>.Instance).RunOnceAsync(CancellationToken.None);

        Assert.Equal(["aa.orders-api"], view.Current.Vendors.Single(v => v.Node.Id == "ext.shared-credit").CalledBy);
    }
}
