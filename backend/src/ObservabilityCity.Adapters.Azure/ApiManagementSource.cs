using System.Text.Json;
using System.Text.RegularExpressions;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Apis;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>
/// What an API Management service's management answers look like and how they are read into the core's neutral shapes: the list of APIs, the operations of one, and a policy (raw XML, with the
/// byte-order mark the service puts in front of it). Pure, so tests feed it recorded answers. The program knows no API: the environment's <c>apis</c> block names the gateway.
/// </summary>
public static partial class ApiManagementReading
{
    public const string ApiVersion = "2022-08-01";

    public static string ListUrl(string gatewayId) => $"{AzureMonitorReader.Endpoint}{gatewayId.TrimEnd('/')}/apis?api-version={ApiVersion}&$top=100";
    public static string OperationsUrl(string gatewayId, string api) => $"{AzureMonitorReader.Endpoint}{gatewayId.TrimEnd('/')}/apis/{Uri.EscapeDataString(api)}/operations?api-version={ApiVersion}&$top=100";
    public static string ApiPolicyUrl(string gatewayId, string api) => $"{AzureMonitorReader.Endpoint}{gatewayId.TrimEnd('/')}/apis/{Uri.EscapeDataString(api)}/policies/policy?api-version={ApiVersion}&format=rawxml";
    public static string OperationPolicyUrl(string gatewayId, string api, string operation) =>
        $"{AzureMonitorReader.Endpoint}{gatewayId.TrimEnd('/')}/apis/{Uri.EscapeDataString(api)}/operations/{Uri.EscapeDataString(operation)}/policies/policy?api-version={ApiVersion}&format=rawxml";
    public static string FragmentUrl(string gatewayId, string fragment) => $"{AzureMonitorReader.Endpoint}{gatewayId.TrimEnd('/')}/policyFragments/{Uri.EscapeDataString(fragment)}?api-version={ApiVersion}&format=rawxml";

    /// <summary>The APIs of one answer page and the address of the next page, when there is one. A revision that is not the current one is left out.</summary>
    public static (IReadOnlyList<SourceApi> Apis, string? Next) ParseApis(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var apis = new List<SourceApi>();
        if (doc.RootElement.TryGetProperty("value", out var value) && value.ValueKind == JsonValueKind.Array)
            foreach (var item in value.EnumerateArray())
            {
                var name = Text(item, "name");
                if (name is null || !item.TryGetProperty("properties", out var p)) continue;
                if (p.TryGetProperty("isCurrent", out var current) && current.ValueKind == JsonValueKind.False) continue;
                apis.Add(new SourceApi(name, name, Text(p, "displayName") ?? name, Text(p, "path"), Text(p, "serviceUrl")));
            }
        return (apis, Text(doc.RootElement, "nextLink"));
    }

    /// <summary>The operations of one answer page and the next page's address.</summary>
    public static (IReadOnlyList<ApiOperationInfo> Operations, string? Next) ParseOperations(string json, IReadOnlyDictionary<string, JsonDocument>? schemas = null)
    {
        schemas ??= new Dictionary<string, JsonDocument>();
        using var doc = JsonDocument.Parse(json);
        var operations = new List<ApiOperationInfo>();
        if (doc.RootElement.TryGetProperty("value", out var value) && value.ValueKind == JsonValueKind.Array)
            foreach (var item in value.EnumerateArray())
            {
                var id = Text(item, "name");
                if (id is null || !item.TryGetProperty("properties", out var p)) continue;
                var parameters = new List<ApiParameterInfo>();
                Parameters(p, "templateParameters", "path", parameters, forceRequired: true);
                if (p.TryGetProperty("request", out var request) && request.ValueKind == JsonValueKind.Object)
                {
                    Parameters(request, "queryParameters", "query", parameters);
                    Parameters(request, "headers", "header", parameters);
                }
                var body = new ApiBodyInfo(null, []);
                var responses = new List<ApiResponseInfo>();
                if (p.TryGetProperty("request", out var rq) && rq.ValueKind == JsonValueKind.Object)
                    body = new ApiBodyInfo(Text(rq, "description"), ApiManagementSchemas.Representations(rq, schemas));
                if (p.TryGetProperty("responses", out var rs) && rs.ValueKind == JsonValueKind.Array)
                    foreach (var r in rs.EnumerateArray())
                        if (r.TryGetProperty("statusCode", out var code) && code.TryGetInt32(out var c) && responses.All(x => x.StatusCode != c))
                            responses.Add(new ApiResponseInfo(c, Text(r, "description"), ApiManagementSchemas.Representations(r, schemas)));
                operations.Add(new ApiOperationInfo(id, Text(p, "displayName") ?? id, (Text(p, "method") ?? "").ToUpperInvariant(), Text(p, "urlTemplate") ?? "", Text(p, "description"),
                    parameters, body, responses.OrderBy(x => x.StatusCode).ToList()));
            }
        return (operations, Text(doc.RootElement, "nextLink"));
    }

    private static void Parameters(JsonElement from, string property, string kind, List<ApiParameterInfo> into, bool forceRequired = false)
    {
        if (!from.TryGetProperty(property, out var list) || list.ValueKind != JsonValueKind.Array) return;
        foreach (var p in list.EnumerateArray())
            if (Text(p, "name") is { } name)
                into.Add(new ApiParameterInfo(name, kind, Text(p, "type"), forceRequired || (p.TryGetProperty("required", out var r) && r.ValueKind == JsonValueKind.True)));
    }

    /// <summary>
    /// The policy text of an answer: the raw XML (the service answers with it as it is, after a byte-order mark that a console cannot print), or, when it came wrapped in JSON, the
    /// <c>properties.value</c> of it. Empty text is no policy.
    /// </summary>
    public static string? ParsePolicy(string text)
    {
        var xml = text.TrimStart('\uFEFF').Trim();
        if (xml.Length == 0) return null;
        if (xml[0] == '{')
        {
            using var doc = JsonDocument.Parse(xml);
            xml = doc.RootElement.TryGetProperty("properties", out var p) ? Text(p, "value")?.TrimStart('\uFEFF').Trim() ?? "" : "";
        }
        return xml.Length == 0 ? null : xml;
    }

    [GeneratedRegex("<include-fragment\\b[^>]*?\\bfragment-id\\s*=\\s*\"(?<id>[^\"]+)\"", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FragmentReference();

    /// <summary>The ids of the fragments a policy includes. An id written as a named-value reference is left out: it names nothing to read.</summary>
    public static IReadOnlyList<string> Fragments(string xml) =>
        FragmentReference().Matches(xml).Select(m => m.Groups["id"].Value).Where(id => !id.Contains('{')).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

    private static string? Text(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}

/// <summary>
/// Reads the APIs an API Management service serves, for the API explorer: through the management API, with the environment's login (<c>az login</c> by default), on demand and never polled.
/// The source fills no signal and reports no readings. A policy that is not set (the service answers 404) is no policy, not an error; the fragments a policy includes are read too, and a fragment
/// that cannot be read is listed without text.
/// </summary>
public sealed class ApiManagementSource(string name, AzureMonitorReader reader) : IMetricSource, IApiCatalogueSource
{
    public const string Service = "the API Management service";

    private static readonly IReadOnlyDictionary<string, NodeReading> None = new Dictionary<string, NodeReading>();

    public string Name => name;

    /// <summary>Nothing is polled; the poller asks rarely, so a source that reads nothing costs nothing.</summary>
    public TimeSpan PollInterval => TimeSpan.FromHours(1);

    public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct) => Task.FromResult(None);

    public async Task<IReadOnlyList<SourceApi>> ListAsync(GatewayRef gateway, CancellationToken ct)
    {
        var all = new List<SourceApi>();
        for (var url = ApiManagementReading.ListUrl(gateway.Id); url is not null;)
        {
            var (apis, next) = ApiManagementReading.ParseApis(await reader.GetAsync(gateway.Id, url, ct, Service));
            all.AddRange(apis);
            url = next;
        }
        return all;
    }

    private const int MaxSchemas = 12;

    private static string Why(HttpRequestException e) => e.StatusCode is { } code ? $"HTTP {(int)code}" : e.Message;

    public async Task<SourceApiDetail> DetailAsync(GatewayRef gateway, string apiId, CancellationToken ct)
    {
        var operations = new List<ApiOperationInfo>();
        var schemas = new Dictionary<string, JsonDocument>(StringComparer.OrdinalIgnoreCase);
        var notes = new List<string>();
        // the shared type definitions fill in the bodies; an API without them, or a gateway that will not say, still shows its operations (with a note saying what could not be read)
        try
        {
            var list = ApiManagementSchemas.ParseSchemaList(await reader.GetAsync(gateway.Id, ApiManagementSchemas.SchemasUrl(gateway.Id, apiId), ct, Service));
            foreach (var (id, inline) in list.Take(MaxSchemas))
            {
                if (inline is not null) { schemas[id] = inline; continue; }
                try { if (ApiManagementSchemas.ParseSchema(await reader.GetAsync(gateway.Id, ApiManagementSchemas.SchemaUrl(gateway.Id, apiId, id), ct, Service)) is { } one) schemas[id] = one; }
                catch (HttpRequestException e) { notes.Add($"The definitions of schema {id} could not be read ({Why(e)}), so bodies that use it show no fields."); }
            }
            if (list.Count > MaxSchemas) notes.Add($"Only the first {MaxSchemas} of the API's {list.Count} schemas were read.");
        }
        catch (HttpRequestException e) { notes.Add($"The schemas of this API could not be read ({Why(e)}), so bodies show no fields."); }
        for (var url = ApiManagementReading.OperationsUrl(gateway.Id, apiId); url is not null;)
        {
            var (page, next) = ApiManagementReading.ParseOperations(await reader.GetAsync(gateway.Id, url, ct, Service), schemas);
            operations.AddRange(page);
            url = next;
        }
        return new SourceApiDetail(operations, await PolicyAsync(gateway, ApiManagementReading.ApiPolicyUrl(gateway.Id, apiId), ct), notes);
    }

    public Task<SourcePolicy?> OperationPolicyAsync(GatewayRef gateway, string apiId, string operationId, CancellationToken ct) =>
        PolicyAsync(gateway, ApiManagementReading.OperationPolicyUrl(gateway.Id, apiId, operationId), ct);

    private async Task<SourcePolicy?> PolicyAsync(GatewayRef gateway, string url, CancellationToken ct)
    {
        string text;
        try { text = await reader.GetAsync(gateway.Id, url, ct, Service); }
        catch (HttpRequestException e) when (e.StatusCode == System.Net.HttpStatusCode.NotFound) { return null; } // no policy is set directly here
        if (ApiManagementReading.ParsePolicy(text) is not { } xml) return null;
        var fragments = new List<ApiFragmentInfo>();
        foreach (var id in ApiManagementReading.Fragments(xml))
        {
            string? body = null;
            try { body = ApiManagementReading.ParsePolicy(await reader.GetAsync(gateway.Id, ApiManagementReading.FragmentUrl(gateway.Id, id), ct, Service)); }
            catch (HttpRequestException) { } // a fragment that cannot be read is listed without its text
            fragments.Add(new ApiFragmentInfo(id, body));
        }
        return new SourcePolicy(xml, fragments);
    }
}

public sealed class ApiManagementSourceFactory(HttpClient? http = null) : IMetricSourceFactory
{
    public const string SourceKind = "apimanagement";

    public string Kind => SourceKind;

    public IMetricSource Create(SourceContext context) => new ApiManagementSource(context.Source.Name, new AzureMonitorReader(http ?? Shared, context.Credential));

    private static readonly HttpClient Shared = new();
}
