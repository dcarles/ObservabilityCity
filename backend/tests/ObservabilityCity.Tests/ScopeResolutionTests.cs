using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 2, slice 2: an environment's scope rules say which subscription each pillar lives in, which workspace the telemetry is in, which resources
/// belong to a service and what the telemetry calls each system. Two towns with the same pillars and systems but opposite conventions (names against
/// tags, other resource types, other telemetry naming) resolve to the same logical town, which is the proof that no convention is in the core.
/// </summary>
public class ScopeResolutionTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-b");

    private static TownRegistry Prod(string folder) => RegistryLoader.Load(folder).ForEnvironment("prod");

    private static Inventory Recorded(string folder) => ResourceGraphInventory.FromRecording(File.ReadAllText(Path.Combine(folder, "inventory.json")));

    private static Resolution Resolved(string folder) => ScopeResolver.Resolve(Prod(folder), Recorded(folder));

    /// <summary>What a town is, without how it is spelt: for each system whether it was placed, its tenants' names and whether the telemetry knows it (a database has no telemetry of its own).</summary>
    private static Dictionary<string, string> LogicalTown(Resolution r) =>
        r.Systems.Where(s => !s.SystemId.StartsWith("hub.")).ToDictionary(s => s.SystemId, s =>
            $"placed={s.SubscriptionId is not null} resources={s.Resources.Count > 0} tenants=[{string.Join("|", s.Resources.Where(x => x.Tenant is not null).Select(x => r.TenantNames.First(t => t.Id == x.Tenant).Name).Order())}] role={s.SystemId.EndsWith("-db") || s.TelemetryRole is not null} workspace={s.Workspace is not null}");

    // ---- the proof ----

    [Fact]
    public void Two_towns_with_opposite_conventions_resolve_to_the_same_logical_town()
    {
        var a = LogicalTown(Resolved(TownA));
        var b = LogicalTown(Resolved(TownB));

        Assert.Equal(a.OrderBy(x => x.Key), b.OrderBy(x => x.Key));
        Assert.Equal("placed=True resources=True tenants=[Acme Bank|Borealis Credit Union|Cygnus Finance] role=True workspace=True", a["aa.orders-db"]);
        Assert.Equal("placed=True resources=True tenants=[Acme Bank|Borealis Credit Union] role=True workspace=True", a["bb.ledger-db"]);
    }

    [Fact]
    public void Neither_town_has_a_problem()
    {
        Assert.Empty(Resolved(TownA).Problems);
        Assert.Empty(Resolved(TownB).Problems);
    }

    // ---- town A: everything is in the names ----

    [Fact]
    public void Town_A_finds_a_pillars_subscription_by_name_and_leaves_the_staging_one_alone()
    {
        var r = Resolved(TownA);

        var alpha = r.Pillar("aa")!;
        Assert.Equal("acme-eu-prd-al", alpha.SubscriptionName);
        Assert.Equal("name", alpha.Via);
        Assert.Equal("al", alpha.Code);
        Assert.Equal("acme-eu-prd-be", r.Pillar("bb")!.SubscriptionName);
    }

    [Fact]
    public void Town_A_matches_resources_to_a_service_by_name_and_role()
    {
        var r = Resolved(TownA);

        Assert.Equal(["api-acme-al-ord-northeurope1x", "plan-cf-acme-al-ord-northeurope1x", "plan-cf-acme-al-ord-westeurope9z"], r.System("aa.orders-api")!.Resources.Select(x => x.Name));
        Assert.Equal(["plan-cf-acme-al-ord-northeurope1x", "plan-cf-acme-al-ord-westeurope9z", "worker-acme-al-ord-northeurope1x"], r.System("aa.orders-worker")!.Resources.Select(x => x.Name));
        Assert.Equal(3, r.System("aa.orders-db")!.Resources.Count);
        Assert.Equal(["northeurope", "westeurope"], r.System("aa.orders-api")!.Resources.Where(x => x.Rule == "plans").Select(x => x.Region).Order());
        Assert.DoesNotContain(r.Systems.SelectMany(s => s.Resources), x => x.Name.EndsWith("0s"));
    }

    [Fact]
    public void Town_A_reads_the_tenants_friendly_names_from_the_accounts_tag()
    {
        var r = Resolved(TownA);

        Assert.Equal(["Acme Bank", "Borealis Credit Union", "Cygnus Finance"], r.TenantNames.Select(t => t.Name));
        Assert.Equal("11111111111111111111111111111111", r.TenantNames[0].Id);
    }

    [Fact]
    public void Town_A_names_the_telemetry_role_of_each_system_and_the_workspace_of_the_environment()
    {
        var r = Resolved(TownA);

        Assert.Equal("OrdersApi", r.System("aa.orders-api")!.TelemetryRole);
        Assert.Equal("telemetry.role", r.System("aa.orders-api")!.TelemetryRoleVia);
        Assert.Null(r.System("aa.orders-db")!.TelemetryRole);
        Assert.Equal("ws-prd-main", r.Workspace);
        Assert.All(r.Systems, s => Assert.Equal("ws-prd-main", s.Workspace));
    }

    // ---- town B: tags, other resource types, derived names ----

    [Fact]
    public void Town_B_finds_a_subscription_by_tag_and_takes_the_one_that_is_named()
    {
        var r = Resolved(TownB);

        Assert.Equal(("Alpha Production", "tag"), (r.Pillar("aa")!.SubscriptionName, r.Pillar("aa")!.Via));
        Assert.Equal(("Beta Production", "explicit"), (r.Pillar("bb")!.SubscriptionName, r.Pillar("bb")!.Via));
    }

    [Fact]
    public void Town_B_matches_container_apps_and_accounts_of_another_shape()
    {
        var r = Resolved(TownB);

        Assert.Equal(["orders-api"], r.System("aa.orders-api")!.Resources.Select(x => x.Name));
        Assert.Equal("microsoft.app/containerapps", r.System("aa.orders-api")!.Resources.Single().Type);
        Assert.Equal(["cosmos-ledger-acmebank", "cosmos-ledger-borealis"], r.System("bb.ledger-db")!.Resources.Select(x => x.Name));
    }

    [Fact]
    public void Town_B_derives_the_telemetry_role_from_a_template_and_a_system_can_still_name_its_own()
    {
        var r = Resolved(TownB);

        Assert.Equal(("OrdersAPI", "scope.telemetryRole"), (r.System("aa.orders-api")!.TelemetryRole, r.System("aa.orders-api")!.TelemetryRoleVia));
        Assert.Equal(("LedgerGateway", "telemetry.role"), (r.System("bb.ledger-api")!.TelemetryRole, r.System("bb.ledger-api")!.TelemetryRoleVia));
        Assert.Equal("law-live-prod", r.Workspace); // a variable of its own and the environment's id
    }

    // ---- what the rules cannot settle is said, not guessed ----

    [Fact]
    public void Before_the_inventory_is_read_only_what_the_rules_alone_say_is_known()
    {
        var r = ScopeResolver.Resolve(Prod(TownB), null);

        Assert.False(r.InventoryRead);
        Assert.Null(r.Pillar("aa")!.SubscriptionId);
        Assert.Equal("explicit", r.Pillar("bb")!.Via); // named, so known without asking
        Assert.Equal("OrdersAPI", r.System("aa.orders-api")!.TelemetryRole);
        Assert.Empty(r.System("aa.orders-api")!.Resources);
        Assert.Empty(r.Problems);
    }

    [Fact]
    public void A_pillar_no_subscription_matches_is_a_problem_naming_the_rule()
    {
        var inventory = Recorded(TownA);
        var without = inventory with { Subscriptions = inventory.Subscriptions.Where(s => s.Name != "acme-eu-prd-be").ToList() };

        var r = ScopeResolver.Resolve(Prod(TownA), without);

        Assert.Contains(r.Problems, p => p.Contains("Pillar 'bb'") && p.Contains("name like '*-prd-be'"));
        Assert.Null(r.Pillar("bb")!.SubscriptionId);
        Assert.Empty(r.System("bb.ledger-db")!.Resources);
    }

    [Fact]
    public void A_pillar_two_subscriptions_match_is_a_problem_and_neither_is_taken()
    {
        var inventory = Recorded(TownA);
        var twice = inventory with { Subscriptions = [.. inventory.Subscriptions, new InventorySubscription("x", "other-eu-prd-al", new Dictionary<string, string>())] };

        var r = ScopeResolver.Resolve(Prod(TownA), twice);

        Assert.Contains(r.Problems, p => p.Contains("Pillar 'aa'") && p.Contains("2 subscriptions") && p.Contains("acme-eu-prd-al") && p.Contains("other-eu-prd-al"));
        Assert.Null(r.Pillar("aa")!.SubscriptionId);
    }

    [Fact]
    public void A_named_subscription_the_inventory_does_not_list_is_a_problem()
    {
        var inventory = Recorded(TownB);
        var without = inventory with { Subscriptions = inventory.Subscriptions.Where(s => s.Name != "Beta Production").ToList() };

        var r = ScopeResolver.Resolve(Prod(TownB), without);

        Assert.Contains(r.Problems, p => p.Contains("Pillar 'bb'") && p.Contains("does not list"));
    }

    [Fact]
    public void A_service_with_no_resource_is_a_problem_that_names_the_system_and_the_code()
    {
        var inventory = Recorded(TownA);
        var without = inventory with { Resources = inventory.Resources.Where(x => !x.Name.Contains("-led-")).ToList() };

        var r = ScopeResolver.Resolve(Prod(TownA), without);

        Assert.Contains(r.Problems, p => p.Contains("'bb.ledger-api'") && p.Contains("'led'"));
    }

    [Fact]
    public void Two_systems_with_one_telemetry_role_is_a_problem()
    {
        using var copy = new RegistryCopy(TownA);
        var file = copy.FilePath("pillars/bb.yaml");
        File.WriteAllText(file, File.ReadAllText(file).Replace("role: LedgerWorker", "role: LedgerApi"));

        var r = ScopeResolver.Resolve(Prod(copy.Path), Recorded(copy.Path));

        Assert.Contains(r.Problems, p => p.Contains("'LedgerApi'") && p.Contains("'bb.ledger-api'") && p.Contains("'bb.ledger-worker'"));
    }

    [Fact]
    public void A_resource_whose_name_does_not_match_can_still_be_found_by_a_tag()
    {
        using var copy = new RegistryCopy(TownB);
        var env = copy.FilePath("environments/prod.yaml");
        File.WriteAllText(env, File.ReadAllText(env).Replace("roles: [api, worker], pattern", "roles: [api, worker], serviceTag: application, pattern"));
        var inventory = Recorded(copy.Path);
        var odd = new InventoryResource("/x", "app-4417", "microsoft.app/containerapps", "00000000-0000-0000-0000-0000000000b1", "westeurope", new Dictionary<string, string> { ["Application"] = "orders" });

        var r = ScopeResolver.Resolve(Prod(copy.Path), inventory with { Resources = [.. inventory.Resources, odd] });

        Assert.Contains("app-4417", r.System("aa.orders-api")!.Resources.Select(x => x.Name));
        Assert.DoesNotContain("app-4417", r.System("bb.ledger-api")!.Resources.Select(x => x.Name));
    }

    [Fact]
    public void A_tenant_id_is_compared_without_dashes_and_in_lower_case()
    {
        Assert.Equal("0a1b2c3d4e5f60718293a4b5c6d7e8f9", ScopeResolver.TenantKey("0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"));
    }

    [Fact]
    public void An_environment_without_scope_rules_resolves_nothing()
    {
        var r = ScopeResolver.Resolve(RegistryLoader.Load(TestPaths.LiveTown), null);

        Assert.Empty(r.Systems);
        Assert.Null(ScopeInfos.Of(RegistryLoader.Load(TestPaths.LiveTown), new ScopeStore(), "aa.orders-api"));
    }

    // ---- the file ----

    private static string LoadError(string env, string folder = null!)
    {
        using var copy = new RegistryCopy(folder ?? TownA);
        File.WriteAllText(copy.FilePath("environments/prod.yaml"), env);
        return Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;
    }

    private const string Head = "name: Production\nsources:\n  inventory: { kind: resourcegraph }\nscope:\n";

    [Fact]
    public void A_pattern_that_is_not_a_regular_expression_is_named()
    {
        var message = LoadError(Head + "  resources:\n    - { name: apps, types: [t], pattern: '(?<service>[' }\n");

        Assert.Contains("environments/prod.yaml", message);
        Assert.Contains("resources 'apps'", message);
        Assert.Contains("not a valid regular expression", message);
    }

    [Fact]
    public void A_pattern_without_a_service_group_is_refused()
    {
        Assert.Contains("(?<service>", LoadError(Head + "  resources:\n    - { name: apps, types: [t], pattern: '^app-.*' }\n"));
    }

    [Fact]
    public void A_pattern_group_that_means_nothing_is_refused_with_a_suggestion()
    {
        var message = LoadError(Head + "  resources:\n    - { name: apps, types: [t], pattern: '^(?<servce>x)(?<service>y)' }\n");

        Assert.Contains("the group 'servce'", message);
        Assert.Contains("Did you mean", message);
    }

    [Fact]
    public void A_template_with_a_variable_that_is_not_defined_names_the_ones_that_are()
    {
        var message = LoadError(Head + "  variables: { env: prd }\n  workspace: \"ws-{enviroment}-{stage}\"\n");

        Assert.Contains("scope.workspace", message);
        Assert.Contains("{enviroment} is not a variable here", message);
        Assert.Contains("{env}", message);
    }

    [Fact]
    public void A_subscription_rule_needs_exactly_one_of_a_name_or_a_tag()
    {
        Assert.Contains("exactly one of nameLike or tag", LoadError(Head + "  subscription: { nameLike: 'x', tag: { key: k, value: v } }\n"));
        Assert.Contains("exactly one of nameLike or tag", LoadError(Head + "  subscription: {}\n"));
    }

    [Fact]
    public void An_inventory_source_the_file_does_not_define_is_refused()
    {
        Assert.Contains("source 'invetory', which this file does not define", LoadError(Head + "  inventory: invetory\n"));
    }

    [Fact]
    public void A_resource_role_that_is_not_a_role_is_refused()
    {
        Assert.Contains("roles has 'apis'", LoadError(Head + "  resources:\n    - { name: apps, types: [t], roles: [apis], pattern: '(?<service>x)' }\n"));
    }

    [Fact]
    public void A_pillar_named_in_the_scope_that_is_not_in_the_town_is_a_warning_not_an_error()
    {
        using var copy = new RegistryCopy(TownB);
        var env = copy.FilePath("environments/prod.yaml");
        File.WriteAllText(env, File.ReadAllText(env).Replace("pillars: { bb:", "pillars: { zz: 00000000-0000-0000-0000-000000000099, bb:"));

        Assert.Contains(RegistryLoader.Load(copy.Path).ForEnvironment("prod").Warnings, w => w.Contains("scope.pillars names 'zz'"));
    }

    [Fact]
    public void Nothing_in_the_sample_towns_or_the_core_assumes_a_convention()
    {
        // The defaults of the adapter's queries name Resource Graph tables and columns only; no tag key, name part or resource type of any company
        Assert.DoesNotContain("tag", ResourceGraphInventory.DefaultSubscriptionsQuery.Replace("tags", ""));
        Assert.Contains("{types}", ResourceGraphInventory.DefaultResourcesQuery);
        Assert.Equal(0, ScopeRules.None.Resources.Count);
    }

    // ---- the adapter ----

    private sealed class Graph(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<(HttpRequestMessage Request, JsonDocument Body)> Calls { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls.Add((request, JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct))));
            return answer(request);
        }
    }

    private sealed class Token : ICredentialSource
    {
        public Task<string> GetTokenAsync(string scope, CancellationToken ct) => Task.FromResult("token-for-" + scope);
    }

    private static HttpResponseMessage Json(object body) => new(HttpStatusCode.OK) { Content = JsonContent.Create(body) };

    private static (ResourceGraphInventory Reader, Graph Graph) Reader(Func<HttpRequestMessage, JsonDocument, HttpResponseMessage> answer, string? connection = null, ScopeRules? rules = null)
    {
        Graph? graph = null;
        graph = new Graph(r => answer(r, graph!.Calls[^1].Body));
        return (new ResourceGraphInventory(new HttpClient(graph), new Token(), new RegistrySource("inventory", "resourcegraph", connection), rules ?? Prod(TownA).ActiveEnvironment!.Scope), graph);
    }

    private static object Rows(Inventory inventory, bool subscriptions) => subscriptions
        ? inventory.Subscriptions.Select(s => new { id = s.Id, name = s.Name, tags = s.Tags })
        : inventory.Resources.Select(x => new { id = x.Id, name = x.Name, type = x.Type, subscriptionId = x.SubscriptionId, location = x.Region, tags = x.Tags });

    [Fact]
    public async Task The_adapter_asks_for_subscriptions_then_for_the_resources_of_the_ones_the_rules_chose()
    {
        var recorded = Recorded(TownA);
        var (reader, graph) = Reader((_, body) => Json(new { data = body.RootElement.GetProperty("query").GetString()!.StartsWith("resourcecontainers") ? Rows(recorded, true) : Rows(recorded, false) }));

        var inventory = await reader.ReadAsync(Prod(TownA), CancellationToken.None);

        Assert.Equal(2, graph.Calls.Count);
        Assert.Contains("resourcecontainers", graph.Calls[0].Body.RootElement.GetProperty("query").GetString());
        Assert.False(graph.Calls[0].Body.RootElement.TryGetProperty("subscriptions", out _)); // nothing limits the first: the login's own subscriptions
        var second = graph.Calls[1].Body.RootElement;
        Assert.Equal(["00000000-0000-0000-0000-0000000000a1", "00000000-0000-0000-0000-0000000000a2"], second.GetProperty("subscriptions").EnumerateArray().Select(x => x.GetString()).Order()); // not the staging one
        Assert.Contains("'microsoft.web/serverfarms', 'microsoft.web/sites', 'microsoft.documentdb/databaseaccounts'", second.GetProperty("query").GetString());
        Assert.Equal("Bearer token-for-" + ResourceGraphInventory.TokenScope, graph.Calls[0].Request.Headers.Authorization!.ToString());
        Assert.Equal(recorded.Resources.Count, inventory.Resources.Count);
        Assert.Equal("Acme Bank", inventory.Resources.First(x => x.Name.StartsWith("1111")).Tags["tenant"]);
    }

    [Fact]
    public async Task The_adapter_reads_every_page_and_cuts_nothing_off()
    {
        var pages = 0;
        var (reader, _) = Reader((_, body) =>
        {
            var options = body.RootElement.GetProperty("options");
            Assert.Equal(1000, options.GetProperty("$top").GetInt32());
            if (!body.RootElement.GetProperty("query").GetString()!.StartsWith("resourcecontainers")) return Json(new { data = Array.Empty<object>() });
            pages++;
            var token = options.TryGetProperty("$skipToken", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            return token is null
                ? Json(new Dictionary<string, object> { ["data"] = new[] { new { id = "a", name = "acme-eu-prd-al", tags = new { } } }, ["$skipToken"] = "page-2" })
                : Json(new { data = new[] { new { id = "b", name = "acme-eu-prd-be", tags = new { } } } });
        });

        var inventory = await reader.ReadAsync(Prod(TownA), CancellationToken.None);

        Assert.Equal(2, pages);
        Assert.Equal(["a", "b"], inventory.Subscriptions.Select(s => s.Id));
    }

    [Fact]
    public async Task A_connection_limits_the_scope_and_an_overridden_query_is_the_one_sent()
    {
        var rules = Prod(TownA).ActiveEnvironment!.Scope with { Queries = new ScopeQueries("resourcecontainers | where name startswith 'x'", null) };
        var (reader, graph) = Reader((_, _) => Json(new { data = Array.Empty<object>() }), "sub-1, sub-2", rules);

        await reader.ReadAsync(Prod(TownA), CancellationToken.None);

        var body = graph.Calls[0].Body.RootElement;
        Assert.Equal("resourcecontainers | where name startswith 'x'", body.GetProperty("query").GetString());
        Assert.Equal(["sub-1", "sub-2"], body.GetProperty("subscriptions").EnumerateArray().Select(x => x.GetString()));
    }

    [Fact]
    public async Task A_refused_read_says_what_azure_answered()
    {
        var (reader, _) = Reader((_, _) => new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("{\"error\":\"AuthorizationFailed\"}") });

        var e = await Assert.ThrowsAsync<HttpRequestException>(() => reader.ReadAsync(Prod(TownA), CancellationToken.None));

        Assert.Contains("403", e.Message);
        Assert.Contains("AuthorizationFailed", e.Message);
    }

    [Fact]
    public async Task The_source_leaves_what_it_read_in_the_store_and_keeps_it_when_a_later_read_fails()
    {
        var store = new ScopeStore();
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-01-01T00:00:00Z"));
        var source = (ResourceGraphSource)new ResourceGraphSourceFactory(time: time).Create(
            new SourceContext("prod", new RegistrySource("inventory", "resourcegraph", "file:inventory.json"), null, Prod(TownA).ActiveEnvironment!.Scope, store, TownA));

        var readings = await source.PollAsync(RegistryLoader.Load(TownA), CancellationToken.None);

        Assert.Equal(["aa.orders-api", "aa.orders-worker", "bb.ledger-api", "bb.ledger-worker"], readings.Keys.Order()); // the instance counts
        Assert.Equal(time.GetUtcNow(), store.ReadAt);
        Assert.Equal("OrdersApi", store.Resolve(Prod(TownA)).System("aa.orders-api")!.TelemetryRole);
        Assert.Equal(3, store.Resolve(Prod(TownA)).System("aa.orders-db")!.Resources.Count);

        var failing = new ResourceGraphSource("inventory", "prod", new RegistrySource("inventory", "resourcegraph", null),
            new ResourceGraphInventory(new HttpClient(new Graph(_ => new HttpResponseMessage(HttpStatusCode.TooManyRequests) { Content = new StringContent("slow down") })), null, new RegistrySource("inventory", "resourcegraph", null), Prod(TownA).ActiveEnvironment!.Scope),
            store, null, time);
        await Assert.ThrowsAsync<HttpRequestException>(() => failing.PollAsync(RegistryLoader.Load(TownA), CancellationToken.None));

        Assert.Contains("429", store.Error);
        Assert.NotNull(store.Inventory); // the last good read stands
    }

    [Fact]
    public void A_recording_that_is_not_there_keeps_the_source_from_starting()
    {
        var set = new AdapterCatalog([new AzureAdapters()]).Build(RegistryLoader.Load(TownA).Environments.Single() with
        {
            Sources = [new RegistrySource("inventory", "resourcegraph", "file:missing.json")],
        }, TownA);

        Assert.Empty(set.Sources);
        Assert.Contains(set.Problems, p => p.Contains("the recording missing.json does not exist"));
    }

    [Fact]
    public void The_catalog_hands_the_inventory_source_the_rules_and_the_store_of_its_environment()
    {
        var set = new AdapterCatalog([new AzureAdapters()]).Build(RegistryLoader.Load(TownA).Environments.Single(), TownA);

        Assert.Equal(2, set.Sources.Count);
        Assert.IsType<ResourceGraphSource>(set.Sources[0]);
        Assert.IsType<LogAnalyticsSource>(set.Sources[1]);
        Assert.NotNull(set.Scope);
    }

    // ---- served ----

    private static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    private static async Task<SystemDetail> ServedDetail(string folder, string id)
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Registry:Path", folder);
            b.UseSetting("Registry:WatchSeconds", "0");
            b.UseSetting("Snapshot:IntervalSeconds", "0.2");
        });
        var client = factory.CreateClient();
        for (var i = 0; i < 100; i++)
        {
            var response = await client.GetAsync($"/api/systems/{id}", TestContext.Current.CancellationToken);
            var detail = await response.Content.ReadFromJsonAsync<SystemDetail>(Wire, TestContext.Current.CancellationToken);
            if (detail?.Scope is { InventoryState: "read" }) return detail;
            await Task.Delay(100, TestContext.Current.CancellationToken);
        }
        throw new TimeoutException("The inventory was not read");
    }

    [Fact]
    public async Task The_server_says_where_a_system_lives_once_the_inventory_is_read()
    {
        var detail = await ServedDetail(TownA, "aa.orders-api");

        var scope = detail.Scope!;
        Assert.Equal("acme-eu-prd-al", scope.Subscription);
        Assert.Equal("name", scope.SubscriptionVia);
        Assert.Equal("ws-prd-main", scope.Workspace);
        Assert.Equal("OrdersApi", scope.TelemetryRole);
        Assert.Equal("ord", scope.ServiceCode);
        Assert.Equal(3, scope.Resources.Count);
        Assert.Empty(scope.Problems);
    }

    [Fact]
    public async Task The_server_gives_the_tenants_of_a_database_by_name()
    {
        var detail = await ServedDetail(TownB, "aa.orders-db");

        Assert.Equal(["Acme Bank", "Borealis Credit Union", "Cygnus Finance"], detail.Scope!.Resources.Select(x => x.Tenant).Order());
    }

    [Fact]
    public async Task A_town_without_scope_rules_serves_no_scope_at_all()
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Registry:Path", TestPaths.LiveTown);
            b.UseSetting("Registry:WatchSeconds", "0");
        });

        var detail = await factory.CreateClient().GetFromJsonAsync<SystemDetail>("/api/systems/aa.orders-api", Wire, TestContext.Current.CancellationToken);

        Assert.Null(detail!.Scope);
    }
}
