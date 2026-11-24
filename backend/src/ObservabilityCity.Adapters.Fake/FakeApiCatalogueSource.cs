using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Apis;
using ObservabilityCity.Core.Registry;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Adapters.Fake;

/// <summary>
/// Makes up the API explorer's data for a demo town from its own registry: each gateway of the hub serves the town's API systems (the second and later gateways skip every third one, so the
/// explorer's "differs between gateways" marker has something to show), each with a few operations and a small policy that includes one fragment. The backend address of an API is
/// <c>https://&lt;service&gt;.&lt;group&gt;.example.test/</c>, which <see cref="HostSystem"/> reads back, so a demo API matches its system the way a live one matches by host.
/// </summary>
public sealed class FakeApiCatalogueSource(IRegistryProvider registries) : IApiCatalogueSource
{
    public const string Suffix = ".example.test";

    public string Name => "fake";

    public static ApiCatalogueConfig Config { get; } = new("fake", "", true, [], TimeSpan.FromHours(1));

    /// <summary>The gateways of the demo town: its hub systems of the gateway kind, in the order the files list them.</summary>
    public static IReadOnlyList<GatewayRef> Gateways(TownRegistry registry) =>
        registry.AllNodes.Where(n => n.Kind == NodeKind.Gateway).Select(n => new GatewayRef(n.Id, n.Name, n.Name)).ToList();

    /// <summary>The system a demo backend address belongs to, from its host (<c>service.group.example.test</c>); null when the host is not one of the demo's.</summary>
    public static Func<string, string?> HostSystem(IRegistryProvider provider) => host =>
    {
        if (!host.EndsWith(Suffix, StringComparison.OrdinalIgnoreCase)) return null;
        var parts = host[..^Suffix.Length].Split('.');
        return parts.Length == 2 && provider.Current.AllNodes.FirstOrDefault(n => n.Service is not null && n.GroupId.Equals(parts[1], StringComparison.OrdinalIgnoreCase)
            && n.Service.Equals(parts[0], StringComparison.OrdinalIgnoreCase)) is { } node ? node.Id : null;
    };

    private IEnumerable<RegistryNode> ApiNodes => registries.Current.AllNodes.Where(n => n.Kind == NodeKind.Api && n.Service is not null && n.GroupId is not null);

    public Task<IReadOnlyList<SourceApi>> ListAsync(GatewayRef gateway, CancellationToken ct)
    {
        var gateways = Gateways(registries.Current).Select(g => g.Id).ToList();
        var index = Math.Max(0, gateways.IndexOf(gateway.Id));
        IReadOnlyList<SourceApi> apis = ApiNodes.Select((n, i) => (n, i)).Where(x => index == 0 || x.i % 3 != 2)
            .Select(x => new SourceApi(NameOf(x.n), NameOf(x.n), NameOf(x.n), $"{x.n.GroupId}/{x.n.Service}", $"https://{x.n.Service}.{x.n.GroupId}{Suffix}/")).ToList();
        return Task.FromResult(apis);
    }

    private static string NameOf(RegistryNode n) => $"{n.GroupId}-{n.Service}";

    public Task<SourceApiDetail> DetailAsync(GatewayRef gateway, string apiId, CancellationToken ct)
    {
        var path = apiId.Replace('-', '/');
        var gateways = Gateways(registries.Current).Select(g => g.Id).ToList();
        ApiRepresentation Json(string type, string? example, params ApiField[] fields) => new("application/json", type, example, fields);
        ApiResponseInfo Reply(int code, string text, params ApiRepresentation[] bodies) => new(code, text, bodies);
        var item = Json("Item", "{\n  \"id\": \"3f2b8c1e\",\n  \"name\": \"Example\"\n}", new ApiField("id", "string (uuid)", true, null, []), new ApiField("name", "string", true, null, []),
            new ApiField("address", "object", false, null, [new ApiField("line1", "string", true, null, []), new ApiField("postcode", "string", false, null, [])]));
        var problem = Json("Problem", null, new ApiField("title", "string", true, null, []), new ApiField("status", "integer", false, null, []));
        var created = new ApiBodyInfo("What to create", [Json("CreateItem", "{\n  \"name\": \"Example\"\n}", new ApiField("name", "string", true, "The display name", []), new ApiField("status", "string · enum Active, Suspended", false, null, []),
            new ApiField("address", "object", true, null, [new ApiField("line1", "string", true, null, []), new ApiField("postcode", "string", false, null, [])]))]);
        var operations = new List<ApiOperationInfo>
        {
            new("list", "List", "GET", $"/{path}", "Lists what the service holds.", [new("page", "query", "integer", false), new("context-tenantid", "header", "string", true)], new ApiBodyInfo(null, []),
                [Reply(200, "A page of items", item), Reply(401, "Not signed in"), Reply(429, "Too many calls", problem), Reply(500, "Unexpected error", problem)]),
            new("get", "Get", "GET", $"/{path}/{{id}}", "Reads one.", [new("id", "path", "string", true), new("context-tenantid", "header", "string", true)], new ApiBodyInfo(null, []),
                [Reply(200, "The item", item), Reply(404, "No such item"), Reply(500, "Unexpected error", problem)]),
            new("create", "Create", "POST", $"/{path}", "Adds one.", [new("context-tenantid", "header", "string", true)], created,
                [Reply(201, "The item that was created", item), Reply(400, "The request is not valid", problem), Reply(409, "It exists already", problem), Reply(500, "Unexpected error", problem)]),
        };
        // the second gateway has one operation fewer and a different rate limit, so the demo shows what a difference looks like
        if (gateways.IndexOf(gateway.Id) > 0) operations.RemoveAt(2);
        var calls = gateways.IndexOf(gateway.Id) > 0 ? 50 : 100;
        var xml = $"<policies>\n    <inbound>\n        <base />\n        <rate-limit calls=\"{calls}\" renewal-period=\"60\" />\n        <include-fragment fragment-id=\"correlation-id\" />\n    </inbound>\n    <backend>\n        <base />\n    </backend>\n    <outbound>\n        <base />\n    </outbound>\n</policies>";
        return Task.FromResult(new SourceApiDetail(operations, new SourcePolicy(xml, [new ApiFragmentInfo("correlation-id", "<fragment>\n    <set-header name=\"X-Correlation-Id\" exists-action=\"skip\">\n        <value>@(context.RequestId.ToString())</value>\n    </set-header>\n</fragment>")])));
    }

    public Task<SourcePolicy?> OperationPolicyAsync(GatewayRef gateway, string apiId, string operationId, CancellationToken ct) =>
        Task.FromResult<SourcePolicy?>(operationId == "create"
            ? new SourcePolicy("<policies>\n    <inbound>\n        <base />\n        <validate-content unspecified-content-type-action=\"prevent\" />\n    </inbound>\n    <backend><base /></backend>\n    <outbound><base /></outbound>\n</policies>", [])
            : null);
}
