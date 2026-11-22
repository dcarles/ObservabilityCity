using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>
/// Reads the inventory (subscriptions and the resources the scope rules name) from Azure Resource Graph. It asks twice: first for the subscriptions,
/// so the rules can say which belong to which pillar, then for the resources of just those. Both queries are templates in the environment file
/// (<c>scope.queries</c>: <c>accounts</c>, <c>resources</c> and <c>telemetryStores</c>, which the Azure names <c>subscriptions</c> and <c>workspaces</c> also set); the ones here are only the generic defaults. Every page is read: nothing is cut off at a row count.
/// </summary>
/// <summary>One change to a resource's properties: which resource (its id in lower case), when, and what each changed property was before (null when it had none).</summary>
public sealed record ResourceChange(string ResourceId, DateTimeOffset At, IReadOnlyDictionary<string, string?> Previous);

public sealed class ResourceGraphInventory(HttpClient http, ICredentialSource? credential, RegistrySource source, ScopeRules rules)
{
    public const string TokenScope = "https://management.azure.com/.default";
    public const string Endpoint = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01";
    public const int PageSize = 1000;
    public const int MaxSubscriptionsPerCall = 1000;

    public const string DefaultSubscriptionsQuery =
        "resourcecontainers | where type =~ 'microsoft.resources/subscriptions' | project id = subscriptionId, name, tags";

    public const string DefaultWorkspacesQuery =
        "resources | where type =~ 'microsoft.operationalinsights/workspaces' | project id, name, customerId = tostring(properties.customerId)";

    public const string DefaultResourcesQuery =
        "resources | where type in~ ({types}) | extend instances = {instances}, state = {state} | project id, name, type, subscriptionId, location, tags, instances, state";

    /// <summary>The scope the source is limited to: subscription ids, comma separated; empty means everything the login can read.</summary>
    private IReadOnlyList<string> Scope =>
        (source.Connection ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

    public async Task<Inventory> ReadAsync(TownRegistry registry, CancellationToken ct)
    {
        var subscriptions = (await Query(rules.Queries.Accounts ?? DefaultSubscriptionsQuery, Scope, ct)).Select(ToSubscription).ToList();
        var found = ScopeResolver.Resolve(registry, new Inventory(subscriptions, []));
        var wanted = found.Pillars.Select(p => p.AccountId).OfType<string>().Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        wanted.AddRange(ScopeResolver.HubAssetAccounts(registry, found.Pillars, subscriptions).Where(id => !wanted.Contains(id, StringComparer.OrdinalIgnoreCase)));
        var types = rules.Resources.SelectMany(r => r.Types).Concat(rules.Assets.SelectMany(a => a.Types)).Select(t => t.ToLowerInvariant()).Distinct().ToList();
        var resources = new List<InventoryResource>();
        if (wanted.Count > 0 && types.Count > 0)
        {
            var query = (rules.Queries.Resources ?? DefaultResourcesQuery)
                .Replace("{types}", string.Join(", ", types.Select(Quote)))
                .Replace("{instances}", InstancesExpression(rules))
                .Replace("{state}", StateExpression(rules));
            foreach (var batch in wanted.Chunk(MaxSubscriptionsPerCall))
                resources.AddRange((await Query(query, batch, ct)).Select(ToResource));
        }
        return new Inventory(subscriptions, resources, NeedsWorkspaceLookup(rules) ? (await Query(rules.Queries.TelemetryStores ?? DefaultWorkspacesQuery, Scope, ct)).Select(ToWorkspace).ToList() : null);
    }

    /// <summary>
    /// The workspace (the scope's telemetry store) is looked up by name only when it is given as a name and no explicit id is: an id is used as it is, so
    /// nothing is asked.
    /// </summary>
    public static bool NeedsWorkspaceLookup(ScopeRules rules) =>
        string.IsNullOrWhiteSpace(rules.TelemetryStoreId) && !string.IsNullOrWhiteSpace(rules.TelemetryStore) && !ScopeResolver.IsTelemetryStoreId(rules.TelemetryStore.Trim());

    private static string Quote(string text) => "'" + text.Replace("'", "''") + "'";

    /// <summary>
    /// The expression that counts a resource's instances: each type takes the expression of the first rule that names it (the rules are the company's, so
    /// a plan and an app can count differently), and a type no rule counts gives null, which is "unknown" and never 0.
    /// </summary>
    public static string InstancesExpression(ScopeRules rules)
    {
        var counted = rules.Resources.Where(r => r.Instances is not null)
            .SelectMany(r => r.Types.Select(t => (Type: t.ToLowerInvariant(), r.Instances)))
            .GroupBy(x => x.Type).Select(g => g.First()).ToList();
        return counted.Count == 0 ? "int(null)"
            : $"case({string.Join(", ", counted.Select(c => $"type =~ {Quote(c.Type)}, toint({c.Instances})"))}, int(null))";
    }

    /// <summary>The expression that reads a resource's app state as text: each type takes the expression of the first rule that names it; a type no rule reads gives the empty text, which is "unknown".</summary>
    public static string StateExpression(ScopeRules rules)
    {
        var read = rules.Resources.Where(r => r.State is not null)
            .SelectMany(r => r.Types.Select(t => (Type: t.ToLowerInvariant(), r.State)))
            .GroupBy(x => x.Type).Select(g => g.First()).ToList();
        return read.Count == 0 ? "''"
            : $"case({string.Join(", ", read.Select(c => $"type =~ {Quote(c.Type)}, tostring({c.State})"))}, '')";
    }

    /// <summary>The property paths each counted resource type's instance expression reads, by type in lower case (see <see cref="PathsOf"/>).</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<string>> CountedPaths() =>
        rules.Resources.Where(r => r.Instances is not null).SelectMany(r => r.Types.Select(t => (Type: t.ToLowerInvariant(), r.Instances)))
            .GroupBy(x => x.Type).ToDictionary(g => g.Key, g => PathsOf(g.First().Instances!));

    /// <summary>How far back the cloud keeps the change history of resources (Resource Graph "resourcechanges").</summary>
    public static readonly TimeSpan ChangeHistory = TimeSpan.FromDays(14);

    /// <summary>
    /// The call that lists the changes to the properties of resources of some types since <paramref name="from"/>, oldest first: which resource, when, and for each property that changed its
    /// value before the change. The property paths are as the resource says them (<c>properties.numberOfWorkers</c>, <c>sku.capacity</c>).
    /// </summary>
    public static string ChangesQuery(IEnumerable<string> types, DateTimeOffset from) =>
        "resourcechanges | extend changedAt = todatetime(properties.changeAttributes.timestamp), target = tolower(tostring(properties.targetResourceId)), targetType = tolower(tostring(properties.targetResourceType))"
        + $" | where changedAt > datetime({from.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", System.Globalization.CultureInfo.InvariantCulture)}) and targetType in ({string.Join(", ", types.Select(t => Quote(t.ToLowerInvariant())))})"
        + " | project target, changedAt, changes = properties.changes | order by changedAt asc";

    /// <summary>The property changes since <paramref name="from"/> of the resources of the types that are counted, as rows of the history (see <see cref="ChangesQuery"/>).</summary>
    public async Task<IReadOnlyList<ResourceChange>> ReadChangesAsync(IReadOnlyList<string> subscriptions, IEnumerable<string> types, DateTimeOffset from, CancellationToken ct)
    {
        var typeList = types.ToList();
        var changes = new List<ResourceChange>();
        if (typeList.Count == 0 || subscriptions.Count == 0) return changes;
        foreach (var batch in subscriptions.Chunk(MaxSubscriptionsPerCall))
            foreach (var row in await Query(ChangesQuery(typeList, from), batch, ct))
                if (Text(row, "target") is { Length: > 0 } target && Text(row, "changedAt") is { } stamp && DateTimeOffset.TryParse(stamp, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var at))
                    changes.Add(new ResourceChange(target, at, PreviousValues(row)));
        return changes;
    }

    private static IReadOnlyDictionary<string, string?> PreviousValues(JsonElement row)
    {
        var previous = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        if (row.TryGetProperty("changes", out var changes) && changes.ValueKind == JsonValueKind.Object)
            foreach (var property in changes.EnumerateObject())
                if (property.Value.ValueKind == JsonValueKind.Object && property.Value.TryGetProperty("previousValue", out var value))
                    previous[property.Name] = value.ValueKind switch { JsonValueKind.Null => null, JsonValueKind.String => value.GetString(), _ => value.GetRawText() };
        return previous;
    }

    /// <summary>
    /// The properties an instance-count expression reads, as paths (<c>properties.numberOfWorkers</c>, <c>sku.capacity</c>), in the order they appear: the words with a dot in them that start with a letter.
    /// </summary>
    public static IReadOnlyList<string> PathsOf(string expression) =>
        System.Text.RegularExpressions.Regex.Matches(expression, @"(?<![\w.])[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+").Select(m => m.Value).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

    /// <summary>
    /// The instance count a resource had at a past time. The count it has now (<paramref name="current"/>) stands if none of the properties the expression reads changed since; otherwise the first
    /// such change after that time says it: the value the property had before it. Null when that value is not a whole number (the history does not say).
    /// </summary>
    public static int? InstancesAt(int? current, IReadOnlyList<string> paths, IEnumerable<ResourceChange> changes, DateTimeOffset at)
    {
        foreach (var change in changes.Where(c => c.At > at).OrderBy(c => c.At))
            foreach (var path in paths)
            {
                if (!change.Previous.TryGetValue(path, out var value) && !change.Previous.TryGetValue(Without(path, "properties."), out value) && !change.Previous.TryGetValue("properties." + path, out value)) continue;
                return int.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var count) ? count : null;
            }
        return current;
    }

    private static string Without(string text, string prefix) => text.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? text[prefix.Length..] : text;

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

    private static InventoryAccount ToSubscription(JsonElement e) => new(Text(e, "id") ?? "", Text(e, "name") ?? "", Tags(e));

    private static InventoryTelemetryStore ToWorkspace(JsonElement e) => new(Text(e, "id") ?? "", Text(e, "name") ?? "", Text(e, "customerId") is { Length: > 0 } c ? c : null);

    private static InventoryResource ToResource(JsonElement e) =>
        new(Text(e, "id") ?? "", Text(e, "name") ?? "", Text(e, "type") ?? "", Text(e, "subscriptionId") ?? "", Text(e, "location"), Tags(e), Count(e, "instances"), Text(e, "state") is { Length: > 0 } st ? st : null);

    /// <summary>A whole number, or null when the field is missing, null or not a number (a plan the cloud gives no count for).</summary>
    private static int? Count(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) && d >= 0 && d <= int.MaxValue ? (int)Math.Round(d) : null;

    private static string? Text(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static Dictionary<string, string> Tags(JsonElement e)
    {
        var tags = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (e.TryGetProperty("tags", out var t) && t.ValueKind == JsonValueKind.Object)
            foreach (var p in t.EnumerateObject())
                if (p.Value.ValueKind == JsonValueKind.String) tags[p.Name] = p.Value.GetString()!;
        return tags;
    }

    /// <summary>Reads a recorded response instead of asking Azure, for trying rules offline and for tests: the rows of one or both queries as <c>{ "subscriptions": [...], "resources": [...], "workspaces": [...] }</c> (workspaces only when a workspace is to be found by its name).</summary>
    public static Inventory FromRecording(string json)
    {
        using var doc = JsonDocument.Parse(json);
        IEnumerable<JsonElement> Rows(string name) => doc.RootElement.TryGetProperty(name, out var a) ? a.EnumerateArray().Select(x => x.Clone()).ToList() : [];
        return new Inventory(Rows("subscriptions").Select(ToSubscription).ToList(), Rows("resources").Select(ToResource).ToList(),
            doc.RootElement.TryGetProperty("workspaces", out _) ? Rows("workspaces").Select(ToWorkspace).ToList() : null);
    }
}

/// <summary>
/// The inventory source. It fills no readings: what it reads goes to the environment's <see cref="ScopeStore"/>, where the rules turn it into scopes
/// and the other adapters look their systems up, and it reports each system's instance count for the instances signal. Its connection is the subscription
/// ids it may read, comma separated (none: everything the login can read), or <c>file:name.json</c> to replay a recording kept beside the town's files.
/// </summary>
public sealed class ResourceGraphSource(string name, string environmentId, RegistrySource definition, ResourceGraphInventory reader, ScopeStore store, string? recording, TimeProvider time) : IMetricSource, IPastMetricSource
{
    public string Name => name;
    public TimeSpan PollInterval => definition.PollInterval;
    public TimeSpan Timeout => definition.Timeout;

    public async Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct)
    {
        Inventory inventory;
        var view = registry.ForEnvironment(environmentId);
        try
        {
            inventory = recording is not null ? ResourceGraphInventory.FromRecording(await File.ReadAllTextAsync(recording, ct)) : await reader.ReadAsync(view, ct);
            store.Update(inventory, time.GetUtcNow());
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            store.Fail(e.Message);
            throw;
        }
        return InstanceReadings(ScopeResolver.Resolve(view, inventory), time.GetUtcNow());
    }

    public bool CanReadPast => recording is null;

    /// <summary>How long what was read of the change history is used before it is read again (a change made since could be the first one after a past time).</summary>
    public static readonly TimeSpan ChangesKeptFor = TimeSpan.FromMinutes(15);

    private readonly object _lock = new();
    private Task<IReadOnlyList<ResourceChange>>? _changes;
    private DateTimeOffset _changesRead;
    private volatile string? _pastNote;

    public string? PastNote => _pastNote;

    /// <summary>
    /// The instance counts as they were at a past time, worked out from the cloud's change history of the resources (kept about 14 days): the count a resource has now stands unless one of the properties the
    /// count reads changed since, and then the first such change says what it was before it. Where the history cannot say (it is not available, the time is older than it, the value is not a number) the system
    /// has no instance count in the frame: never today's number. What a past frame cannot know of the apps (whether one is running) is left out too.
    /// </summary>
    public async Task<IReadOnlyDictionary<string, NodeReading>> PollAtAsync(TownRegistry registry, DateTimeOffset at, CancellationToken ct)
    {
        if (store.Inventory is null) await store.WaitForReadAsync(Timeout / 2, ct);
        var inventory = store.Inventory ?? throw new InvalidOperationException("the resource inventory is not read yet");
        var view = registry.ForEnvironment(environmentId);
        var counted = reader.CountedPaths();
        var now = time.GetUtcNow();
        IReadOnlyList<ResourceChange>? changes = null;
        string? note = null;
        if (counted.Count == 0) { _pastNote = null; return new Dictionary<string, NodeReading>(); }
        if (at < now - ResourceGraphInventory.ChangeHistory)
            note = $"the time {at:yyyy-MM-dd HH:mm} is older than the change history of resources, which the cloud keeps for {ResourceGraphInventory.ChangeHistory.TotalDays:0} days, so the instance counts are left out";
        else
        {
            try { changes = await ChangesAsync(inventory, counted.Keys, now, ct); }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                note = $"the change history of resources could not be read, so the instance counts of {at:yyyy-MM-dd HH:mm} are left out: {e.Message}";
            }
        }
        var byResource = (changes ?? []).ToLookup(c => c.ResourceId, StringComparer.OrdinalIgnoreCase);
        var resources = inventory.Resources.Select(r => counted.TryGetValue(r.Type.ToLowerInvariant(), out var paths)
            ? r with { Instances = changes is null ? null : ResourceGraphInventory.InstancesAt(r.Instances, paths, byResource[r.Id], at), State = null }
            : r with { State = null }).ToList();
        _pastNote = note;
        return InstanceReadings(ScopeResolver.Resolve(view, new Inventory(inventory.Accounts, resources, inventory.TelemetryStores)), at);
    }

    /// <summary>The change history of the counted types of every account that has some, read once and kept for a while: every frame of a fill asks for it.</summary>
    private Task<IReadOnlyList<ResourceChange>> ChangesAsync(Inventory inventory, IEnumerable<string> types, DateTimeOffset now, CancellationToken ct)
    {
        lock (_lock)
        {
            if (_changes is not null && now - _changesRead < ChangesKeptFor) return _changes;
            var accounts = inventory.Resources.Select(r => r.AccountId).Where(id => !string.IsNullOrEmpty(id)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            var read = reader.ReadChangesAsync(accounts, types, now - ResourceGraphInventory.ChangeHistory, ct);
            _changes = read;
            _changesRead = now;
            _ = read.ContinueWith(_ => { lock (_lock) if (ReferenceEquals(_changes, read)) _changes = null; }, TaskContinuationOptions.NotOnRanToCompletion);
            return read;
        }
    }

    /// <summary>
    /// What the inventory knows of a system's signals: how many instances it runs. Only a system with a counted resource gets a reading; the count is
    /// what is configured (a plan's workers), so every instance counts as healthy: health is for the sources that measure it.
    /// </summary>
    public static IReadOnlyDictionary<string, NodeReading> InstanceReadings(Resolution resolution, DateTimeOffset at) =>
        resolution.Systems.Where(s => s.Instances is not null || s.AppState is not null)
            .ToDictionary(s => s.SystemId, s => new NodeReading(at, true, s.Instances ?? 0, s.Instances ?? 0, 0, 0, 0, 0, App: s.AppState, Regions: RegionInstances(s)));

    /// <summary>The instances in each region the system's counted resources are in (the plans of each region). Null when none of them says a region.</summary>
    private static IReadOnlyList<RegionReading>? RegionInstances(SystemScope s)
    {
        var regions = s.Resources.Where(r => r.Region is { Length: > 0 } && r.Instances is not null).GroupBy(r => r.Region!, StringComparer.OrdinalIgnoreCase)
            .Select(g => new RegionReading(g.Key, g.Sum(r => r.Instances!.Value), null, null)).OrderBy(r => r.Region, StringComparer.Ordinal).ToList();
        return regions.Count == 0 ? null : regions;
    }
}

public sealed class ResourceGraphSourceFactory(HttpClient? http = null, TimeProvider? time = null) : IMetricSourceFactory
{
    public const string RecordingPrefix = "file:";

    public const string SourceKind = "resourcegraph";

    public string Kind => SourceKind;

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
