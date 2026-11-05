using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>One entry of the activity log's resource-health category: what happened to a resource and when, and the states the cloud gave (null when it gave none).</summary>
public sealed record HealthLogEntry(string ResourceId, DateTimeOffset At, string Operation, string? Current, string? Previous, string? Cause, string? Summary);

/// <summary>
/// What the cloud's own word on a resource's health looks like and how it is read: the activity log's resource-health entries (activated, updated, resolved), folded into the
/// events that are open, and the answer of the resource's current-status call. Pure, so tests feed it recorded answers.
/// </summary>
public static class ResourceHealthLog
{
    public const string Category = "ResourceHealth";
    public const string ActivityApiVersion = "2015-04-01";
    public const string StatusApiVersion = "2022-10-01";

    /// <summary>The states that make an event open. Available is fine, and Unknown says only that the cloud has no data, which is not trouble.</summary>
    public static readonly string[] OpenStates = ["Degraded", "Unavailable"];

    /// <summary>The call that lists the activity log of one subscription for one resource provider since <paramref name="from"/>. The log is filtered here, by the provider, so a busy subscription is not read whole.</summary>
    public static string ActivityUrl(string subscriptionId, string provider, DateTimeOffset from)
    {
        var filter = $"eventTimestamp ge '{from.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture)}' and resourceProvider eq '{provider}'";
        return $"{AzureMonitorReader.Endpoint}/subscriptions/{Uri.EscapeDataString(subscriptionId)}/providers/microsoft.insights/eventtypes/management/values?api-version={ActivityApiVersion}&$filter={Uri.EscapeDataString(filter)}";
    }

    /// <summary>The call that gives a resource's health right now.</summary>
    public static string StatusUrl(string resourceId) =>
        $"{AzureMonitorReader.Endpoint}{resourceId.TrimEnd('/')}/providers/Microsoft.ResourceHealth/availabilityStatuses/current?api-version={StatusApiVersion}";

    /// <summary>The resource-health entries of one page of the activity log, and the address of the next page (null on the last). Entries of any other category are left out.</summary>
    public static (IReadOnlyList<HealthLogEntry> Entries, string? NextLink) Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        if (!root.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("the answer has no list of events; was it an activity log answer?");
        var entries = new List<HealthLogEntry>();
        foreach (var item in value.EnumerateArray())
        {
            if (Text(item, "category", "value") is not { } category || !category.Equals(Category, StringComparison.OrdinalIgnoreCase)) continue;
            if (Plain(item, "resourceId") is not { Length: > 0 } resource) continue;
            if (Plain(item, "eventTimestamp") is not { } stamp || !DateTimeOffset.TryParse(stamp, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at)) continue;
            var props = item.TryGetProperty("properties", out var p) && p.ValueKind == JsonValueKind.Object ? p : default;
            entries.Add(new HealthLogEntry(resource, at, Text(item, "operationName", "value") ?? "",
                Plain(props, "currentHealthStatus"), Plain(props, "previousHealthStatus"), Plain(props, "cause"), Plain(props, "title")));
        }
        return (entries, Plain(root, "nextLink") is { Length: > 0 } next ? next : null);
    }

    /// <summary>The availability state a resource's current-status call gave (Available, Degraded, Unavailable, Unknown), or null when the answer has none.</summary>
    public static string? ParseAvailability(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.TryGetProperty("properties", out var p) ? Plain(p, "availabilityState") : null;
    }

    /// <summary>
    /// The events open now. The newest entry of a resource decides: a resolved one, or one that says the resource is Available (or the state is Unknown), closes it; anything else
    /// with a Degraded or Unavailable state is open. An event started when its first activation after the last resolution happened. Previous is what the resource was before then.
    /// </summary>
    public static IReadOnlyList<ResourceHealthEvent> Open(IEnumerable<HealthLogEntry> entries)
    {
        var open = new List<ResourceHealthEvent>();
        foreach (var group in entries.GroupBy(e => e.ResourceId, StringComparer.OrdinalIgnoreCase))
        {
            var ordered = group.DistinctBy(e => (e.At, e.Operation, e.Current)).OrderBy(e => e.At).ToList(); // the same entry can arrive twice, once for each subscription or provider asked
            var newest = ordered[^1];
            var state = OpenStates.FirstOrDefault(s => s.Equals(newest.Current, StringComparison.OrdinalIgnoreCase));
            if (state is null || Is(newest, "Resolved")) continue;
            var lastResolved = ordered.Where(e => Is(e, "Resolved")).Select(e => (DateTimeOffset?)e.At).LastOrDefault();
            var run = ordered.Where(e => lastResolved is null || e.At > lastResolved).ToList();
            var first = run.FirstOrDefault(e => Is(e, "Activated")) ?? run[0];
            open.Add(new ResourceHealthEvent(
                $"{group.Key.ToLowerInvariant()}@{first.At.UtcDateTime:yyyyMMdd'T'HHmmss'Z'}",
                newest.ResourceId, group.Key.TrimEnd('/').Split('/')[^1], state,
                first.Previous ?? newest.Previous, newest.Cause ?? first.Cause, first.At, newest.Summary ?? first.Summary));
        }
        return open;
    }

    /// <summary>
    /// The events that ended: every run of entries that a resolution (or an Available state) closed, resolved no earlier than <paramref name="since"/>. A resource can have several: one that went
    /// wrong, recovered and went wrong again has the first listed as resolved and the second as open (see <see cref="Open"/>), each with its own id. State is "Resolved", Since when it went
    /// wrong, ResolvedAt when the log says it recovered, Previous what it was before.
    /// </summary>
    public static IReadOnlyList<ResourceHealthEvent> Resolved(IEnumerable<HealthLogEntry> entries, DateTimeOffset since)
    {
        var done = new List<ResourceHealthEvent>();
        foreach (var group in entries.GroupBy(e => e.ResourceId, StringComparer.OrdinalIgnoreCase))
        {
            var run = new List<HealthLogEntry>();
            foreach (var e in group.DistinctBy(e => (e.At, e.Operation, e.Current)).OrderBy(e => e.At)) // the same entry can arrive twice, once for each subscription or provider asked
            {
                var closes = Is(e, "Resolved") || "Available".Equals(e.Current, StringComparison.OrdinalIgnoreCase);
                if (!closes) { run.Add(e); continue; }
                var wrong = run.Where(r => OpenStates.Any(s => s.Equals(r.Current, StringComparison.OrdinalIgnoreCase))).ToList();
                run.Clear();
                if (wrong.Count == 0 || e.At < since) continue; // it never went wrong in this run, or it ended too long ago
                var first = wrong.FirstOrDefault(r => Is(r, "Activated")) ?? wrong[0];
                done.Add(new ResourceHealthEvent(
                    $"{group.Key.ToLowerInvariant()}@{first.At.UtcDateTime:yyyyMMdd'T'HHmmss'Z'}",
                    e.ResourceId, group.Key.TrimEnd('/').Split('/')[^1], "Resolved",
                    first.Previous ?? e.Previous, wrong[^1].Cause ?? first.Cause, first.At, wrong[^1].Summary ?? first.Summary, e.At));
            }
        }
        return done;
    }

    private static bool Is(HealthLogEntry e, string step) => e.Operation.Contains($"/{step}/", StringComparison.OrdinalIgnoreCase) || e.Operation.EndsWith($"/{step}", StringComparison.OrdinalIgnoreCase);

    private static string? Plain(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string? Text(JsonElement e, string outer, string inner) =>
        e.TryGetProperty(outer, out var o) && o.ValueKind == JsonValueKind.Object ? Plain(o, inner) : null;
}

/// <summary>
/// The cloud's own word on the health of resources: the activity log's resource-health entries for the providers the environment lists (<c>providers</c>), read for each subscription the
/// scope found, folded into the events that are open (see <see cref="ResourceHealthLog.Open"/>). For each open event the resource's current status is asked too, so a marker clears the moment
/// the cloud says Available, whether or not a resolution ever reached the log; a status that cannot be read leaves the log's word standing. The source fills no signal and reports no readings.
/// A read that fails keeps the last good list and says why through <see cref="Problem"/>, which the town shows as a notice. The program lists no provider: the environment does.
/// <c>file:name.json</c> replays a recording: <c>{ "events": { "value": [ ...an activity log answer... ] }, "status": { "&lt;resource name&gt;": "Available" } }</c>.
/// </summary>
public sealed class ResourceHealthSource(
    string name, string environmentId, RegistrySource definition, AzureMonitorReader reader, ScopeStore store, string? recording, TimeProvider time) : IMetricSource, IHealthEventSource
{
    /// <summary>How far back the log is read when the source gives no window: a problem that lasts days must still be listed.</summary>
    public const string DefaultWindow = "3d";
    public const double DefaultPollSeconds = 300;
    public const double DefaultTimeoutSeconds = 60;
    public const int MaxParallel = 8;

    public const string DefaultKeepResolvedFor = "4h";

    private volatile IReadOnlyList<ResourceHealthEvent> _events = [];
    private readonly ConcurrentDictionary<string, byte> _dismissed = new(StringComparer.Ordinal);
    private volatile string? _problem;

    public string Name => name;
    public TimeSpan PollInterval => TimeSpan.FromSeconds(definition.PollSeconds ?? DefaultPollSeconds);
    public TimeSpan Timeout => TimeSpan.FromSeconds(definition.TimeoutSeconds ?? DefaultTimeoutSeconds);
    public TimeSpan Window { get; } = SourceQuery.TryParseWindow(definition.Window ?? DefaultWindow, out var w) ? w : throw new InvalidOperationException($"the window '{definition.Window}' is not a number and a unit like 3d");

    /// <summary>How long a report stays listed, as resolved, after the resource recovered.</summary>
    public TimeSpan KeepResolvedFor { get; } = SourceQuery.TryParseWindow(definition.KeepResolvedFor ?? DefaultKeepResolvedFor, out var k) ? k : throw new InvalidOperationException($"keepResolvedFor '{definition.KeepResolvedFor}' is not a number and a unit like 4h");

    public IReadOnlyList<ResourceHealthEvent> Current() => _events.Where(e => !_dismissed.ContainsKey(e.Id)).ToList();

    public bool Dismiss(string id)
    {
        if (!_events.Any(e => e.Id == id)) return false;
        _dismissed[id] = 0;
        return true;
    }
    public string? Problem => _problem;

    public async Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct)
    {
        var none = new Dictionary<string, NodeReading>();
        if (recording is null)
        {
            if (store.Inventory is null) await store.WaitForReadAsync(Timeout / 2, ct); // the subscriptions to ask are in the inventory
            if (store.Inventory is null) return none; // nothing says where to look yet
        }
        try
        {
            _events = await ReadAsync(registry.ForEnvironment(environmentId), time.GetUtcNow(), ct);
            _problem = null;
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            _problem = e.Message;
            throw;
        }
        return none;
    }

    private async Task<IReadOnlyList<ResourceHealthEvent>> ReadAsync(TownRegistry view, DateTimeOffset now, CancellationToken ct)
    {
        var from = now - Window;
        IReadOnlyList<HealthLogEntry> entries;
        IReadOnlyDictionary<string, string>? recorded = null;
        if (recording is not null)
        {
            (entries, recorded) = ReadRecording(await File.ReadAllTextAsync(recording, ct));
        }
        else
        {
            var resolution = store.Resolve(view);
            var subscriptions = resolution.Systems.Select(s => s.SubscriptionId).Concat(resolution.Pillars.Select(p => p.SubscriptionId)).Concat(resolution.AssetList.Select(a => a.SubscriptionId))
                .Where(id => !string.IsNullOrEmpty(id)).Select(id => id!).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            entries = await ReadLogAsync(subscriptions, from, ct);
        }
        // a recording is already the answer for its window, whenever it is replayed
        var open = ResourceHealthLog.Open(recording is null ? entries.Where(e => e.At >= from) : entries);
        var gate = new SemaphoreSlim(MaxParallel);
        var checkedNow = await Task.WhenAll(open.Select(async e =>
        {
            await gate.WaitAsync(ct);
            try { return (Event: e, Now: await StatusAsync(e, recorded, ct)); }
            finally { gate.Release(); }
        }));
        var stillOpen = checkedNow
            .Where(x => !"Available".Equals(x.Now, StringComparison.OrdinalIgnoreCase)) // the cloud says it is fine again, whatever the log said last
            .Select(x => ResourceHealthLog.OpenStates.FirstOrDefault(s => s.Equals(x.Now, StringComparison.OrdinalIgnoreCase)) is { } state ? x.Event with { State = state } : x.Event)
            .ToList();
        // resolved reports stay listed for a while. One the log never closed but the cloud now calls Available is resolved when this source first saw it so, and only if it had listed it open before
        var earlier = _events.ToDictionary(e => e.Id);
        var cutoff = recording is null ? now - KeepResolvedFor : DateTimeOffset.MinValue; // a recording is replayed whenever, so its resolutions never age out
        var resolved = ResourceHealthLog.Resolved(recording is null ? entries.Where(e => e.At >= from) : entries, cutoff).ToDictionary(e => e.Id);
        foreach (var x in checkedNow.Where(x => "Available".Equals(x.Now, StringComparison.OrdinalIgnoreCase)))
            if (earlier.TryGetValue(x.Event.Id, out var was) && !resolved.ContainsKey(x.Event.Id))
                resolved[x.Event.Id] = x.Event with { State = "Resolved", ResolvedAt = was.ResolvedAt ?? now };
        // an event that is open again is not also listed as resolved
        var openIds = stillOpen.Select(e => e.Id).ToHashSet();
        return [.. stillOpen, .. resolved.Values.Where(e => !openIds.Contains(e.Id) && (e.ResolvedAt ?? now) >= cutoff)];
    }

    private async Task<IReadOnlyList<HealthLogEntry>> ReadLogAsync(IReadOnlyList<string> subscriptions, DateTimeOffset from, CancellationToken ct)
    {
        var asks = subscriptions.SelectMany(s => definition.Providers.Select(p => (Subscription: s, Provider: p))).ToList();
        var all = new List<HealthLogEntry>();
        var errors = new List<string>();
        var gate = new SemaphoreSlim(MaxParallel);
        await Task.WhenAll(asks.Select(async ask =>
        {
            await gate.WaitAsync(ct);
            try
            {
                var url = ResourceHealthLog.ActivityUrl(ask.Subscription, ask.Provider, from);
                var seen = new HashSet<string>();
                while (url is not null && seen.Add(url))
                {
                    var (page, next) = ResourceHealthLog.Parse(await reader.GetAsync(ask.Subscription, url, ct, "the Azure activity log"));
                    lock (all) all.AddRange(page);
                    url = next;
                }
            }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested) { lock (errors) errors.Add(e.Message); }
            finally { gate.Release(); }
        }));
        // a list made from only some of the subscriptions could hide the one in trouble, so a failed read keeps the last good list
        if (errors.Count > 0)
            throw new HttpRequestException($"{errors.Count} of {asks.Count} activity log reads failed, so the list was not updated this time; the first: {errors[0]}");
        return all;
    }

    /// <summary>The state the cloud gives the resource right now, or null when it cannot be read (the log's word then stands).</summary>
    private async Task<string?> StatusAsync(ResourceHealthEvent e, IReadOnlyDictionary<string, string>? recorded, CancellationToken ct)
    {
        if (recorded is not null) return recorded.GetValueOrDefault(e.ResourceName);
        try { return ResourceHealthLog.ParseAvailability(await reader.GetAsync(e.ResourceId, ResourceHealthLog.StatusUrl(e.ResourceId), ct, "Azure Resource Health")); }
        catch (Exception ex) when (ex is HttpRequestException or JsonException) { return null; }
    }

    public static (IReadOnlyList<HealthLogEntry> Entries, IReadOnlyDictionary<string, string> Status) ReadRecording(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var log = root.TryGetProperty("events", out var events) ? events : root;
        var status = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (root.TryGetProperty("status", out var s) && s.ValueKind == JsonValueKind.Object)
            foreach (var p in s.EnumerateObject()) if (p.Value.GetString() is { } state) status[p.Name] = state;
        return (ResourceHealthLog.Parse(log.GetRawText()).Entries, status);
    }
}

public sealed class ResourceHealthSourceFactory(HttpClient? http = null, TimeProvider? time = null) : IMetricSourceFactory
{
    public string Kind => SourceKinds.ResourceHealth;

    public IMetricSource Create(SourceContext context)
    {
        if (context.Source.Providers.Count == 0)
            throw new InvalidOperationException("it names no resource provider. List the providers whose health reports to read under providers: (for example the data store's), as the cloud names them (see docs/connect-your-company.md)");
        var connection = context.Source.Connection ?? "";
        string? recording = null;
        if (connection.StartsWith(ResourceGraphSourceFactory.RecordingPrefix, StringComparison.OrdinalIgnoreCase))
        {
            var file = connection[ResourceGraphSourceFactory.RecordingPrefix.Length..].Trim();
            recording = Path.IsPathRooted(file) || context.RegistryFolder is null ? file : Path.Combine(context.RegistryFolder, file);
            if (!File.Exists(recording)) throw new InvalidOperationException($"the recording {file} does not exist");
        }
        return new ResourceHealthSource(context.Source.Name, context.EnvironmentId, context.Source, new AzureMonitorReader(http ?? Shared, context.Credential),
            context.Scope ?? new ScopeStore(), recording, time ?? TimeProvider.System);
    }

    private static readonly HttpClient Shared = new();
}
