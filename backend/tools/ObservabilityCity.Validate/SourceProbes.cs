using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace ObservabilityCity.Validate;

/// <summary>What a cheap probe of one configured source found.</summary>
public enum ProbeStatus
{
    /// <summary>The source answered and had data.</summary>
    Connected,
    /// <summary>The source answered but the login is not allowed to read it.</summary>
    NoPermission,
    /// <summary>The source answered but the probe query returned nothing.</summary>
    Empty,
    /// <summary>No answer: wrong address, network, or the service is down.</summary>
    Unreachable,
    /// <summary>The environment does not configure this signal. Fine: the town leaves that signal out.</summary>
    NotConfigured,
    /// <summary>The kind is not one this tool knows how to probe.</summary>
    UnknownKind,
    /// <summary>The registry accepts this kind but its probe arrives with its adapter. Not a failure.</summary>
    NoProbeYet,
}

public sealed record ProbeResult(ProbeStatus Status, string Detail = "");

/// <summary>One kind of source: a single cheap read that says whether the town could use it.</summary>
public interface ISourceProbe
{
    string Kind { get; }
    Task<ProbeResult> ProbeAsync(string connection, CancellationToken ct);
}

/// <summary>Gives a bearer token for a scope. The real one uses the Azure login; tests pass a fake.</summary>
public interface ITokenProvider
{
    Task<string> GetTokenAsync(string scope, CancellationToken ct);
}

/// <summary>Azure login, found the way the Azure SDK finds it: az login, environment, managed identity. Nothing is stored.</summary>
public sealed class AzureTokenProvider : ITokenProvider
{
    private readonly Azure.Identity.DefaultAzureCredential _credential = new();

    public async Task<string> GetTokenAsync(string scope, CancellationToken ct) =>
        (await _credential.GetTokenAsync(new Azure.Core.TokenRequestContext([scope]), ct)).Token;
}

/// <summary>Shared by the HTTP probes: sends one request and maps what comes back.</summary>
internal abstract class HttpProbe(HttpClient http, ITokenProvider tokens) : ISourceProbe
{
    public abstract string Kind { get; }
    protected abstract string Scope { get; }
    protected abstract HttpRequestMessage Request(string connection);
    /// <summary>True when a successful body holds data.</summary>
    protected abstract bool HasData(JsonElement body);

    public async Task<ProbeResult> ProbeAsync(string connection, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(connection)) return new ProbeResult(ProbeStatus.NotConfigured, "no connection given");
        try
        {
            using var request = Request(connection.Trim());
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await tokens.GetTokenAsync(Scope, ct));
            using var response = await http.SendAsync(request, ct);
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                return new ProbeResult(ProbeStatus.NoPermission, $"HTTP {(int)response.StatusCode}: this login may not read it");
            if (!response.IsSuccessStatusCode)
                return new ProbeResult(ProbeStatus.Unreachable, $"HTTP {(int)response.StatusCode} {response.ReasonPhrase}");
            var text = await response.Content.ReadAsStringAsync(ct);
            JsonElement body;
            try { body = JsonDocument.Parse(text).RootElement.Clone(); }
            catch (JsonException) { return new ProbeResult(ProbeStatus.Unreachable, "answered, but not with the expected data (is the address right?)"); }
            return HasData(body) ? new ProbeResult(ProbeStatus.Connected) : new ProbeResult(ProbeStatus.Empty, "the probe query returned nothing");
        }
        catch (HttpRequestException e) { return new ProbeResult(ProbeStatus.Unreachable, e.Message); }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { return new ProbeResult(ProbeStatus.Unreachable, "timed out"); }
        catch (Exception e) when (e is Azure.Identity.CredentialUnavailableException or Azure.Identity.AuthenticationFailedException or Azure.RequestFailedException)
        {
            return new ProbeResult(ProbeStatus.NoPermission, $"no Azure login ({e.Message.Split('\n')[0]}). Run az login");
        }
    }
}

/// <summary>Prometheus HTTP API (for example Azure Monitor managed Prometheus). Connection: the query endpoint URL. Reads `up`.</summary>
internal sealed class PrometheusProbe(HttpClient http, ITokenProvider tokens) : HttpProbe(http, tokens)
{
    public override string Kind => "prometheus";
    protected override string Scope => "https://prometheus.monitor.azure.com/.default";
    protected override HttpRequestMessage Request(string connection) =>
        new(HttpMethod.Get, $"{connection.TrimEnd('/')}/api/v1/query?query=up");
    protected override bool HasData(JsonElement body) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty("data", out var data) && data.TryGetProperty("result", out var r) && r.ValueKind == JsonValueKind.Array && r.GetArrayLength() > 0;
}

/// <summary>Azure Log Analytics. Connection: the workspace id. Reads one recent row of anything.</summary>
internal sealed class LogAnalyticsProbe(HttpClient http, ITokenProvider tokens) : HttpProbe(http, tokens)
{
    public override string Kind => "loganalytics";
    protected override string Scope => "https://api.loganalytics.io/.default";
    protected override HttpRequestMessage Request(string connection) =>
        new(HttpMethod.Post, $"https://api.loganalytics.io/v1/workspaces/{Uri.EscapeDataString(connection)}/query")
        {
            Content = new StringContent("""{"query":"union withsource=T * | take 1","timespan":"PT1H"}""", Encoding.UTF8, "application/json"),
        };
    protected override bool HasData(JsonElement body) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty("tables", out var tables) && tables.ValueKind == JsonValueKind.Array
        && tables.EnumerateArray().Any(t => t.TryGetProperty("rows", out var rows) && rows.ValueKind == JsonValueKind.Array && rows.GetArrayLength() > 0);
}

/// <summary>Azure Service Bus. Connection: the namespace host name. Lists topics through the namespace's management feed (needs the Manage right).</summary>
internal sealed class ServiceBusProbe(HttpClient http, ITokenProvider tokens) : ISourceProbe
{
    public string Kind => "servicebus";

    public async Task<ProbeResult> ProbeAsync(string connection, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(connection)) return new ProbeResult(ProbeStatus.NotConfigured, "no connection given");
        var host = connection.Trim().Replace("https://", "", StringComparison.OrdinalIgnoreCase).TrimEnd('/');
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"https://{host}/$Resources/Topics?api-version=2017-04&$top=1");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await tokens.GetTokenAsync("https://servicebus.azure.net/.default", ct));
            using var response = await http.SendAsync(request, ct);
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                return new ProbeResult(ProbeStatus.NoPermission, $"HTTP {(int)response.StatusCode}: this login may not list topics (needs Manage on the namespace)");
            if (!response.IsSuccessStatusCode)
                return new ProbeResult(ProbeStatus.Unreachable, $"HTTP {(int)response.StatusCode} {response.ReasonPhrase}");
            var text = await response.Content.ReadAsStringAsync(ct);
            return text.Contains("<entry", StringComparison.Ordinal)
                ? new ProbeResult(ProbeStatus.Connected)
                : new ProbeResult(ProbeStatus.Empty, "the namespace has no topics");
        }
        catch (HttpRequestException e) { return new ProbeResult(ProbeStatus.Unreachable, e.Message); }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { return new ProbeResult(ProbeStatus.Unreachable, "timed out"); }
        catch (Exception e) when (e is Azure.Identity.CredentialUnavailableException or Azure.Identity.AuthenticationFailedException or Azure.RequestFailedException)
        {
            return new ProbeResult(ProbeStatus.NoPermission, $"no Azure login ({e.Message.Split('\n')[0]}). Run az login");
        }
    }
}

/// <summary>
/// Grafana (for incidents, Grafana IRM). Connection: the Grafana URL. Uses a service account token from the GRAFANA_TOKEN
/// environment variable, since Grafana does not take the Azure login; reads one dashboard-search row.
/// </summary>
internal sealed class GrafanaIrmProbe(HttpClient http, Func<string?> tokenFromEnvironment) : ISourceProbe
{
    public const string TokenVariable = "GRAFANA_TOKEN";
    public string Kind => "grafana-irm";

    public async Task<ProbeResult> ProbeAsync(string connection, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(connection)) return new ProbeResult(ProbeStatus.NotConfigured, "no connection given");
        var token = tokenFromEnvironment();
        if (string.IsNullOrWhiteSpace(token)) return new ProbeResult(ProbeStatus.NoPermission, $"no token: set {TokenVariable} to a Grafana service account token");
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{connection.Trim().TrimEnd('/')}/api/search?limit=1");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var response = await http.SendAsync(request, ct);
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                return new ProbeResult(ProbeStatus.NoPermission, $"HTTP {(int)response.StatusCode}: the token is not accepted");
            if (!response.IsSuccessStatusCode)
                return new ProbeResult(ProbeStatus.Unreachable, $"HTTP {(int)response.StatusCode} {response.ReasonPhrase}");
            try
            {
                var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct)).RootElement;
                return body.ValueKind == JsonValueKind.Array && body.GetArrayLength() > 0
                    ? new ProbeResult(ProbeStatus.Connected)
                    : new ProbeResult(ProbeStatus.Empty, "the token sees nothing in Grafana");
            }
            catch (JsonException) { return new ProbeResult(ProbeStatus.Unreachable, "answered, but not with the expected data (is the address right?)"); }
        }
        catch (HttpRequestException e) { return new ProbeResult(ProbeStatus.Unreachable, e.Message); }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { return new ProbeResult(ProbeStatus.Unreachable, "timed out"); }
    }
}

/// <summary>The fake source needs nothing, so it is always connected.</summary>
internal sealed class FakeProbe : ISourceProbe
{
    public string Kind => "fake";
    public Task<ProbeResult> ProbeAsync(string connection, CancellationToken ct) => Task.FromResult(new ProbeResult(ProbeStatus.Connected, "fake data"));
}

public static class SourceProbes
{
    /// <summary>The probes the tool uses against real systems.</summary>
    public static IReadOnlyList<ISourceProbe> Default(HttpClient http, ITokenProvider tokens) =>
    [
        new FakeProbe(),
        new PrometheusProbe(http, tokens),
        new LogAnalyticsProbe(http, tokens),
        new ServiceBusProbe(http, tokens),
        new GrafanaIrmProbe(http, () => Environment.GetEnvironmentVariable(GrafanaIrmProbe.TokenVariable)),
    ];

    /// <summary>The same probes with a given token provider and Grafana token, for tests with canned responses.</summary>
    public static IReadOnlyList<ISourceProbe> For(HttpClient http, ITokenProvider tokens, string? grafanaToken) =>
    [
        new FakeProbe(),
        new PrometheusProbe(http, tokens),
        new LogAnalyticsProbe(http, tokens),
        new ServiceBusProbe(http, tokens),
        new GrafanaIrmProbe(http, () => grafanaToken),
    ];
}
