using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>
/// Reads the inventory (subscriptions and the resources the scope rules name) from Azure Resource Graph. It asks twice: first for the subscriptions,
/// so the rules can say which belong to which pillar, then for the resources of just those. Both queries are templates in the environment file
/// (<c>scope.queries</c>); the ones here are only the generic defaults. Every page is read: nothing is cut off at a row count.
/// </summary>
public sealed class ResourceGraphInventory(HttpClient http, ICredentialSource? credential, RegistrySource source, ScopeRules rules)
{
    public const string TokenScope = "https://management.azure.com/.default";
    public const string Endpoint = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01";
    public const int PageSize = 1000;
    public const int MaxSubscriptionsPerCall = 1000;

    public const string DefaultSubscriptionsQuery =
        "resourcecontainers | where type =~ 'microsoft.resources/subscriptions' | project id = subscriptionId, name, tags";

    public const string DefaultResourcesQuery =
        "resources | where type in~ ({types}) | project id, name, type, subscriptionId, location, tags";

    /// <summary>The scope the source is limited to: subscription ids, comma separated; empty means everything the login can read.</summary>
    private IReadOnlyList<string> Scope =>
        (source.Connection ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

    public async Task<Inventory> ReadAsync(TownRegistry registry, CancellationToken ct)
    {
        var subscriptions = (await Query(rules.Queries.Subscriptions ?? DefaultSubscriptionsQuery, Scope, ct)).Select(ToSubscription).ToList();
        var found = ScopeResolver.Resolve(registry, new Inventory(subscriptions, []));
        var wanted = found.Pillars.Select(p => p.SubscriptionId).OfType<string>().Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var types = rules.Resources.SelectMany(r => r.Types).Select(t => t.ToLowerInvariant()).Distinct().ToList();
        var resources = new List<InventoryResource>();
        if (wanted.Count > 0 && types.Count > 0)
        {
            var query = (rules.Queries.Resources ?? DefaultResourcesQuery).Replace("{types}", string.Join(", ", types.Select(t => "'" + t.Replace("'", "''") + "'")));
            foreach (var batch in wanted.Chunk(MaxSubscriptionsPerCall))
                resources.AddRange((await Query(query, batch, ct)).Select(ToResource));
        }
        return new Inventory(subscriptions, resources);
    }

    private async Task<List<JsonElement>> Query(string query, IReadOnlyList<string> subscriptions, CancellationToken ct)
    {
        var rows = new List<JsonElement>();
        string? skipToken = null;
        do
        {
            var body = new Dictionary<string, object?>
            {
                ["query"] = query,
                ["options"] = new Dictionary<string, object?> { ["$top"] = PageSize, ["resultFormat"] = "objectArray", ["$skipToken"] = skipToken },
            };
            if (subscriptions.Count > 0) body["subscriptions"] = subscriptions;
            using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };
            if (credential is not null)
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await credential.GetTokenAsync(TokenScope, ct));
            using var response = await http.SendAsync(request, ct);
            var text = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode)
                throw new HttpRequestException($"Resource Graph answered {(int)response.StatusCode} {response.ReasonPhrase}: {Trim(text)}");
            using var doc = JsonDocument.Parse(text);
            rows.AddRange(doc.RootElement.GetProperty("data").EnumerateArray().Select(e => e.Clone()));
            skipToken = doc.RootElement.TryGetProperty("$skipToken", out var next) && next.ValueKind == JsonValueKind.String ? next.GetString() : null;
        }
        while (skipToken is not null);
        return rows;
    }

    private static string Trim(string text) => text.Length <= 300 ? text : text[..300] + "...";

    private static InventorySubscription ToSubscription(JsonElement e) => new(Text(e, "id") ?? "", Text(e, "name") ?? "", Tags(e));

    private static InventoryResource ToResource(JsonElement e) =>
        new(Text(e, "id") ?? "", Text(e, "name") ?? "", Text(e, "type") ?? "", Text(e, "subscriptionId") ?? "", Text(e, "location"), Tags(e));

    private static string? Text(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static Dictionary<string, string> Tags(JsonElement e)
    {
        var tags = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (e.TryGetProperty("tags", out var t) && t.ValueKind == JsonValueKind.Object)
            foreach (var p in t.EnumerateObject())
                if (p.Value.ValueKind == JsonValueKind.String) tags[p.Name] = p.Value.GetString()!;
        return tags;
    }

    /// <summary>Reads a recorded response instead of asking Azure, for trying rules offline and for tests: the rows of one or both queries as <c>{ "subscriptions": [...], "resources": [...] }</c>.</summary>
    public static Inventory FromRecording(string json)
    {
        using var doc = JsonDocument.Parse(json);
        IEnumerable<JsonElement> Rows(string name) => doc.RootElement.TryGetProperty(name, out var a) ? a.EnumerateArray().Select(x => x.Clone()).ToList() : [];
        return new Inventory(Rows("subscriptions").Select(ToSubscription).ToList(), Rows("resources").Select(ToResource).ToList());
    }
}

/// <summary>
/// The inventory source. It fills no readings: what it reads goes to the environment's <see cref="ScopeStore"/>, where the rules turn it into scopes
/// and the other adapters look their systems up. Its connection is the subscription ids it may read, comma separated (none: everything the login can
/// read), or <c>file:name.json</c> to replay a recording kept beside the town's files.
/// </summary>
public sealed class ResourceGraphSource(string name, string environmentId, RegistrySource definition, ResourceGraphInventory reader, ScopeStore store, string? recording, TimeProvider time) : IMetricSource
{
    public string Name => name;
    public TimeSpan PollInterval => definition.PollInterval;
    public TimeSpan Timeout => definition.Timeout;

    public async Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct)
    {
        try
        {
            var inventory = recording is not null ? ResourceGraphInventory.FromRecording(await File.ReadAllTextAsync(recording, ct)) : await reader.ReadAsync(registry.ForEnvironment(environmentId), ct);
            store.Update(inventory, time.GetUtcNow());
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            store.Fail(e.Message);
            throw;
        }
        return new Dictionary<string, NodeReading>();
    }
}

public sealed class ResourceGraphSourceFactory(HttpClient? http = null, TimeProvider? time = null) : IMetricSourceFactory
{
    public const string RecordingPrefix = "file:";

    public string Kind => "resourcegraph";

    public IMetricSource Create(SourceContext context)
    {
        var connection = context.Source.Connection ?? "";
        string? recording = null;
        if (connection.StartsWith(RecordingPrefix, StringComparison.OrdinalIgnoreCase))
        {
            var file = connection[RecordingPrefix.Length..].Trim();
            recording = Path.IsPathRooted(file) || context.RegistryFolder is null ? file : Path.Combine(context.RegistryFolder, file);
            if (!File.Exists(recording)) throw new InvalidOperationException($"the recording {file} does not exist");
        }
        return new ResourceGraphSource(context.Source.Name, context.EnvironmentId, context.Source,
            new ResourceGraphInventory(http ?? Shared, context.Credential, context.Source, context.Rules ?? ScopeRules.None),
            context.Scope ?? new ScopeStore(), recording, time ?? TimeProvider.System);
    }

    private static readonly HttpClient Shared = new();
}
