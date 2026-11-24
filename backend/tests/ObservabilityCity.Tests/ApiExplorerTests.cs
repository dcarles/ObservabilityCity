using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Apis;
using ObservabilityCity.Core.Links;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Host;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// The API explorer: a catalogue of the APIs of the town's gateways, read on demand from a source whose kind can (on Azure, an API Management service), matched to the town's systems by their backend
/// address with rules that are config only, merged when the gateways are copies of one another, with anything secret-looking in a policy masked. The core knows no cloud: these tests run the same
/// code with a stub source, with the Azure adapter against recorded answers, and through the running server for a demo town.
/// </summary>
public class ApiExplorerTests
{
    // ---- masking -------------------------------------------------------------------------------------------------------------------------

    [Fact]
    public void A_policy_keeps_what_it_says_and_loses_what_looks_like_a_secret()
    {
        const string xml = """
            <policies><inbound>
              <set-header name="Authorization" exists-action="override"><value>Basic dXNlcjpwYXNzd29yZDEyMzQ1Njc4OTA=</value></set-header>
              <set-header name="X-Api-Key"><value>abcDEF0123456789abcDEF0123456789</value></set-header>
              <set-header name="X-Tenant"><value>acme</value></set-header>
              <validate-jwt header-name="Authorization" client-secret="hunter2hunter2" require-signed-tokens="true" />
              <authentication-basic username="svc" password="{{service-password}}" />
              <set-variable name="sas" value="sig=0123456789abcdef0123456789abcdef0123" />
              <rate-limit calls="100" renewal-period="60" />
              <set-header name="Auth2"><value>Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature</value></set-header>
              <set-backend-service base-url="https://orders.example.test/api" />
            </inbound></policies>
            """;
        var masked = PolicyMask.Apply(xml);
        Assert.DoesNotContain("dXNlcjpwYXNzd29yZDEyMzQ1Njc4OTA", masked);
        Assert.DoesNotContain("abcDEF0123456789", masked);
        Assert.DoesNotContain("hunter2", masked);
        Assert.DoesNotContain("eyJhbGciOiJIUzI1NiJ9", masked);
        Assert.DoesNotContain("0123456789abcdef0123456789abcdef0123", masked);
        // what makes the policy readable stays
        Assert.Contains("<value>acme</value>", masked);
        Assert.Contains("password=\"{{service-password}}\"", masked);
        Assert.Contains("require-signed-tokens=\"true\"", masked);
        Assert.Contains("calls=\"100\" renewal-period=\"60\"", masked);
        Assert.Contains("base-url=\"https://orders.example.test/api\"", masked);
        Assert.Contains("header-name=\"Authorization\"", masked);
        Assert.Contains(PolicyMask.Masked, masked);
    }

    // ---- reading what API Management answers ---------------------------------------------------------------------------------------------

    private const string ApiList = """
        { "value": [
          { "name": "ams-as", "properties": { "displayName": "ams-as", "path": "ams/as", "serviceUrl": "https://as.example.test/", "isCurrent": true } },
          { "name": "ams-as;rev=2", "properties": { "displayName": "ams-as", "path": "ams/as", "serviceUrl": "https://as2.example.test/", "isCurrent": false } },
          { "name": "payments", "properties": { "displayName": "Payments", "path": "pay", "serviceUrl": "https://pay.example.test/api" } } ],
          "nextLink": "https://management.azure.com/next-page" }
        """;

    private const string Operations = """
        { "value": [ { "name": "put-flag", "properties": { "displayName": "AddFlag", "method": "put", "urlTemplate": "/account/{accountId}/flag/{key}", "description": "Adds a flag.",
              "templateParameters": [ { "name": "accountId", "type": "string" }, { "name": "key", "type": "string" } ],
              "request": { "queryParameters": [ { "name": "dryRun", "type": "boolean", "required": false } ], "headers": [ { "name": "context-tenantid", "type": "string", "required": true } ] },
              "responses": [ { "statusCode": 204 }, { "statusCode": 400 }, { "statusCode": 404 }, { "statusCode": 204 } ] } } ] }
        """;

    [Fact]
    public void The_list_of_apis_leaves_out_a_revision_that_is_not_current_and_follows_the_next_page()
    {
        var (apis, next) = ApiManagementReading.ParseApis(ApiList);
        Assert.Equal(["ams-as", "payments"], apis.Select(a => a.Name));
        Assert.Equal("https://as.example.test/", apis[0].BackendUrl);
        Assert.Equal("Payments", apis[1].DisplayName);
        Assert.Equal("https://management.azure.com/next-page", next);
    }

    [Fact]
    public void An_operation_has_its_call_its_parameters_from_the_path_the_query_and_the_headers_and_each_response_code_once()
    {
        var (ops, next) = ApiManagementReading.ParseOperations(Operations);
        var op = Assert.Single(ops);
        Assert.Null(next);
        Assert.Equal(("PUT", "/account/{accountId}/flag/{key}"), (op.Method, op.UrlTemplate));
        Assert.Equal([("accountId", "path", true), ("key", "path", true), ("dryRun", "query", false), ("context-tenantid", "header", true)], op.Parameters.Select(p => (p.Name, p.In, p.Required)));
        Assert.Equal([204, 400, 404], op.Responses);
    }

    [Fact]
    public void A_policy_is_read_without_the_byte_order_mark_or_out_of_its_json_wrapper_and_empty_is_none()
    {
        Assert.Equal("<policies />", ApiManagementReading.ParsePolicy("﻿<policies />\n"));
        Assert.Equal("<policies><inbound /></policies>", ApiManagementReading.ParsePolicy("{\"properties\":{\"format\":\"xml\",\"value\":\"\\uFEFF<policies><inbound /></policies>\"}}"));
        Assert.Null(ApiManagementReading.ParsePolicy("﻿  "));
    }

    [Fact]
    public void The_fragments_a_policy_includes_are_listed_once_and_a_reference_to_a_named_value_is_not_one()
    {
        var ids = ApiManagementReading.Fragments("<inbound><include-fragment fragment-id=\"a-b\" /><include-fragment fragment-id=\"a-b\" /><include-fragment fragment-id=\"{{named}}\" /><include-fragment fragment-id=\"c\"/></inbound>");
        Assert.Equal(["a-b", "c"], ids);
    }

    private static readonly GatewayRef Gateway = new("/subscriptions/s1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/gw1", "gw1", "north");

    private static ApiManagementSource Source(CannedHttp http) =>
        new("gateway", new AzureMonitorReader(new HttpClient(http), null, TimeSpan.Zero));

    [Fact]
    public async Task The_azure_source_lists_every_page_with_its_own_login_and_the_apis_version_it_was_written_for()
    {
        var http = new CannedHttp()
            .Answer(ApiList)
            .Answer("""{ "value": [ { "name": "last", "properties": { "displayName": "Last", "path": "l", "serviceUrl": "https://l.example.test" } } ] }""");
        var apis = await Source(http).ListAsync(Gateway, CancellationToken.None);
        Assert.Equal(["ams-as", "payments", "last"], apis.Select(a => a.Name));
        Assert.Equal(2, http.Sent.Count);
        Assert.StartsWith("https://management.azure.com/subscriptions/s1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/gw1/apis?api-version=2022-08-01", http.Sent[0].Uri!.ToString());
        Assert.Equal("https://management.azure.com/next-page", http.Sent[1].Uri!.ToString());
    }

    [Fact]
    public async Task A_missing_policy_is_no_policy_and_a_fragment_that_cannot_be_read_is_listed_without_text()
    {
        var http = new CannedHttp()
            .Answer(Operations)
            .Answer("""<policies><inbound><base /><include-fragment fragment-id="good" /><include-fragment fragment-id="gone" /></inbound></policies>""")
            .Answer("""<fragment><set-header name="x" /></fragment>""")
            .Answer("""{ "error": { "code": "ResourceNotFound" } }""", HttpStatusCode.NotFound);
        var detail = await Source(http).DetailAsync(Gateway, "ams-as", CancellationToken.None);
        Assert.Single(detail.Operations);
        Assert.Equal(["good", "gone"], detail.Policy!.Fragments.Select(f => f.Id));
        Assert.Contains("set-header", detail.Policy.Fragments[0].Xml);
        Assert.Null(detail.Policy.Fragments[1].Xml);

        var none = new CannedHttp().Answer(Operations).Answer("""{ "error": { "code": "ResourceNotFound", "message": "PoliciesConfiguration not found." } }""", HttpStatusCode.NotFound);
        Assert.Null((await Source(none).DetailAsync(Gateway, "ams-as", CancellationToken.None)).Policy);
    }

    [Fact]
    public async Task The_azure_source_fills_no_signal_so_no_signal_has_to_name_it()
    {
        var source = Source(new CannedHttp());
        Assert.Empty(await source.PollAsync(RegistryLoader.Load(TestPaths.Registry), CancellationToken.None));
        Assert.True(new AdapterCatalog([new AzureAdapters()]).CapabilitiesOf(ApiManagementSourceFactory.SourceKind).HasFlag(SourceCapabilities.ApiCatalogue));
    }

    // ---- the catalogue -------------------------------------------------------------------------------------------------------------------

    private sealed class Stub : IApiCatalogueSource
    {
        public Dictionary<string, List<SourceApi>> Apis { get; } = [];
        public Dictionary<string, SourceApiDetail> Details { get; } = [];
        public HashSet<string> Failing { get; } = [];
        public int ListCalls;
        public string Name => "stub";

        public Task<IReadOnlyList<SourceApi>> ListAsync(GatewayRef gateway, CancellationToken ct)
        {
            Interlocked.Increment(ref ListCalls);
            if (Failing.Contains(gateway.Label)) throw new InvalidOperationException($"{gateway.Label} refused");
            return Task.FromResult<IReadOnlyList<SourceApi>>(Apis.GetValueOrDefault(gateway.Label) ?? []);
        }

        public Task<SourceApiDetail> DetailAsync(GatewayRef gateway, string apiId, CancellationToken ct) => Task.FromResult(Details[$"{gateway.Label}/{apiId}"]);
        public Task<SourcePolicy?> OperationPolicyAsync(GatewayRef gateway, string apiId, string operationId, CancellationToken ct) =>
            Task.FromResult<SourcePolicy?>(operationId == "get" ? new SourcePolicy("<policies><inbound><set-header name=\"x-api-key\"><value>abcDEF0123456789abcDEF0123456789</value></set-header></inbound></policies>", []) : null);
    }

    private static ApiOperationInfo Op(string id, string method, string url) => new(id, id, method, url, null, [], [200]);

    private static (ApiCatalogue Catalogue, Stub Stub, FakeTimeProvider Time) Catalogue(bool merge, Func<string, string?>? hostSystem = null)
    {
        var stub = new Stub();
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 11, 24, 12, 0, 0, TimeSpan.Zero));
        var registries = new EnvironmentRegistry(new RegistryHolder(RegistryLoader.Load(TestPaths.Registry)), "prod");
        var gateways = new List<GatewayRef> { new("gw-n", "gw-n", "north"), new("gw-w", "gw-w", "west") };
        var config = new ApiCatalogueConfig("stub", "hub.apim", merge, [], TimeSpan.FromHours(1));
        return (new ApiCatalogue(registries, new ScopeStore(), _ => stub, time, new ApiCatalogueOverrides(config, _ => gateways, hostSystem)), stub, time);
    }

    [Fact]
    public async Task Gateways_that_are_copies_list_an_api_once_and_say_where_it_is_missing()
    {
        var (catalogue, stub, _) = Catalogue(merge: true, host => host == "orders.example.test" ? "acc.accounts-api" : null);
        stub.Apis["north"] = [new("orders", "orders", "Orders", "o", "https://orders.example.test/"), new("only-north", "only-north", "Only north", "n", "https://x.example.test/")];
        stub.Apis["west"] = [new("orders", "orders", "Orders", "o", "https://orders.example.test/")];
        var list = await catalogue.ListAsync(CancellationToken.None);
        Assert.True(list.Configured);
        Assert.Equal(["Only north", "Orders"], list.Apis.Select(a => a.DisplayName));
        var orders = list.Apis.Single(a => a.Name == "orders");
        Assert.Equal(["north", "west"], orders.Gateways);
        Assert.Empty(orders.MissingFrom);
        Assert.Equal(("acc.accounts-api", "acc"), (orders.SystemId, orders.GroupId));
        Assert.Equal("orders.example.test", orders.BackendHost);
        var lonely = list.Apis.Single(a => a.Name == "only-north");
        Assert.Equal(["west"], lonely.MissingFrom);
        Assert.Null(lonely.SystemId);
    }

    [Fact]
    public async Task Gateways_that_are_not_copies_list_each_ones_apis_apart()
    {
        var (catalogue, stub, _) = Catalogue(merge: false);
        stub.Apis["north"] = [new("orders", "orders", "Orders", null, null)];
        stub.Apis["west"] = [new("orders", "orders", "Orders", null, null)];
        var list = await catalogue.ListAsync(CancellationToken.None);
        Assert.Equal(["north:orders", "west:orders"], list.Apis.Select(a => a.Id).Order());
        Assert.All(list.Apis, a => Assert.Empty(a.MissingFrom));
    }

    [Fact]
    public async Task A_gateway_that_cannot_be_read_is_a_problem_not_a_failure_and_says_nothing_about_what_is_missing()
    {
        var (catalogue, stub, _) = Catalogue(merge: true);
        stub.Apis["north"] = [new("orders", "orders", "Orders", null, null)];
        stub.Failing.Add("west");
        var list = await catalogue.ListAsync(CancellationToken.None);
        Assert.Single(list.Apis);
        Assert.Empty(list.Apis[0].MissingFrom);
        Assert.Contains("west: west refused", list.Problems);
    }

    [Fact]
    public async Task What_is_read_is_kept_for_the_cache_time_and_a_failed_read_is_asked_again()
    {
        var (catalogue, stub, time) = Catalogue(merge: true);
        stub.Apis["north"] = [new("orders", "orders", "Orders", null, null)];
        stub.Failing.Add("west");
        await catalogue.ListAsync(CancellationToken.None);
        var first = stub.ListCalls;
        await catalogue.ListAsync(CancellationToken.None);
        Assert.Equal(first + 1, stub.ListCalls); // the north list came from the cache, the failed west read was asked again
        stub.Failing.Clear();
        time.Advance(TimeSpan.FromHours(2));
        var before = stub.ListCalls;
        await catalogue.ListAsync(CancellationToken.None);
        Assert.Equal(before + 2, stub.ListCalls); // both are read again once the cache time has passed
    }

    [Fact]
    public async Task The_detail_says_what_differs_between_the_gateways_and_hides_what_looks_like_a_secret()
    {
        var (catalogue, stub, _) = Catalogue(merge: true);
        stub.Apis["north"] = [new("orders", "orders", "Orders", null, "https://o.example.test/")];
        stub.Apis["west"] = [new("orders", "orders", "Orders", null, "https://o.example.test/")];
        stub.Details["north/orders"] = new([Op("get", "GET", "/orders/{id}"), Op("add", "POST", "/orders")], new SourcePolicy("<policies><inbound><rate-limit calls=\"100\" /><set-header name=\"Authorization\"><value>Bearer abcdefghijklmnop</value></set-header></inbound></policies>", [new ApiFragmentInfo("f", "<fragment password=\"hunter2hunter2\" />")]));
        stub.Details["west/orders"] = new([Op("get", "GET", "/orders/{id}")], new SourcePolicy("<policies><inbound><rate-limit calls=\"50\" /></inbound></policies>", []));
        var detail = (await catalogue.DetailAsync("orders", CancellationToken.None))!;
        Assert.Equal(2, detail.Operations.Count);
        Assert.Contains("west lacks 1 operation: POST /orders.", detail.Differences);
        Assert.Contains("The policy differs between north and west.", detail.Differences);
        Assert.DoesNotContain("abcdefghijklmnop", detail.Policy!.Xml);
        Assert.Contains(PolicyMask.Masked, detail.Policy.Xml);
        Assert.DoesNotContain("hunter2", detail.Policy.Fragments[0].Xml);
        Assert.Null(await catalogue.DetailAsync("nope", CancellationToken.None));
    }

    [Fact]
    public async Task One_gateway_that_agrees_with_itself_has_nothing_to_differ_on_and_an_operation_policy_is_masked_or_none()
    {
        var (catalogue, stub, _) = Catalogue(merge: true);
        stub.Apis["north"] = [new("orders", "orders", "Orders", null, null)];
        stub.Apis["west"] = [new("orders", "orders", "Orders", null, null)];
        var same = new SourceApiDetail([Op("get", "GET", "/o")], null);
        stub.Details["north/orders"] = same;
        stub.Details["west/orders"] = same;
        Assert.Empty((await catalogue.DetailAsync("orders", CancellationToken.None))!.Differences);
        var policy = (await catalogue.OperationPolicyAsync("orders", "get", CancellationToken.None))!;
        Assert.DoesNotContain("abcDEF0123456789", policy.Xml);
        Assert.Null((await catalogue.OperationPolicyAsync("orders", "other", CancellationToken.None))!.Xml);
    }

    [Fact]
    public async Task An_environment_with_no_apis_block_says_it_is_not_configured()
    {
        var registries = new EnvironmentRegistry(new RegistryHolder(RegistryLoader.Load(TestPaths.Registry)), "prod");
        var list = await new ApiCatalogue(registries, new ScopeStore(), _ => null, TimeProvider.System).ListAsync(CancellationToken.None);
        Assert.False(list.Configured);
        Assert.Empty(list.Apis);
    }

    // ---- matching a backend to a system --------------------------------------------------------------------------------------------------

    private static (TownRegistry View, RegistryEnvironment Environment) Town(Func<RegistryEnvironment, RegistryEnvironment>? change = null)
    {
        var registry = RegistryLoader.Load(TestPaths.Registry);
        var environment = registry.Environments.First(e => e.Id == "prod");
        var view = new EnvironmentRegistry(new RegistryHolder(registry), "prod").Current;
        return (view, change is null ? environment : change(environment));
    }

    private static ApiCatalogueConfig Config(params string[] resourceHosts) => new("s", "hub.apim", false, resourceHosts, TimeSpan.FromHours(1));

    private static LinkDiscovery Rules(params LinkRule[] rules) =>
        new("metrics", "q", TimeSpan.FromHours(1), TimeSpan.FromDays(7), 2, TimeSpan.FromDays(30), [], rules, new Dictionary<string, string>());

    [Fact]
    public void A_backend_is_matched_by_the_links_rules_the_environment_already_has()
    {
        var (view, env) = Town(e => e with { Links = Rules(new LinkRule(@"^(?<service>[a-z]+)\.(?<group>[a-z]+)\.stratus\.example\.test$", null, "{group}.{service}-api", false)) });
        var matcher = new ApiMatcher(view, env, Config(), Resolution.Empty);
        Assert.Equal("acc.accounts-api", matcher.Match("https://accounts.acc.stratus.example.test/api").SystemId);
        Assert.Null(matcher.Match("https://unknown.example.test/").SystemId);
        Assert.Equal(ApiMatch.None, matcher.Match(null));
        Assert.Equal(ApiMatch.None, matcher.Match("not an address"));
    }

    [Fact]
    public void A_backend_that_is_one_of_the_towns_own_resources_is_matched_through_the_address_template_to_the_system_that_owns_it()
    {
        var (view, env) = Town();
        SystemScope Owner(string system, params string[] names) => new(system, null, null, null, null, null, names.Select(n => new ResolvedResource($"/r/{n}", n, "t", null, null, "rule")).ToList());
        var resolution = new Resolution([], [Owner("acc.accounts-api", "funapp-accounts"), Owner("acc.limits-api", "shared"), Owner("acq.applications-api", "shared")], [], [], true, null);
        var matcher = new ApiMatcher(view, env, Config("{name}.azurewebsites.example.test"), resolution);
        Assert.Equal("acc.accounts-api", matcher.Match("https://FunApp-Accounts.azurewebsites.example.test/api").SystemId);
        Assert.Null(matcher.Match("https://funapp-accounts.other.example.test/").SystemId);
        // a name two systems claim is ambiguous and never used
        Assert.Null(matcher.Match("https://shared.azurewebsites.example.test/").SystemId);
    }

    [Fact]
    public void A_backend_on_a_third_partys_domain_is_that_third_party()
    {
        using var copy = new RegistryCopy(TestPaths.Registry);
        copy.Replace("third-parties.yaml", "{ id: ext.card-network, name: Card network,", "{ id: ext.card-network, domains: [cards.example.test], name: Card network,");
        var registry = RegistryLoader.Load(copy.Path);
        var view = new EnvironmentRegistry(new RegistryHolder(registry), "prod").Current;
        var match = new ApiMatcher(view, registry.Environments.First(e => e.Id == "prod"), Config(), Resolution.Empty).Match("https://api.cards.example.test/v1");
        Assert.Equal(("ext.card-network", null), (match.ThirdPartyId ?? match.SystemId, null as string));
        Assert.Null(match.SystemId);
    }

    // ---- the environment file ------------------------------------------------------------------------------------------------------------

    private static string LoadProblem(string apis)
    {
        using var copy = new RegistryCopy(TestPaths.Registry);
        copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + "\n" + apis);
        return Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;
    }

    [Fact]
    public void The_apis_block_is_read_and_checked()
    {
        using (var copy = new RegistryCopy(TestPaths.Registry))
        {
            copy.Write("environments/prod.yaml", copy.Read("environments/prod.yaml") + "\napis:\n  source: metrics\n  gateway: hub.apim\n  merge: true\n  cacheFor: 30m\n  resourceHosts: ['{name}.example.test']\n");
            var apis = RegistryLoader.Load(copy.Path).Environments.First(e => e.Id == "prod").Apis!;
            Assert.Equal(("metrics", "hub.apim", true, TimeSpan.FromMinutes(30)), (apis.Source, apis.Gateway, apis.Merge, apis.CacheFor));
            Assert.Equal(["{name}.example.test"], apis.ResourceHosts);
        }
        Assert.Contains("apis.source 'nope' is not a source of this file", LoadProblem("apis:\n  source: nope\n  gateway: hub.apim\n"));
        Assert.Contains("apis.gateway is empty", LoadProblem("apis:\n  source: metrics\n  gateway: ''\n"));
        Assert.Contains("apis.cacheFor 'soon' is not a number and a unit", LoadProblem("apis:\n  source: metrics\n  gateway: hub.apim\n  cacheFor: soon\n"));
        Assert.Contains("resourceHosts 'example.test' has no {name}", LoadProblem("apis:\n  source: metrics\n  gateway: hub.apim\n  resourceHosts: [example.test]\n"));
    }

    [Fact]
    public void Only_a_source_of_a_kind_that_can_read_apis_may_be_named_and_it_needs_no_signal()
    {
        using var copy = new RegistryCopy(TestPaths.Registry);
        var file = copy.Read("environments/prod.yaml").Replace("metrics: { kind: fake }", "metrics: { kind: loganalytics, connection: ws, query: q }\n  gateways: { kind: apimanagement }");
        copy.Write("environments/prod.yaml", file + "\napis:\n  source: metrics\n  gateway: hub.apim\n");
        var catalog = TestAdapters.Azure;
        // a source of a kind that cannot read APIs is named
        Assert.Contains(catalog.Check(RegistryLoader.Load(copy.Path).Environments.First(e => e.Id == "prod")), p => p.Contains("apis.source 'metrics'") && p.Contains("cannot read the APIs of a gateway"));
        copy.Write("environments/prod.yaml", file + "\napis:\n  source: gateways\n  gateway: hub.apim\n");
        var registry = RegistryLoader.Load(copy.Path);
        Assert.DoesNotContain(catalog.Check(registry.Environments.First(e => e.Id == "prod")), p => p.Contains("apis.source"));
        // it fills no signal, so it is not reported as a source nobody uses
        var warnings = new EnvironmentRegistry(new RegistryHolder(registry), "prod", kinds: catalog).Current.Warnings;
        Assert.DoesNotContain(warnings, w => w.Contains("source 'gateways'"));
    }

    // ---- through the server, in a demo town ----------------------------------------------------------------------------------------------

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    [Fact]
    public async Task A_demo_town_answers_the_explorers_three_endpoints_from_its_own_registry()
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Registry:Path", TestPaths.Registry);
            b.UseSetting("Registry:WatchSeconds", "0");
        });
        var client = factory.CreateClient();
        var list = (await client.GetFromJsonAsync<ApiCatalogueList>("/api/apis", Json, TestContext.Current.CancellationToken))!;
        Assert.True(list.Configured);
        var accounts = list.Apis.Single(a => a.Name == "acc-accounts");
        Assert.Equal(("acc.accounts-api", "acc"), (accounts.SystemId, accounts.GroupId));
        Assert.Equal(["API gateway", "Partner API gateway"], accounts.Gateways.Order());
        // the second gateway skips every third API, so something in the demo shows the marker
        Assert.Contains(list.Apis, a => a.MissingFrom.Count > 0);

        var detail = (await client.GetFromJsonAsync<ApiDetail>($"/api/api-detail?id={Uri.EscapeDataString(accounts.Id)}", Json, TestContext.Current.CancellationToken))!;
        Assert.Equal(3, detail.Operations.Count);
        Assert.Contains("<include-fragment", detail.Policy!.Xml);
        Assert.Equal("correlation-id", Assert.Single(detail.Policy.Fragments).Id);

        var policy = (await client.GetFromJsonAsync<ApiPolicyInfo>($"/api/api-operation-policy?id={Uri.EscapeDataString(accounts.Id)}&operation=create", Json, TestContext.Current.CancellationToken))!;
        Assert.Contains("validate-content", policy.Xml);
        Assert.Null((await client.GetFromJsonAsync<ApiPolicyInfo>($"/api/api-operation-policy?id={Uri.EscapeDataString(accounts.Id)}&operation=get", Json, TestContext.Current.CancellationToken))!.Xml);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/api-detail?id=nothing", TestContext.Current.CancellationToken)).StatusCode);
    }
}
