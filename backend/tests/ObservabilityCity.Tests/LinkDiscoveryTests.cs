using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Links;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 3, slice 1: links come from the calls the systems really make. The rules that turn an address into a system are the environment's own,
/// so the same logical calls, written in two towns with opposite address conventions, must find the same links. The core knows no host name.
/// </summary>
public class LinkDiscoveryTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-b");
    private static readonly DateTimeOffset Now = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);

    private static DateOnly D(string day) => DateOnly.Parse(day);
    private static DateOnly[] Days(params string[] days) => days.Select(D).ToArray();

    // ---- the classifier ----

    private static LinkDiscovery Rules(IEnumerable<LinkRule>? rules = null, IEnumerable<string>? ignore = null, Dictionary<string, string>? aliases = null) =>
        new("logs", "q", TimeSpan.FromHours(1), TimeSpan.FromDays(7), 2, TimeSpan.FromDays(30), ignore?.ToList() ?? [], rules?.ToList() ?? [], aliases ?? new Dictionary<string, string>());

    private static readonly string[] Systems = ["aa.orders-api", "aa.orders-worker", "bb.ledger-api", "bb.ledger-worker"];

    private static Classified Classify(LinkDiscovery rules, string host, string? path = null, IEnumerable<RegistryVendor>? vendors = null) =>
        new LinkClassifier(rules, vendors ?? [], Systems).Classify(new DependencyRow("x", host, path, Days("2026-10-29"), 10), "aa");

    private static readonly LinkRule Direct = new(@"^(?<service>[a-z]+)-(?<role>api|worker)\.(?<pillar>[a-z]+)\.example\.test$", null, "{pillar}.{service}-{role}", false);
    private static readonly LinkRule ViaGateway = new(@"^gw\.example\.test$", @"^/(?<pillar>[a-z]+)/(?<service>[a-z]+)/(?<role>api|worker)\b", "{pillar}.{service}-{role}", true);

    // ---- addresses that carry a service code instead of the name ----

    private static readonly string[] CodedSystems = ["aa.orders-api", "aa.orders-worker", "aa.orders-db", "aa.stock-levels-api", "bb.ledger-api", "bb.orders-api"];
    private static readonly ServiceCodeEntry[] Codes =
    [
        new("aa", "orders", "ord"), new("aa", "orders", "ord"), new("aa", "stock-levels", "sl"),
        new("bb", "ledger", "led"), new("bb", "orders", "led2"),
    ];

    private static readonly LinkRule ByCode = new(@"^(?<service>[a-z0-9]+)\.(?<pillar>[a-z]+)\.example\.test$", null, "{pillar}.{service}-api", false);

    private static Classified ClassifyCoded(string host, Dictionary<string, string>? aliases = null) =>
        new LinkClassifier(Rules([ByCode], aliases: aliases), [], CodedSystems, Codes).Classify(new DependencyRow("x", host, null, Days("2026-10-29"), 10), "aa");

    [Fact]
    public void An_address_that_carries_the_service_code_finds_the_service_whose_name_is_longer()
    {
        Assert.Equal(new Classified(LinkOutcome.Found, "aa.stock-levels-api", false), ClassifyCoded("sl.aa.example.test"));
        Assert.Equal(new Classified(LinkOutcome.Found, "aa.orders-api", false), ClassifyCoded("ord.aa.example.test"));
    }

    [Fact]
    public void A_code_is_read_in_the_pillar_the_address_names_so_the_same_code_in_two_pillars_does_not_clash()
    {
        Assert.Equal(new Classified(LinkOutcome.Found, "bb.ledger-api", false), ClassifyCoded("led.bb.example.test"));
        Assert.Equal(new Classified(LinkOutcome.Found, "bb.orders-api", false), ClassifyCoded("led2.bb.example.test"));
        Assert.Equal(LinkOutcome.Unresolved, ClassifyCoded("led.aa.example.test").Outcome);
    }

    [Fact]
    public void A_service_name_in_the_address_still_works_and_wins_over_a_code()
    {
        Assert.Equal(new Classified(LinkOutcome.Found, "aa.orders-api", false), ClassifyCoded("orders.aa.example.test"));
    }

    [Fact]
    public void An_alias_wins_over_the_code_lookup()
    {
        Assert.Equal(new Classified(LinkOutcome.Found, "aa.orders-api", false), ClassifyCoded("sl.aa.example.test", new() { ["sl"] = "orders" }));
    }

    [Fact]
    public void A_code_shared_by_two_services_of_one_pillar_is_never_guessed()
    {
        ServiceCodeEntry[] clash = [new("aa", "orders", "x"), new("aa", "stock-levels", "x")];
        var result = new LinkClassifier(Rules([ByCode]), [], CodedSystems, clash).Classify(new DependencyRow("x", "x.aa.example.test", null, Days("2026-10-29"), 10), "aa");

        Assert.Equal(LinkOutcome.Unresolved, result.Outcome);
    }

    [Fact]
    public void A_host_rule_turns_an_address_into_a_system_by_the_groups_it_captures()
    {
        var found = Classify(Rules([Direct]), "ledger-api.bb.example.test");

        Assert.Equal(new Classified(LinkOutcome.Found, "bb.ledger-api", false), found);
    }

    [Fact]
    public void A_gateway_rule_reads_the_destination_from_the_path_and_marks_the_call_as_a_gateway_call()
    {
        var found = Classify(Rules([ViaGateway]), "gw.example.test", "/bb/ledger/api/v1/accounts");

        Assert.Equal(new Classified(LinkOutcome.Found, "bb.ledger-api", true), found);
    }

    [Fact]
    public void A_gateway_rule_does_not_match_a_call_that_has_no_path()
    {
        Assert.Equal(LinkOutcome.Unresolved, Classify(Rules([ViaGateway]), "gw.example.test", null).Outcome);
    }

    [Fact]
    public void The_caller_pillar_is_a_variable_so_a_rule_can_mean_a_system_on_the_callers_own_island()
    {
        var own = new LinkRule(@"^(?<service>[a-z]+)-(?<role>api|worker)\.local\.example\.test$", null, "{callerPillar}.{service}-{role}", false);

        Assert.Equal("aa.orders-worker", Classify(Rules([own]), "orders-worker.local.example.test").Target);
    }

    [Fact]
    public void Aliases_translate_what_the_address_calls_a_pillar_into_what_the_registry_calls_it()
    {
        var found = Classify(Rules([Direct], aliases: new() { ["ledgerland"] = "bb" }), "ledger-api.ledgerland.example.test");

        Assert.Equal("bb.ledger-api", found.Target);
    }

    [Fact]
    public void Matching_ignores_case()
    {
        Assert.Equal("bb.ledger-api", Classify(Rules([Direct]), "Ledger-API.BB.Example.Test").Target);
    }

    [Fact]
    public void Platform_noise_is_ignored_before_any_rule_looks_at_it()
    {
        var rules = Rules([Direct], ignore: [@"^169\.254\.", @"\.vault\.example\.test$"]);

        Assert.Equal(LinkOutcome.Ignored, Classify(rules, "169.254.169.254").Outcome);
        Assert.Equal(LinkOutcome.Ignored, Classify(rules, "secrets.vault.example.test").Outcome);
    }

    [Fact]
    public void A_rule_whose_result_is_not_a_system_of_the_town_does_not_count_and_the_address_is_unresolved()
    {
        Assert.Equal(LinkOutcome.Unresolved, Classify(Rules([Direct]), "nothing-api.bb.example.test").Outcome);
    }

    [Fact]
    public void A_later_rule_is_tried_when_an_earlier_one_matches_but_names_nothing()
    {
        var first = new LinkRule(@"^(?<service>[a-z]+)-api\.bb\.example\.test$", null, "zz.{service}", false);
        var second = new LinkRule(@"^(?<service>[a-z]+)-api\.bb\.example\.test$", null, "bb.{service}-api", false);

        Assert.Equal("bb.ledger-api", Classify(Rules([first, second]), "ledger-api.bb.example.test").Target);
    }

    [Fact]
    public void A_vendors_domain_is_recognised_for_the_host_itself_and_everything_under_it()
    {
        var node = new RegistryNode("ext.bureau", "Bureau", "ext", NodeKind.Api, null, false, 1000, 0.01, 0.05, 0.8, 0.95, 0.001, 0.02, 60, 300, []);
        var vendors = new[] { new RegistryVendor(node, ["aa.orders-api"]) { Domains = ["bureau.example.test"] } };

        Assert.Equal(LinkOutcome.Vendor, Classify(Rules(), "bureau.example.test", vendors: vendors).Outcome);
        Assert.Equal(LinkOutcome.Vendor, Classify(Rules(), "api.bureau.example.test", vendors: vendors).Outcome);
        Assert.Equal(vendors[0].Node.Id, Classify(Rules(), "api.bureau.example.test", vendors: vendors).Target); // its id, so the calls to it can be counted
        Assert.Equal(LinkOutcome.Unresolved, Classify(Rules(), "notbureau.example.test", vendors: vendors).Outcome);
    }

    // ---- the store ----

    [Fact]
    public void A_link_is_found_only_when_it_was_seen_on_enough_different_days_even_across_separate_reads()
    {
        var store = new DiscoveredLinks();
        store.RecordLink("aa.orders-api", "bb.ledger-api", true, Days("2026-10-29"));
        Assert.Empty(store.Found(Now, 2, TimeSpan.FromDays(30)));

        store.RecordLink("aa.orders-api", "bb.ledger-api", true, Days("2026-10-29", "2026-10-30")); // the same day twice counts once
        var found = Assert.Single(store.Found(Now, 2, TimeSpan.FromDays(30)));

        Assert.Equal(new FoundLink("aa.orders-api", "bb.ledger-api", true, D("2026-10-30")), found);
    }

    [Fact]
    public void A_link_drops_off_after_keepFor_without_being_seen_and_its_old_days_stop_counting()
    {
        var store = new DiscoveredLinks();
        store.RecordLink("aa.orders-api", "bb.ledger-api", true, Days("2026-09-01", "2026-09-02"));
        store.RecordLink("aa.orders-worker", "bb.ledger-api", false, Days("2026-09-15", "2026-10-29"));

        var keep = TimeSpan.FromDays(30);

        Assert.Empty(store.Found(Now, 2, keep)); // the first link is a month old; of the worker's, only one day is within 30 days
        store.RecordLink("aa.orders-worker", "bb.ledger-api", false, Days("2026-10-28"));
        Assert.Single(store.Found(Now, 2, keep));

        store.Prune(Now, keep);
        Assert.Single(store.Found(Now, 1, TimeSpan.FromDays(3650))); // the old link is gone for good, not just hidden
    }

    [Fact]
    public void The_store_is_saved_per_pillar_and_the_next_start_carries_on_from_where_the_last_read_ended()
    {
        var dir = Path.Combine(Directory.CreateTempSubdirectory().FullName, "links");
        var first = new DiscoveredLinks(dir);
        first.RecordLink("aa.orders-api", "bb.ledger-api", true, Days("2026-10-28", "2026-10-29"));
        first.RecordLink("bb.ledger-worker", "bb.ledger-api", false, Days("2026-10-29", "2026-10-30"));
        first.RecordUnresolved("aa.orders-api", "mystery.example.test", "/x", Days("2026-10-28", "2026-10-29"), 120);
        first.Finish(Now);
        first.Save();

        Assert.True(File.Exists(Path.Combine(dir, "aa.yaml")));
        Assert.True(File.Exists(Path.Combine(dir, "bb.yaml")));
        Assert.Contains("lastSeen: 2026-10-29", File.ReadAllText(Path.Combine(dir, "aa.yaml")));

        var second = new DiscoveredLinks(dir);
        Assert.Equal(Now, second.ReadUpTo);
        Assert.Equal(first.Found(Now, 2, TimeSpan.FromDays(30)), second.Found(Now, 2, TimeSpan.FromDays(30)));
        Assert.Contains("mystery.example.test/x", Assert.Single(second.Notices(2)));
    }

    [Fact]
    public void A_damaged_saved_file_costs_a_longer_read_and_never_stops_the_town()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        File.WriteAllText(Path.Combine(dir, "aa.yaml"), "links: [ this is: not: yaml");

        var store = new DiscoveredLinks(dir, NullLogger.Instance);

        Assert.Empty(store.Found(Now, 1, TimeSpan.FromDays(30)));
    }

    [Fact]
    public void Unresolved_addresses_are_notices_only_once_seen_on_enough_days_the_busiest_first_and_a_failed_read_comes_first()
    {
        var store = new DiscoveredLinks();
        store.RecordUnresolved("aa.orders-api", "quiet.example.test", null, Days("2026-10-29", "2026-10-30"), 5);
        store.RecordUnresolved("aa.orders-api", "busy.example.test", null, Days("2026-10-29", "2026-10-30"), 500);
        store.RecordUnresolved("aa.orders-api", "once.example.test", null, Days("2026-10-30"), 9000);
        store.Fail("Log Analytics answered 403");

        var notices = store.Notices(2);

        Assert.Equal(3, notices.Count);
        Assert.StartsWith("Link discovery failed, still showing the links found before: Log Analytics answered 403", notices[0]);
        Assert.Contains("busy.example.test", notices[1]);
        Assert.Contains("quiet.example.test", notices[2]);
    }

    // ---- two towns with opposite address conventions ----

    private const string QueryText = "AppDependencies | where AppRoleName in ({roles}) | where TimeGenerated between (datetime({from}) .. datetime({to}))";

    // Town A: services have their own hosts, <service>-<role>.<pillar code>.a.example.test, and a gateway whose path starts with the pillar code.
    internal const string LinksA = """

        links:
          source: telemetry
          query: "AppDependencies | where AppRoleName in ({roles}) | where TimeGenerated between (datetime({from}) .. datetime({to}))"
          ignoreHosts: ['^169\.254\.']
          rules:
            - { host: '^(?<service>[a-z]+)-(?<role>api|worker)\.(?<pillar>[a-z]+)\.a\.example\.test$', target: '{pillar}.{service}-{role}' }
            - { host: '^gw\.a\.example\.test$', path: '^/(?<pillar>[a-z]+)/(?<service>[a-z]+)/(?<role>api|worker)', target: '{pillar}.{service}-{role}', gateway: true }
          aliases: { al: aa, be: bb }
        """;

    // Town B: no gateway path rule at all; every service is one flat host with the parts in another order, and the pillars are spelt out.
    internal const string LinksB = """

        links:
          source: telemetry
          query: "AppDependencies | where AppRoleName in ({roles}) | where TimeGenerated between (datetime({from}) .. datetime({to}))"
          interval: 30m
          minDays: 2
          ignoreHosts: ['\.vault\.b\.example\.test$']
          rules:
            - { host: '^(?<role>api|worker)--(?<service>[a-z]+)--(?<pillar>[a-z]+)\.b\.example\.test$', target: '{pillar}.{service}-{role}' }
            - { host: '^edge\.b\.example\.test$', path: '^/v1/(?<service>[a-z]+)\.(?<pillar>[a-z]+)\.(?<role>api|worker)', target: '{pillar}.{service}-{role}', gateway: true }
          aliases: { alpha: aa, beta: bb }
        """;

    /// <summary>One thing a system really did: called <c>Target</c> on these days, directly or through the gateway, or something that is not a system.</summary>
    private sealed record Call(string Caller, string Target, bool Gateway, string[] Days);

    private static readonly Call[] RealCalls =
    [
        new("aa.orders-worker", "bb.ledger-api", true, ["2026-10-27", "2026-10-29"]),   // across islands, through the gateway
        new("bb.ledger-worker", "bb.ledger-api", false, ["2026-10-28", "2026-10-30"]),  // on its own island, direct
        new("bb.ledger-api", "aa.orders-api", true, ["2026-10-24", "2026-10-25", "2026-10-30"]),
        new("aa.orders-api", "bb.ledger-worker", true, ["2026-10-30"]),                 // one day only: not enough
    ];

    private static string Host(bool a, string target, bool gateway, out string? path)
    {
        var (pillar, rest) = (target.Split('.')[0], target.Split('.')[1]);
        var (service, role) = (rest[..rest.LastIndexOf('-')], rest[(rest.LastIndexOf('-') + 1)..]);
        if (a)
        {
            var code = pillar == "aa" ? "al" : "be";
            path = gateway ? $"/{code}/{service}/{role}/v1/things" : null;
            return gateway ? "gw.a.example.test" : $"{service}-{role}.{code}.a.example.test";
        }
        var name = pillar == "aa" ? "alpha" : "beta";
        path = gateway ? $"/v1/{service}.{name}.{role}/things" : null;
        return gateway ? "edge.b.example.test" : $"{role}--{service}--{name}.b.example.test";
    }

    private sealed class FakeDependencies(Func<string, IReadOnlyList<DependencyRow>> answer) : IDependencySource
    {
        public bool CanReadDependencies => true;
        public List<(DateTimeOffset From, DateTimeOffset To, IReadOnlyCollection<string> Roles)> Asked { get; } = [];

        public Task<IReadOnlyList<DependencyRow>> ReadDependenciesAsync(TownRegistry registry, string query, IReadOnlyCollection<string> roles, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
        {
            Asked.Add((from, to, roles));
            return Task.FromResult(answer(query));
        }
    }

    private sealed class Town(string folder, bool a, FakeTimeProvider time)
    {
        public RegistryHolder Holder { get; } = new(RegistryLoader.Load(folder));
        public ScopeStore Scope { get; } = new();
        public DiscoveredLinks Store { get; } = new();
        public EnvironmentRegistry View => new(Holder, "prod", Store, time);
        public Dictionary<string, string> Roles => Scope.Resolve(View.Current).Systems.Where(s => s.TelemetryRole is not null).ToDictionary(s => s.SystemId, s => s.TelemetryRole!);

        public IReadOnlyList<DependencyRow> Rows(IEnumerable<Call> calls, params DependencyRow[] extra) =>
            calls.Select(c => new DependencyRow(Roles[c.Caller], Host(a, c.Target, c.Gateway, out var path), path, Days(c.Days), 100)).Concat(extra).ToList();

        public LinkDiscoveryRunner Runner(IDependencySource source, FakeTimeProvider clock) => new(source, Scope, new EnvironmentRegistry(Holder, "prod", Store, clock), Store, clock, NullLogger<LinkDiscoveryRunner>.Instance);
    }

    /// <summary>A vendor island of the company's own services, one of which runs under two telemetry names (one for each instance).</summary>
    private const string DeskVendors = """
        vendors:
          - id: ext.desk
            name: Service desk
            internal: true
            services:
              - { id: portal, name: Portal, match: [{ host: portal.example.test }], roles: ["Desk.Portal.One", "Desk.Portal.Two"] }
              - { id: quiet, name: Quiet, match: [{ host: quiet.example.test }] }
        """;

    private static (Town Town, RegistryCopy Copy) Make(string source, bool a, FakeTimeProvider time, string? thirdParties = null)
    {
        var copy = new RegistryCopy(source);
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + (a ? LinksA : LinksB));
        if (thirdParties is not null) copy.Write("third-parties.yaml", thirdParties);
        return (new Town(copy.Path, a, time), copy);
    }

    private static Dictionary<string, string> Links(TownRegistry view) =>
        view.AllNodes.Where(n => n.FoundCalls.Count + n.FoundGatewayCalls.Count > 0)
            .SelectMany(n => n.FoundCalls.Keys.Select(t => (n.Id, $"calls {t}")).Concat(n.FoundGatewayCalls.Keys.Select(t => (n.Id, $"gateway {t}"))))
            .ToDictionary(x => $"{x.Id}>{x.Item2}", x => x.Item2);

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task The_same_real_calls_find_the_same_links_in_both_towns_whatever_their_addresses_look_like(bool a)
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(a ? TownA : TownB, a, clock);
        using var _ = copy;
        var source = new FakeDependencies(_ => town.Rows(RealCalls));

        await town.Runner(source, clock).RunOnceAsync(CancellationToken.None);

        var view = town.View.Current;
        Assert.Equal(
            ["aa.orders-worker>gateway bb.ledger-api", "bb.ledger-api>gateway aa.orders-api", "bb.ledger-worker>calls bb.ledger-api"],
            Links(view).Keys.Order(StringComparer.Ordinal).ToArray());
        // the one-day call is not drawn, and the declared links are all still there
        Assert.DoesNotContain("bb.ledger-worker", view.AllNodes.Single(n => n.Id == "aa.orders-api").GatewayCalls);
        Assert.Contains("aa.orders-db", view.AllNodes.Single(n => n.Id == "aa.orders-api").Calls);
        Assert.Equal(D("2026-10-29"), view.AllNodes.Single(n => n.Id == "aa.orders-worker").FoundGatewayCalls["bb.ledger-api"]);
        Assert.Empty(town.Store.Notices(2));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_service_of_a_vendor_island_that_lists_its_roles_is_found_calling_town_systems_through_the_gateway_whatever_the_addresses_look_like(bool a)
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(a ? TownA : TownB, a, clock, DeskVendors);
        using var _ = copy;
        string? path;
        var host = Host(a, "bb.ledger-api", true, out path);
        var source = new FakeDependencies(_ => town.Rows(RealCalls,
            new DependencyRow("Desk.Portal.One", host, path, Days("2026-10-27", "2026-10-29"), 100),
            new DependencyRow("Desk.Portal.Two", host, path, Days("2026-10-28"), 100),   // the second instance of the same building, a day the first was quiet
            new DependencyRow("Not.Listed", host, path, Days("2026-10-27", "2026-10-29"), 100)));

        await town.Runner(source, clock).RunOnceAsync(CancellationToken.None);

        Assert.Contains("Desk.Portal.One", source.Asked.Single().Roles);
        Assert.Contains("Desk.Portal.Two", source.Asked.Single().Roles);
        var view = town.View.Current;
        Assert.Equal(["bb.ledger-api"], view.Vendors.Single(v => v.Node.Id == "ext.desk-portal").Calls);
        Assert.Empty(view.Vendors.Single(v => v.Node.Id == "ext.desk-quiet").Calls); // no roles, so its own calls are never read
        // the town's own links are as before: the building is not a town system, so nothing is drawn from it on the island's side
        Assert.Equal(
            ["aa.orders-worker>gateway bb.ledger-api", "bb.ledger-api>gateway aa.orders-api", "bb.ledger-worker>calls bb.ledger-api"],
            Links(view).Keys.Order(StringComparer.Ordinal).ToArray());
        Assert.Empty(town.Store.Notices(2));
    }

    [Fact]
    public async Task A_vendor_buildings_roles_are_not_given_to_a_town_system_that_already_has_them_and_a_repeated_role_is_asked_once()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock, DeskVendors.Replace("\"Desk.Portal.Two\"", "\"Desk.Portal.One\", \"OrdersApi\""));
        using var _ = copy;
        var source = new FakeDependencies(_ => []);

        await town.Runner(source, clock).RunOnceAsync(CancellationToken.None);

        var roles = source.Asked.Single().Roles;
        Assert.Single(roles, r => r == "OrdersApi");
        Assert.Single(roles, r => r == "Desk.Portal.One");
    }

    [Fact]
    public void Unknown_addresses_are_grouped_by_host_with_their_calls_callers_and_days_and_a_host_that_gets_a_rule_leaves_the_list()
    {
        var store = new DiscoveredLinks();
        store.RecordUnresolved("aa.orders-api", "api.partner.test", "/v1/a", Days("2026-10-28", "2026-10-29"), 300);
        store.RecordUnresolved("aa.orders-api", "api.partner.test", "/v1/b", Days("2026-10-29"), 100);
        store.RecordUnresolved("bb.ledger-worker", "API.partner.test", null, Days("2026-10-30"), 50);
        store.RecordUnresolved("aa.orders-worker", "once.example.test", null, Days("2026-10-30"), 9999); // seen on one day only: not enough
        store.RecordUnresolved("aa.orders-worker", "other.example.test", null, Days("2026-10-29", "2026-10-30"), 60);

        var hosts = store.UnknownHosts(2);

        Assert.Equal(["api.partner.test", "other.example.test"], hosts.Select(h => h.Host).ToArray());
        var partner = hosts[0];
        Assert.Equal(450, partner.Calls);
        Assert.Equal(["aa.orders-api", "bb.ledger-worker"], partner.Callers);
        Assert.Equal(3, partner.Days); // the days of every caller and path together
        // a vendor domain is added: the next read takes the host off the list
        store.Revisit((_, host, _) => host.EndsWith("partner.test", StringComparison.OrdinalIgnoreCase) ? new Classified(LinkOutcome.Vendor, "ext.partner") : new Classified(LinkOutcome.Unresolved));
        Assert.Equal(["other.example.test"], store.UnknownHosts(2).Select(h => h.Host).ToArray());
    }

    [Fact]
    public async Task A_role_never_read_before_is_read_over_the_whole_first_read_window_while_the_others_read_only_the_gap()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock, DeskVendors);
        using var _ = copy;
        var source = new FakeDependencies(_ => []);
        await town.Runner(source, clock).RunOnceAsync(CancellationToken.None);
        clock.Advance(TimeSpan.FromHours(3));
        // the file now lists one more name; the town starts again with the same remembered state
        copy.Write("third-parties.yaml", DeskVendors.Replace("\"Desk.Portal.Two\"]", "\"Desk.Portal.Two\", \"Desk.Portal.Three\"]"));
        var restarted = new LinkDiscoveryRunner(source, town.Scope, new EnvironmentRegistry(new RegistryHolder(RegistryLoader.Load(copy.Path)), "prod", town.Store, clock), town.Store, clock, NullLogger<LinkDiscoveryRunner>.Instance);

        await restarted.RunOnceAsync(CancellationToken.None);

        Assert.Equal(3, source.Asked.Count);
        Assert.Equal(Now, source.Asked[1].From);                          // the names it already knew: the gap since the last read
        Assert.DoesNotContain("Desk.Portal.Three", source.Asked[1].Roles);
        Assert.Equal(["Desk.Portal.Three"], source.Asked[2].Roles);              // the new one: the whole window
        Assert.Equal(clock.GetUtcNow().AddDays(-7), source.Asked[2].From);
        // and once read it is known: the next read is one read of the gap again
        clock.Advance(TimeSpan.FromHours(1));
        await restarted.RunOnceAsync(CancellationToken.None);
        Assert.Equal(4, source.Asked.Count);
        Assert.Contains("Desk.Portal.Three", source.Asked[3].Roles);
    }

    [Fact]
    public async Task The_names_already_read_are_remembered_across_a_restart_so_nothing_is_read_twice()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock, DeskVendors);
        using var _ = copy;
        var folder = Path.Combine(copy.Path, "_state");
        var store = new DiscoveredLinks(folder);
        var source = new FakeDependencies(_ => []);
        var view = new EnvironmentRegistry(town.Holder, "prod", store, clock);
        await new LinkDiscoveryRunner(source, town.Scope, view, store, clock, NullLogger<LinkDiscoveryRunner>.Instance).RunOnceAsync(CancellationToken.None);
        clock.Advance(TimeSpan.FromHours(2));

        var again = new DiscoveredLinks(folder);
        await new LinkDiscoveryRunner(source, town.Scope, new EnvironmentRegistry(town.Holder, "prod", again, clock), again, clock, NullLogger<LinkDiscoveryRunner>.Instance).RunOnceAsync(CancellationToken.None);

        Assert.Equal(2, source.Asked.Count);
        Assert.Equal(Now, source.Asked[1].From); // the gap only
    }

    [Fact]
    public async Task The_query_is_the_environments_own_with_the_roles_and_the_read_bounds_filled_in()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock);
        using var _ = copy;
        var source = new FakeDependencies(_ => []);

        await town.Runner(source, clock).RunOnceAsync(CancellationToken.None);

        var (from, to, roles) = Assert.Single(source.Asked);
        Assert.Equal(Now.AddDays(-7), from); // the first read looks back firstRead
        Assert.Equal(Now, to);
        Assert.Contains("OrdersApi", roles);
        Assert.DoesNotContain("ApiGateway", roles); // a gateway makes no calls worth finding
    }

    [Fact]
    public async Task Later_reads_start_where_the_last_one_ended_and_never_look_back_further_than_firstRead()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock);
        using var _ = copy;
        var source = new FakeDependencies(_ => []);
        var runner = town.Runner(source, clock);

        await runner.RunOnceAsync(CancellationToken.None);
        clock.Advance(TimeSpan.FromHours(1));
        await runner.RunOnceAsync(CancellationToken.None);
        clock.Advance(TimeSpan.FromDays(30)); // the app was off for a month
        await runner.RunOnceAsync(CancellationToken.None);

        Assert.Equal(Now, source.Asked[1].From);
        Assert.Equal(Now.AddHours(1), source.Asked[1].To);
        Assert.Equal(clock.GetUtcNow().AddDays(-7), source.Asked[2].From);
    }

    [Fact]
    public async Task Days_from_separate_reads_add_up_so_a_link_seen_once_in_each_of_two_reads_is_drawn()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock);
        using var _ = copy;
        var day = "2026-10-29";
        var source = new FakeDependencies(_ => town.Rows([new Call("bb.ledger-worker", "bb.ledger-api", false, [day])]));
        var runner = town.Runner(source, clock);

        await runner.RunOnceAsync(CancellationToken.None);
        Assert.Empty(Links(town.View.Current));
        day = "2026-10-30";
        await runner.RunOnceAsync(CancellationToken.None);

        Assert.Single(Links(town.View.Current));
    }

    [Fact]
    public async Task Calls_that_no_rule_explains_become_notices_and_noise_and_known_vendors_do_not()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock);
        using var _ = copy;
        copy.Write("third-parties.yaml", copy.Read("third-parties.yaml").Replace("slaP99Ms: 1500 }", "slaP99Ms: 1500, domains: [bureau.example.test] }"));
        var again = new Town(copy.Path, true, clock);
        var role = again.Roles["aa.orders-api"];
        var source = new FakeDependencies(_ => [
            new DependencyRow(role, "mystery.a.example.test", "/q", Days("2026-10-29", "2026-10-30"), 900),
            new DependencyRow(role, "169.254.169.254", null, Days("2026-10-29", "2026-10-30"), 900),
            new DependencyRow(role, "scoring.bureau.example.test", null, Days("2026-10-29", "2026-10-30"), 900),
            new DependencyRow("SomethingElse", "mystery.a.example.test", null, Days("2026-10-29", "2026-10-30"), 900),
        ]);

        await again.Runner(source, clock).RunOnceAsync(CancellationToken.None);

        var notice = Assert.Single(again.View.Notices, n => n.StartsWith("Unresolved call"));
        Assert.Contains("'aa.orders-api' calls mystery.a.example.test/q", notice);
        Assert.Empty(Links(again.View.Current));
    }

    [Fact]
    public void A_rule_that_names_a_pillar_the_town_does_not_have_is_outside_the_town_not_unresolved()
    {
        var outside = Classify(Rules([ViaGateway]), "gw.example.test", "/cc/ledger/api/v1/x");

        Assert.Equal(new Classified(LinkOutcome.OutsideTown, "cc.ledger-api", true), outside);
        Assert.Equal(LinkOutcome.Unresolved, Classify(Rules([ViaGateway]), "gw.example.test", "/bb/missing/api").Outcome); // a pillar the town has: a real gap
        Assert.Equal(LinkOutcome.Unresolved, Classify(Rules([ViaGateway]), "gw.example.test", "/cc/ledger/other").Outcome); // no rule fits at all
    }

    [Fact]
    public void Calls_to_a_pillar_outside_the_town_are_one_note_for_each_pillar_and_never_notices()
    {
        var store = new DiscoveredLinks();
        store.RecordOutside("aa.orders-api", "gw.example.test", "/cc/ledger/api/a", "cc.ledger-api", Days("2026-10-29", "2026-10-30"), 300);
        store.RecordOutside("aa.orders-api", "gw.example.test", "/cc/vault/api/b", "cc.vault-api", Days("2026-10-29", "2026-10-30"), 200);
        store.RecordOutside("bb.ledger-api", "gw.example.test", "/cc/ledger/api/a", "cc.ledger-api", Days("2026-10-29", "2026-10-30"), 50);
        store.RecordOutside("aa.orders-api", "gw.example.test", "/dd/x/api", "dd.x-api", Days("2026-10-29", "2026-10-30"), 9000);
        store.RecordOutside("aa.orders-api", "gw.example.test", "/ee/x/api", "ee.x-api", Days("2026-10-30"), 99999); // one day only

        var notes = store.Notes(2);

        Assert.Empty(store.Notices(2));
        Assert.Equal(2, notes.Count);
        Assert.Contains("'dd'", notes[0]); // the busiest first
        Assert.Contains("'cc' is not in the town yet: 2 of its services are called by aa.orders-api, bb.ledger-api, about 550 calls", notes[1]);
    }

    [Fact]
    public void A_remembered_address_that_a_rule_now_explains_leaves_the_list_and_one_that_now_names_an_outside_pillar_moves_to_the_notes()
    {
        var store = new DiscoveredLinks();
        store.RecordUnresolved("aa.orders-api", "noise.example.test", null, Days("2026-10-29", "2026-10-30"), 90);
        store.RecordUnresolved("aa.orders-api", "gw.example.test", "/cc/ledger/api", Days("2026-10-29", "2026-10-30"), 60);
        store.RecordUnresolved("aa.orders-api", "still.example.test", null, Days("2026-10-29", "2026-10-30"), 30);
        var classifier = new LinkClassifier(Rules([ViaGateway], ignore: ["^noise\\."]), [], Systems);

        store.Revisit((caller, host, path) => classifier.Classify(new DependencyRow(caller, host, path, [], 0), "aa"));

        var notice = Assert.Single(store.Notices(2));
        Assert.Contains("still.example.test", notice);
        Assert.Contains("'cc' is not in the town yet", Assert.Single(store.Notes(2)));
    }

    [Fact]
    public void Calls_to_a_pillar_outside_the_town_survive_a_restart()
    {
        var dir = Path.Combine(Path.GetTempPath(), "oc-outside-" + Guid.NewGuid().ToString("N"));
        try
        {
            var first = new DiscoveredLinks(dir);
            first.RecordOutside("aa.orders-api", "gw.example.test", "/cc/ledger/api", "cc.ledger-api", Days("2026-10-29", "2026-10-30"), 300);
            first.Save();

            var second = new DiscoveredLinks(dir);

            Assert.Contains("'cc' is not in the town yet", Assert.Single(second.Notes(2)));
        }
        finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
    }

    [Fact]
    public async Task A_gateway_call_to_a_pillar_the_town_lacks_is_a_note_and_a_later_ignore_rule_clears_an_old_notice()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock);
        using var _ = copy;
        var role = town.Roles["aa.orders-api"];
        var source = new FakeDependencies(_ => [
            new DependencyRow(role, "gw.a.example.test", "/zz/ledger/api/v1", Days("2026-10-29", "2026-10-30"), 400),
            new DependencyRow(role, "mystery.a.example.test", "/q", Days("2026-10-29", "2026-10-30"), 900),
        ]);
        var runner = town.Runner(source, clock);

        await runner.RunOnceAsync(CancellationToken.None);

        Assert.DoesNotContain(town.View.Notices, n => n.Contains("/zz/"));
        Assert.Single(town.View.Notices, n => n.Contains("mystery.a.example.test"));
        Assert.Contains("'zz' is not in the town yet", Assert.Single(town.View.Notes));

        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml").Replace("ignoreHosts: ['^169\\.254\\.']", "ignoreHosts: ['^169\\.254\\.', '^mystery\\.']"));
        var changed = new Town(copy.Path, true, clock);
        await changed.Runner(source, clock).RunOnceAsync(CancellationToken.None);
        Assert.DoesNotContain(changed.View.Notices, n => n.Contains("mystery.a.example.test"));
    }

    [Fact]
    public async Task A_read_that_fails_keeps_what_was_found_before_and_says_so()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock);
        using var _ = copy;
        var fail = false;
        var source = new FakeDependencies(_ => fail ? throw new HttpRequestException("403") : town.Rows(RealCalls));
        var runner = town.Runner(source, clock);
        await runner.RunOnceAsync(CancellationToken.None);
        var before = Links(town.View.Current).Count;

        fail = true;
        await runner.CycleAsync(CancellationToken.None); // the cycle catches the failure itself

        Assert.Equal(before, Links(town.View.Current).Count);
        Assert.Contains(town.View.Notices, n => n.StartsWith("Link discovery failed") && n.Contains("403"));
    }

    [Fact]
    public async Task A_system_with_discoverLinks_off_gains_no_links_and_is_not_asked_about()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock);
        using var _ = copy;
        copy.Replace("pillars/bb.yaml", "id: bb.ledger-worker, service: ledger,", "id: bb.ledger-worker, discoverLinks: false, service: ledger,");
        var off = new Town(copy.Path, true, clock);
        var source = new FakeDependencies(_ => town.Rows(RealCalls));

        await off.Runner(source, clock).RunOnceAsync(CancellationToken.None);

        Assert.DoesNotContain("LedgerWorker", source.Asked.Single().Roles);
        Assert.False(off.View.Current.AllNodes.Single(n => n.Id == "bb.ledger-worker").DiscoverLinks);
        Assert.DoesNotContain(Links(off.View.Current).Keys, k => k.StartsWith("bb.ledger-worker"));
    }

    [Fact]
    public async Task An_address_written_with_the_service_code_draws_the_link_to_the_service_with_the_longer_name()
    {
        var clock = new FakeTimeProvider(Now);
        var (_, copy) = Make(TownA, true, clock);
        using var _c = copy;
        // one more rule of the town: <service code>.c.<pillar>.example.test, while the ids use the service names (ledger has the code "led")
        copy.Replace("environments/prod.yaml", "  rules:\n", "  rules:\n    - { host: '^(?<service>[a-z]+)\\.c\\.(?<pillar>[a-z]+)\\.example\\.test$', target: '{pillar}.{service}-api' }\n");
        var coded = new Town(copy.Path, true, clock);
        var source = new FakeDependencies(_ => [new DependencyRow(coded.Roles["bb.ledger-worker"], "led.c.bb.example.test", null, Days("2026-10-28", "2026-10-30"), 100)]);

        await coded.Runner(source, clock).RunOnceAsync(CancellationToken.None);

        Assert.Equal(["bb.ledger-worker>calls bb.ledger-api"], Links(coded.View.Current).Keys);
        Assert.DoesNotContain(coded.View.Notices, n => n.StartsWith("Unresolved call"));
    }

    [Fact]
    public async Task A_declared_link_stays_declared_even_when_the_telemetry_shows_it_too()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock);
        using var _ = copy;
        copy.Replace("pillars/aa.yaml", "id: aa.orders-worker, service: orders, serviceCode: ord, name: Orders worker, role: worker, calls: [aa.orders-db]", "id: aa.orders-worker, service: orders, serviceCode: ord, name: Orders worker, role: worker, calls: [aa.orders-db], gatewayCalls: [bb.ledger-api]");
        var declared = new Town(copy.Path, true, clock);
        var source = new FakeDependencies(_ => declared.Rows(RealCalls));

        await declared.Runner(source, clock).RunOnceAsync(CancellationToken.None);

        var worker = declared.View.Current.AllNodes.Single(n => n.Id == "aa.orders-worker");
        Assert.Contains("bb.ledger-api", worker.GatewayCalls);
        Assert.Empty(worker.FoundGatewayCalls);
        Assert.Equal(1, worker.GatewayCalls.Count(c => c == "bb.ledger-api"));
    }

    [Fact]
    public async Task A_found_gateway_call_to_a_system_on_the_same_island_is_an_ordinary_call()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock);
        using var _ = copy;
        var source = new FakeDependencies(_ => town.Rows([new Call("bb.ledger-worker", "bb.ledger-api", true, ["2026-10-29", "2026-10-30"])]));

        await town.Runner(source, clock).RunOnceAsync(CancellationToken.None);

        var worker = town.View.Current.AllNodes.Single(n => n.Id == "bb.ledger-worker");
        Assert.Contains("bb.ledger-api", worker.Calls);
        Assert.DoesNotContain("bb.ledger-api", worker.GatewayCalls);
    }

    // ---- what the drawer says ----

    [Fact]
    public async Task The_drawer_tags_a_found_link_with_the_day_it_was_last_seen_on_both_ends_and_a_declared_link_with_nothing()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock);
        using var _ = copy;
        await town.Runner(new FakeDependencies(_ => town.Rows(RealCalls)), clock).RunOnceAsync(CancellationToken.None);
        var view = town.View.Current;

        var caller = SystemDetails.Of(view, "bb.ledger-worker")!;
        var callee = SystemDetails.Of(view, "bb.ledger-api")!;
        var gateway = SystemDetails.Of(view, "aa.orders-worker")!;

        var found = caller.Calls.Single(c => c.Id == "bb.ledger-api");
        Assert.True(found.Found);
        Assert.Equal("2026-10-30", found.LastSeen);
        Assert.False(caller.Calls.Single(c => c.Id == "bb.ledger-db").Found);
        Assert.Null(caller.Calls.Single(c => c.Id == "bb.ledger-db").LastSeen);
        Assert.True(callee.CalledBy.Single(c => c.Id == "bb.ledger-worker").Found);
        Assert.True(gateway.GatewayCalls.Single(c => c.Id == "bb.ledger-api").Found);
        Assert.True(callee.GatewayCalledBy.Single(c => c.Id == "aa.orders-worker").Found);
    }

    [Fact]
    public void The_config_tab_shows_discoverLinks_for_an_api_and_a_worker_with_the_layer_it_came_from_and_not_for_a_database()
    {
        var view = RegistryLoader.Load(TestPaths.MiniTown);
        var api = view.AllNodes.First(n => n.Kind == NodeKind.Api);
        var db = view.AllNodes.First(n => n.Kind == NodeKind.Database);

        var row = Assert.Single(SystemDetails.Config(api), c => c.Key == "discoverLinks");

        Assert.Equal("yes", row.Value);
        Assert.Equal(SettingLayer.BuiltIn, row.Layer);
        Assert.DoesNotContain(SystemDetails.Config(db), c => c.Key == "discoverLinks");
    }

    [Fact]
    public void discoverLinks_cascades_from_the_role_defaults_to_the_pillar_to_the_system()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Write("defaults.yaml", copy.Read("defaults.yaml") + "\napi: { discoverLinks: false }\nworker: { discoverLinks: false }\n");
        copy.Write("pillars/aa.yaml", copy.Read("pillars/aa.yaml") + "defaults:\n  api: { discoverLinks: true }\n");
        copy.Replace("pillars/aa.yaml", "id: aa.orders-worker,", "id: aa.orders-worker, discoverLinks: true,");

        var registry = RegistryLoader.Load(copy.Path);
        RegistryNode Node(string id) => registry.AllNodes.Single(n => n.Id == id);
        string Layer(string id) => SystemDetails.Config(Node(id)).Single(c => c.Key == "discoverLinks").Source;

        Assert.True(Node("aa.orders-api").DiscoverLinks);       // the pillar's defaults beat the town's
        Assert.True(Node("aa.orders-worker").DiscoverLinks);    // the system's own entry beats both
        Assert.False(Node("bb.ledger-api").DiscoverLinks);      // the town's defaults
        Assert.Equal("pillars/aa.yaml, pillar defaults for api", Layer("aa.orders-api"));
        Assert.Equal("pillars/aa.yaml, this system", Layer("aa.orders-worker"));
        Assert.Equal("defaults.yaml, api", Layer("bb.ledger-api"));
    }

    // ---- the files ----

    private static string LoadProblem(string linksBlock)
    {
        using var copy = new RegistryCopy(TownA);
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + linksBlock);
        return Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;
    }

    [Fact]
    public void A_target_hole_that_no_pattern_captures_is_an_error_that_names_it()
    {
        var message = LoadProblem(LinksA.Replace("target: '{pillar}.{service}-{role}' }\n", "target: '{pillar}.{svc}-{role}' }\n"));

        Assert.Contains("environments/prod.yaml: links.rules[0].target", message);
        Assert.Contains("{svc}", message);
    }

    [Fact]
    public void A_pattern_that_is_not_a_regular_expression_is_an_error_not_a_crash_later()
    {
        var message = LoadProblem(LinksA.Replace("'^169\\.254\\.'", "'(['"));

        Assert.Contains("links.ignoreHosts", message);
        Assert.Contains("not a valid regular expression", message);
    }

    [Fact]
    public void The_source_must_be_a_loganalytics_source_of_the_same_file()
    {
        Assert.Contains("links.source 'nope' is not a source of this file", LoadProblem(LinksA.Replace("source: telemetry", "source: nope")));
        Assert.Contains("is a resourcegraph source", LoadProblem(LinksA.Replace("source: telemetry", "source: inventory")));
    }

    [Fact]
    public void Durations_minDays_and_the_query_variables_are_checked()
    {
        Assert.Contains("links.interval 'soon' is not a number and a unit", LoadProblem(LinksA.Replace("ignoreHosts:", "interval: soon\n  ignoreHosts:")));
        Assert.Contains("links.minDays is 0", LoadProblem(LinksA.Replace("ignoreHosts:", "minDays: 0\n  ignoreHosts:")));
        Assert.Contains("{since} is not a variable here", LoadProblem(LinksA.Replace("{from}", "{since}")));
    }

    [Fact]
    public void An_environment_without_a_links_block_has_no_discovery_and_the_sample_towns_still_load_clean()
    {
        Assert.All(RegistryLoader.Load(TestPaths.Registry).Environments, e => Assert.Null(e.Links));
        Assert.All(RegistryLoader.Load(TownB).Environments, e => Assert.Null(e.Links));
    }

    [Fact]
    public void Everything_in_the_links_block_reaches_the_registry_with_its_defaults()
    {
        using var copy = new RegistryCopy(TownB);
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + LinksB);

        var links = RegistryLoader.Load(copy.Path).Environments.Single().Links!;

        Assert.Equal("telemetry", links.Source);
        Assert.Equal(TimeSpan.FromMinutes(30), links.Interval);
        Assert.Equal(TimeSpan.FromDays(7), links.FirstRead);
        Assert.Equal(TimeSpan.FromDays(30), links.KeepFor);
        Assert.Equal(2, links.MinDays);
        Assert.Equal(2, links.Rules.Count);
        Assert.True(links.Rules[1].Gateway);
    }

    [Fact]
    public void The_registry_reloader_does_not_reload_for_the_files_link_discovery_writes_itself()
    {
        using var copy = new RegistryCopy(TownA);
        var before = RegistryReloader.Fingerprint(copy.Path);
        var dir = Path.Combine(copy.Path, RegistryReloader.DiscoveredFolder, "links", "prod");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "aa.yaml"), "links: []");

        Assert.Equal(before, RegistryReloader.Fingerprint(copy.Path));
    }

    // ---- the Azure side ----

    private const string Workspace = "00000000-0000-0000-0000-00000000c0de";

    private static string Answer(params string[] rows) =>
        """{"tables":[{"name":"PrimaryResult","columns":[{"name":"caller","type":"string"},{"name":"host","type":"string"},{"name":"path","type":"string"},{"name":"days","type":"dynamic"},{"name":"calls","type":"real"}],"rows":[""" + string.Join(",", rows) + "]}]}";

    [Fact]
    public void The_dependency_answer_is_read_by_column_name_with_days_as_an_array_or_as_text()
    {
        var rows = LogAnalyticsReader.ParseDependencies(Answer(
            """["OrdersApi","gw.a.example.test","/be/ledger/api",["2026-10-28T00:00:00Z","2026-10-29T00:00:00Z"],1200.0]""",
            """["OrdersApi","169.254.169.254","",["2026-10-29T00:00:00Z"],4.0]""",
            """["OrdersApi","h.example.test",null,"[\"2026-10-30T00:00:00Z\"]",null]""",
            """["","x.example.test",null,["2026-10-30T00:00:00Z"],1.0]""",
            """["OrdersApi","y.example.test",null,[],1.0]"""));

        Assert.Equal(3, rows.Count);
        Assert.Equal(("OrdersApi", "gw.a.example.test", "/be/ledger/api", 1200d), (rows[0].Caller, rows[0].Host, rows[0].Path, rows[0].Calls));
        Assert.Equal(Days("2026-10-28", "2026-10-29"), rows[0].Days);
        Assert.Null(rows[1].Path);
        Assert.Equal(Days("2026-10-30"), rows[2].Days);
    }

    [Fact]
    public void A_dependency_query_that_leaves_out_a_required_column_is_told_which_ones_are_needed()
    {
        var e = Assert.Throws<InvalidOperationException>(() => LogAnalyticsReader.ParseDependencies("""{"tables":[{"columns":[{"name":"role"},{"name":"calls"}],"rows":[]}]}"""));

        Assert.Contains("caller, host and days", e.Message);
        Assert.Contains("role, calls", e.Message);
    }

    private static (LogAnalyticsSource Source, CannedHttp Http, TownRegistry Registry) Asking(string answer)
    {
        using var copy = new RegistryCopy(TownA);
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + LinksA);
        var registry = RegistryLoader.Load(copy.Path).ForEnvironment("prod");
        var env = registry.ActiveEnvironment!;
        var http = CannedHttp.Always(answer);
        var definition = env.Sources.Single(s => s.Name == "telemetry") with { Connection = Workspace };
        var source = (LogAnalyticsSource)new LogAnalyticsSourceFactory(new HttpClient(http), new FakeTimeProvider(Now))
            .Create(new SourceContext("prod", definition, null, env.Scope, new ScopeStore(), copy.Path));
        return (source, http, registry);
    }

    [Fact]
    public async Task The_source_sends_the_environments_query_with_the_roles_and_the_read_bounds_to_the_workspace()
    {
        var (source, http, registry) = Asking(Answer());
        var from = Now.AddDays(-7);

        var rows = await source.ReadDependenciesAsync(registry, registry.ActiveEnvironment!.Links!.Query, ["OrdersApi", "LedgerApi"], from, Now, CancellationToken.None);

        Assert.Empty(rows);
        var sent = Assert.Single(http.Sent);
        Assert.Equal($"https://api.loganalytics.io/v1/workspaces/{Workspace}/query", sent.Uri!.ToString());
        Assert.Equal("2026-10-23T12:00:00Z/2026-10-30T12:00:00Z", sent.Json.GetProperty("timespan").GetString());
        var query = sent.Json.GetProperty("query").GetString()!;
        Assert.Contains("AppRoleName in (\"OrdersApi\", \"LedgerApi\")", query);
        Assert.Contains("datetime(2026-10-23T12:00:00Z) .. datetime(2026-10-30T12:00:00Z)", query);
        Assert.DoesNotContain("{", query);
    }

    [Fact]
    public async Task A_refused_dependency_query_fails_loudly_so_the_runner_can_say_so()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + LinksA);
        var registry = RegistryLoader.Load(copy.Path).ForEnvironment("prod");
        var env = registry.ActiveEnvironment!;
        var http = CannedHttp.Always("""{"error":{"code":"InsufficientAccessError"}}""", HttpStatusCode.Forbidden);
        var source = (LogAnalyticsSource)new LogAnalyticsSourceFactory(new HttpClient(http), new FakeTimeProvider(Now))
            .Create(new SourceContext("prod", env.Sources.Single(s => s.Name == "telemetry") with { Connection = Workspace }, null, env.Scope, new ScopeStore(), copy.Path));

        var e = await Assert.ThrowsAsync<HttpRequestException>(() => source.ReadDependenciesAsync(registry, "q", ["OrdersApi"], Now.AddDays(-1), Now, CancellationToken.None));

        Assert.Contains("403", e.Message);
    }

    [Fact]
    public void A_recorded_source_cannot_discover_links_so_none_is_started_for_it()
    {
        using var copy = new RegistryCopy(TownA);
        var env = RegistryLoader.Load(copy.Path).ForEnvironment("prod").ActiveEnvironment!;
        var source = (IDependencySource)new LogAnalyticsSourceFactory().Create(new SourceContext("prod", env.Sources.Single(s => s.Name == "telemetry"), null, env.Scope, new ScopeStore(), copy.Path));

        Assert.False(source.CanReadDependencies);
    }

    // ---- the view follows the store ----

    [Fact]
    public void The_registry_view_is_made_again_when_the_store_changes_and_not_otherwise()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock);
        using var _ = copy;
        var view = town.View;
        var first = view.Current;

        Assert.Same(first, view.Current);
        town.Store.RecordLink("bb.ledger-worker", "bb.ledger-api", false, Days("2026-10-29", "2026-10-30"));
        var second = view.Current;

        Assert.NotSame(first, second);
        Assert.Contains("bb.ledger-api", second.AllNodes.Single(n => n.Id == "bb.ledger-worker").Calls);
        Assert.Same(second, view.Current);
    }

    [Fact]
    public void A_link_ages_out_of_the_view_as_the_days_pass_without_anything_being_read()
    {
        var clock = new FakeTimeProvider(Now);
        var (town, copy) = Make(TownA, true, clock);
        using var _ = copy;
        town.Store.RecordLink("bb.ledger-worker", "bb.ledger-api", false, Days("2026-10-29", "2026-10-30"));
        var view = town.View;
        Assert.Contains("bb.ledger-api", view.Current.AllNodes.Single(n => n.Id == "bb.ledger-worker").Calls);

        clock.Advance(TimeSpan.FromDays(31));

        Assert.DoesNotContain("bb.ledger-api", view.Current.AllNodes.Single(n => n.Id == "bb.ledger-worker").Calls);
    }
}
