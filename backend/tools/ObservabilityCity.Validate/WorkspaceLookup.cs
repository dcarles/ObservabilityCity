using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Validate;

/// <summary>What looking a Log Analytics workspace up by name found.</summary>
public sealed record WorkspaceAnswer(string? Id, string Detail);

/// <summary>Finds the id of a workspace given by name or wildcard pattern, the way the running town does through Resource Graph.</summary>
public interface IWorkspaceLookup
{
    Task<WorkspaceAnswer> FindAsync(string pattern, CancellationToken ct);
}

public sealed class ResourceGraphWorkspaceLookup(HttpClient http, ITokenProvider tokens) : IWorkspaceLookup
{
    private const string Endpoint = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01";
    private const string Query = "resources | where type =~ 'microsoft.operationalinsights/workspaces' | project id, name, customerId = tostring(properties.customerId)";

    public async Task<WorkspaceAnswer> FindAsync(string pattern, CancellationToken ct)
    {
        try
        {
            var body = JsonSerializer.Serialize(new { query = Query, options = new { resultFormat = "objectArray" } });
            using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await tokens.GetTokenAsync("https://management.azure.com/.default", ct));
            using var response = await http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode) return new WorkspaceAnswer(null, $"looking the workspace up answered HTTP {(int)response.StatusCode} {response.ReasonPhrase}");
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var found = doc.RootElement.GetProperty("data").EnumerateArray()
                .Select(e => (Name: Text(e, "name") ?? "", Id: Text(e, "customerId") is { Length: > 0 } c ? c : Text(e, "id")))
                .Where(w => ScopeTemplate.Like(w.Name, pattern)).ToList();
            return found.Count switch
            {
                1 => new WorkspaceAnswer(found[0].Id, $"workspace '{found[0].Name}' found by its name"),
                0 => new WorkspaceAnswer(null, $"no workspace is named '{pattern}'"),
                _ => new WorkspaceAnswer(null, $"{found.Count} workspaces match '{pattern}' ({string.Join(", ", found.Select(w => w.Name).Order(StringComparer.Ordinal))}); make scope.workspace narrower or give scope.workspaceId"),
            };
        }
        catch (Exception e) when (e is HttpRequestException or JsonException or KeyNotFoundException or Azure.Identity.CredentialUnavailableException or Azure.Identity.AuthenticationFailedException)
        {
            return new WorkspaceAnswer(null, $"looking the workspace up failed ({e.Message.Split('\n')[0]})");
        }
    }

    private static string? Text(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
