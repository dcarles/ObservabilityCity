using System.Globalization;
using System.Net.Http.Headers;
using System.Text.Json;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>One question to the metrics API: these metrics, added up this way, filtered like this. Metrics that agree on the rest share one call.</summary>
public sealed record MetricCall(string? Namespace, string Aggregation, string? Filter, string Interval = AzureMonitorReader.Interval)
{
    public static MetricCall Of(string? ns, MetricSignal spec, TimeSpan? interval = null) =>
        new(ns, spec.Aggregation, spec.Filter, interval is { } i ? AzureMonitorReader.Iso(i) : AzureMonitorReader.Interval);
}

/// <summary>The points one metric gave for one entity (the value of the dimension the answer was split by) over the window.</summary>
public sealed record EntitySeries(string Entity, string Metric, string Aggregation, IReadOnlyList<double> Points, string? Region = null, string? NamespaceId = null, IReadOnlyList<DateTimeOffset>? Times = null);

/// <summary>The points one metric gave over the window, as asked: this metric, added up this way, with this filter. No point is a gap the cloud left, not a zero. Part is the value of the dimension a split read was split by (see <c>parts</c>): the piece of the resource the points are for.</summary>
public sealed record MetricSeries(string Metric, string Aggregation, string? Filter, IReadOnlyList<double> Points, string? Part = null, IReadOnlyList<DateTimeOffset>? Times = null);

/// <summary>
/// Reads platform metrics of single resources from the Azure Monitor metrics API. The adapter knows no metric: which ones to ask for, for which
/// resources, and what they mean comes from the environment's <c>metrics</c> entries.
/// </summary>
public sealed class AzureMonitorReader(HttpClient http, ICredentialSource? credential, TimeSpan? retryDelay = null)
{
    /// <summary>How many times a read is tried when Azure answers with a hiccup (busy, unavailable, a dropped connection) before it counts as failed.</summary>
    public const int Attempts = 3;

    /// <summary>How many series a read split by a dimension asks for: Azure answers with only 10 unless asked for more, and a broker holds hundreds of queues.</summary>
    public const int MaxSeries = 1000;

    private long _calls;
    private long _bytes;

    /// <summary>How many answers were read and how many characters they held since the last call; reading them resets them (for the log of a rebuilt hour).</summary>
    public (int Calls, long Bytes) TakeCounts() => ((int)Interlocked.Exchange(ref _calls, 0), Interlocked.Exchange(ref _bytes, 0));

    public const string TokenScope = "https://management.azure.com/.default";
    public const string Endpoint = "https://management.azure.com";
    public const string ApiVersion = "2018-01-01";
    /// <summary>The grain asked for when the entry does not say: a minute.</summary>
    public const string Interval = "PT1M";

    /// <summary>A time grain in the ISO form the metrics API takes: PT5M, PT1H, P1D.</summary>
    public static string Iso(TimeSpan grain) => grain.TotalDays >= 1 && grain.TotalHours % 24 == 0 ? $"P{(int)grain.TotalDays}D"
        : grain.TotalHours >= 1 && grain.TotalMinutes % 60 == 0 ? $"PT{(int)grain.TotalHours}H" : $"PT{(int)Math.Round(grain.TotalMinutes)}M";

    public static string Url(string resourceId, MetricCall call, IEnumerable<string> metrics, DateTimeOffset end, TimeSpan window)
    {
        const string format = "yyyy-MM-dd'T'HH:mm:ss'Z'";
        var timespan = $"{end.UtcDateTime - window:yyyy-MM-dd'T'HH:mm:ss'Z'}/{end.UtcDateTime.ToString(format, CultureInfo.InvariantCulture)}";
        var url = $"{Endpoint}{resourceId.TrimEnd('/')}/providers/Microsoft.Insights/metrics?api-version={ApiVersion}" +
                  $"&metricnames={string.Join(',', metrics.Select(Uri.EscapeDataString))}&aggregation={Uri.EscapeDataString(Capitalised(call.Aggregation))}" +
                  $"&timespan={Uri.EscapeDataString(timespan)}&interval={call.Interval}";
        if (call.Namespace is not null) url += $"&metricnamespace={Uri.EscapeDataString(call.Namespace)}";
        if (call.Filter is not null) url += $"&$filter={Uri.EscapeDataString(call.Filter)}";
        return url;
    }

    public async Task<IReadOnlyList<MetricSeries>> ReadAsync(string resourceId, MetricCall call, IReadOnlyList<string> metrics, DateTimeOffset end, TimeSpan window, CancellationToken ct)
    {
        return Parse(await GetAsync(resourceId, Url(resourceId, call, metrics, end, window), ct), call);
    }

    /// <summary>Like <see cref="ReadAsync"/>, but split by a dimension (<c>$filter=Dimension eq '*'</c>): one series for each value of it, for example each queue of a namespace.</summary>
    public async Task<IReadOnlyList<EntitySeries>> ReadByDimensionAsync(string resourceId, MetricCall call, IReadOnlyList<string> metrics, string dimension, DateTimeOffset end, TimeSpan window, CancellationToken ct)
    {
        var split = call with { Filter = $"{dimension} eq '*'" };
        return ParseByDimension(await GetAsync(resourceId, Url(resourceId, split, metrics, end, window) + $"&top={MaxSeries}", ct), call, dimension);
    }

    /// <summary>
    /// Like <see cref="ReadAsync"/>, but split by a dimension, one series for each value of it, as <see cref="MetricSeries"/> that say which value (<c>Part</c>). The call's own filter stays,
    /// joined to the split with <c>and</c>, and the series keep the call's filter so they match the signals that asked for it. A series with no value for the dimension has an empty Part.
    /// </summary>
    public async Task<IReadOnlyList<MetricSeries>> ReadByPartAsync(string resourceId, MetricCall call, IReadOnlyList<string> metrics, string dimension, DateTimeOffset end, TimeSpan window, CancellationToken ct)
    {
        var split = call with { Filter = call.Filter is null ? $"{dimension} eq '*'" : $"{call.Filter} and {dimension} eq '*'" };
        return ParseByPart(await GetAsync(resourceId, Url(resourceId, split, metrics, end, window) + $"&top={MaxSeries}", ct), call, dimension);
    }

    /// <summary>The login scope of the batch endpoint, which is not the one of the management endpoint.</summary>
    public const string BatchTokenScope = "https://metrics.monitor.azure.com/.default";
    public const string BatchApiVersion = "2023-10-01";

    /// <summary>How many resources one batch call may ask about: the most Azure takes.</summary>
    public const int BatchLimit = 50;

    /// <summary>The batch call for resources of one subscription, one region and one metric namespace: the same question as <see cref="Url"/>, asked about many resources at once. The region is the cloud's own name of it (northeurope).</summary>
    public static string BatchUrl(string location, string subscription, string metricNamespace, MetricCall call, IEnumerable<string> metrics, DateTimeOffset end, TimeSpan window, string? dimension)
    {
        const string format = "yyyy-MM-dd'T'HH:mm:ss'Z'";
        var filter = dimension is null ? call.Filter : call.Filter is null ? $"{dimension} eq '*'" : $"{call.Filter} and {dimension} eq '*'";
        var url = $"https://{location}.metrics.monitor.azure.com/subscriptions/{subscription}/metrics:getBatch?api-version={BatchApiVersion}" +
                  $"&metricnamespace={Uri.EscapeDataString(metricNamespace)}&metricnames={string.Join(',', metrics.Select(Uri.EscapeDataString))}" +
                  $"&aggregation={Uri.EscapeDataString(call.Aggregation.ToLowerInvariant())}&interval={call.Interval}" +
                  $"&starttime={(end.UtcDateTime - window).ToString(format, CultureInfo.InvariantCulture)}&endtime={end.UtcDateTime.ToString(format, CultureInfo.InvariantCulture)}";
        if (filter is not null) url += $"&filter={Uri.EscapeDataString(filter)}";
        if (dimension is not null) url += $"&top={MaxSeries}";
        return url;
    }

    /// <summary>What a batch call gave for one resource: its series, and whether the answer was cut at <see cref="MaxSeries"/> (so some series may be missing).</summary>
    public sealed record BatchAnswer(IReadOnlyList<MetricSeries> Series, bool Cut);

    /// <summary>Reads the same metrics of up to <see cref="BatchLimit"/> resources in one call. The answer has an entry for each resource, keyed by its id (not case sensitive).</summary>
    public async Task<IReadOnlyDictionary<string, BatchAnswer>> ReadBatchAsync(IReadOnlyList<string> resourceIds, string location, string subscription, string metricNamespace, MetricCall call, IReadOnlyList<string> metrics, string? dimension, DateTimeOffset end, TimeSpan window, CancellationToken ct)
    {
        var url = BatchUrl(location, subscription, metricNamespace, call, metrics, end, window, dimension);
        var body = JsonSerializer.Serialize(new { resourceids = resourceIds });
        var text = await SendAsync(HttpMethod.Post, $"{resourceIds.Count}-resources-in-{location}", url, body, BatchTokenScope, ct, "Azure Monitor batch");
        return ParseBatch(text, call, dimension);
    }

    /// <summary>The entries of a batch answer, each read like the answer of a single resource. An answer that is not a batch answer fails, so it is never taken for one with no data.</summary>
    public static IReadOnlyDictionary<string, BatchAnswer> ParseBatch(string json, MetricCall call, string? dimension)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("values", out var values) || values.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("the answer has no list of resources; was it an Azure Monitor batch answer?");
        var all = new Dictionary<string, BatchAnswer>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in values.EnumerateArray())
        {
            if (!entry.TryGetProperty("resourceid", out var id) || id.GetString() is not { Length: > 0 } resource) continue;
            var raw = entry.GetRawText();
            var cut = entry.TryGetProperty("value", out var metrics) && metrics.ValueKind == JsonValueKind.Array
                && metrics.EnumerateArray().Any(m => m.TryGetProperty("timeseries", out var s) && s.ValueKind == JsonValueKind.Array && s.GetArrayLength() >= MaxSeries);
            all[resource.TrimEnd('/')] = new BatchAnswer(dimension is null ? Parse(raw, call) : ParseByPart(raw, call, dimension), cut);
        }
        return all;
    }

    /// <summary>
    /// The answer's text. A hiccup of Azure's (too many requests, busy, unavailable, a connection that drops) is tried again a couple of times a moment later, since it
    /// nearly always passes; any other answer, such as a refusal, fails at once.
    /// </summary>
    public Task<string> GetAsync(string resourceId, string url, CancellationToken ct, string service = "Azure Monitor") =>
        SendAsync(HttpMethod.Get, resourceId, url, null, TokenScope, ct, service);

    private async Task<string> SendAsync(HttpMethod method, string resourceId, string url, string? body, string scope, CancellationToken ct, string service)
    {
        var token = credential is null ? null : await credential.GetTokenAsync(scope, ct);
        for (var attempt = 1; ; attempt++)
        {
            using var request = new HttpRequestMessage(method, url);
            if (body is not null) request.Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
            if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            HttpResponseMessage? response = null;
            string? text = null;
            TimeSpan? told = null;
            try
            {
                response = await http.SendAsync(request, ct);
                text = await response.Content.ReadAsStringAsync(ct);
            }
            catch (Exception e) when ((e is HttpRequestException or IOException) && attempt < Attempts && !ct.IsCancellationRequested) { } // the connection dropped
            if (response is not null && text is not null)
            {
                using (response)
                {
                    if (response.IsSuccessStatusCode)
                    {
                        Interlocked.Increment(ref _calls);
                        Interlocked.Add(ref _bytes, text.Length);
                        return text;
                    }
                    if (attempt >= Attempts || !(IsHiccup(response.StatusCode) || IsConfigurationGlitch(response.StatusCode, text)))
                        throw new HttpRequestException($"{service} answered {(int)response.StatusCode} {response.ReasonPhrase} for {Last(resourceId)}: {Trim(text)}", null, response.StatusCode);
                    told = RetryWait.For(response.Headers, attempt, retryDelay, DateTimeOffset.UtcNow, Random.Shared.NextDouble());
                }
            }
            await Task.Delay(told ?? RetryWait.For(null, attempt, retryDelay, DateTimeOffset.UtcNow, Random.Shared.NextDouble()), ct);
        }
    }

    private static bool IsHiccup(System.Net.HttpStatusCode code) => RetryWait.IsHiccup(code);

    /// <summary>
    /// A 400 in which Azure says it cannot find the metric configuration of a resource that has the metric (an empty list of valid metrics). It comes and goes for the same resource,
    /// so it is tried again like a hiccup instead of failing the read (and, in the past, the whole hour).
    /// </summary>
    public static bool IsConfigurationGlitch(System.Net.HttpStatusCode code, string text) =>
        code == System.Net.HttpStatusCode.BadRequest && text.Contains("Failed to find metric configuration", StringComparison.OrdinalIgnoreCase);

    /// <summary>The series of an answer split by a dimension, each with the value of the dimension it is for. A series without that value is left out.</summary>
    public static IReadOnlyList<EntitySeries> ParseByDimension(string json, MetricCall call, string dimension)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("the answer has no list of metrics; was it an Azure Monitor metrics answer?");
        var field = call.Aggregation.ToLowerInvariant();
        var all = new List<EntitySeries>();
        foreach (var metric in value.EnumerateArray())
        {
            var name = metric.TryGetProperty("name", out var n) && n.TryGetProperty("value", out var v) ? v.GetString() : null;
            if (name is null || !metric.TryGetProperty("timeseries", out var series) || series.ValueKind != JsonValueKind.Array) continue;
            foreach (var one in series.EnumerateArray())
            {
                string? entity = null;
                if (one.TryGetProperty("metadatavalues", out var meta) && meta.ValueKind == JsonValueKind.Array)
                    foreach (var m in meta.EnumerateArray())
                        if (m.TryGetProperty("name", out var mn) && mn.TryGetProperty("value", out var mv) && string.Equals(mv.GetString(), dimension, StringComparison.OrdinalIgnoreCase) && m.TryGetProperty("value", out var ev))
                            entity = ev.GetString();
                if (entity is null) continue;
                var points = new List<double>();
                var times = new List<DateTimeOffset>();
                if (one.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
                    foreach (var point in data.EnumerateArray())
                        if (point.TryGetProperty(field, out var number) && number.ValueKind == JsonValueKind.Number && number.TryGetDouble(out var d) && double.IsFinite(d))
                        {
                            points.Add(d);
                            times.Add(PointTime(point));
                        }
                all.Add(new EntitySeries(entity, name, call.Aggregation, points, Times: times));
            }
        }
        return all;
    }

    /// <summary>The series of an answer split by a dimension, as <see cref="MetricSeries"/> with the value of the dimension as Part (empty when a series has none).</summary>
    public static IReadOnlyList<MetricSeries> ParseByPart(string json, MetricCall call, string dimension)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("the answer has no list of metrics; was it an Azure Monitor metrics answer?");
        var field = call.Aggregation.ToLowerInvariant();
        var all = new List<MetricSeries>();
        foreach (var metric in value.EnumerateArray())
        {
            var name = metric.TryGetProperty("name", out var n) && n.TryGetProperty("value", out var v) ? v.GetString() : null;
            if (name is null || !metric.TryGetProperty("timeseries", out var series) || series.ValueKind != JsonValueKind.Array) continue;
            foreach (var one in series.EnumerateArray())
            {
                var part = "";
                if (one.TryGetProperty("metadatavalues", out var meta) && meta.ValueKind == JsonValueKind.Array)
                    foreach (var m in meta.EnumerateArray())
                        if (m.TryGetProperty("name", out var mn) && mn.TryGetProperty("value", out var mv) && string.Equals(mv.GetString(), dimension, StringComparison.OrdinalIgnoreCase) && m.TryGetProperty("value", out var ev))
                            part = ev.GetString() ?? "";
                var points = new List<double>();
                var times = new List<DateTimeOffset>();
                if (one.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
                    foreach (var point in data.EnumerateArray())
                        if (point.TryGetProperty(field, out var number) && number.ValueKind == JsonValueKind.Number && number.TryGetDouble(out var d) && double.IsFinite(d))
                        {
                            points.Add(d);
                            times.Add(PointTime(point));
                        }
                all.Add(new MetricSeries(name, call.Aggregation, call.Filter, points, part, times));
            }
        }
        return all;
    }

    /// <summary>When a point starts, from its <c>timeStamp</c>; the start of time when the answer has none (a recording), so a series without times is never mistaken for a dated one.</summary>
    private static DateTimeOffset PointTime(JsonElement point) =>
        point.TryGetProperty("timeStamp", out var t) && t.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(t.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : DateTimeOffset.MinValue;

    private static string Capitalised(string text) => text.Length == 0 ? text : char.ToUpperInvariant(text[0]) + text[1..].ToLowerInvariant();

    private static string Last(string resourceId) => resourceId.TrimEnd('/').Split('/')[^1];
    private static string Trim(string text) => text.Length <= 300 ? text : text[..300] + "...";

    /// <summary>The points of every metric in the answer. A point the cloud gave no value for (it has no field for the aggregation) is a gap and is left out.</summary>
    public static IReadOnlyList<MetricSeries> Parse(string json, MetricCall call)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("the answer has no list of metrics; was it an Azure Monitor metrics answer?");
        var field = call.Aggregation.ToLowerInvariant();
        var series = new List<MetricSeries>();
        foreach (var metric in value.EnumerateArray())
        {
            var name = metric.TryGetProperty("name", out var n) && n.TryGetProperty("value", out var v) ? v.GetString() : null;
            if (name is null) continue;
            var points = new List<double>();
            var times = new List<DateTimeOffset>();
            if (metric.TryGetProperty("timeseries", out var all) && all.ValueKind == JsonValueKind.Array)
                foreach (var one in all.EnumerateArray())
                    if (one.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
                        foreach (var point in data.EnumerateArray())
                            if (point.TryGetProperty(field, out var number) && number.ValueKind == JsonValueKind.Number && number.TryGetDouble(out var d) && double.IsFinite(d))
                            {
                                points.Add(d);
                                times.Add(PointTime(point));
                            }
            series.Add(new MetricSeries(name, call.Aggregation, call.Filter, points, Times: times));
        }
        return series;
    }

    /// <summary>The points added up the way the aggregation says: the average of averages, the sum of totals and counts, the highest maximum, the lowest minimum, the newest point for last (the points are in time order). Null with no point.</summary>
    public static double? Reduce(IReadOnlyList<double> points, string aggregation)
    {
        if (points.Count == 0) return null;
        return aggregation.ToLowerInvariant() switch
        {
            "total" or "count" => points.Sum(),
            "maximum" => points.Max(),
            "minimum" => points.Min(),
            "last" => points[^1],
            _ => points.Average(),
        };
    }
}

/// <summary>
/// The platform-metrics source: CPU and memory of the plans a system runs on, request units and throttling of the data accounts it uses, whatever the
/// environment's <c>metrics</c> entries say. Each entry names a rule of <c>scope.resources</c> and says, for each signal, which metric it is and how it
/// becomes a fraction or a rate; the metric names, the aggregation, the filter that picks out throttled requests and the divisor that turns request units
/// into a share of what is provisioned are all the environment's. A system with several resources is as busy as its busiest one. If any resource cannot
/// be read the poll fails: a number made from only some of a system's resources could hide the one that is in trouble.
/// <c>file:name.json</c> replays recorded series (<c>{ "&lt;resource name&gt;": [ { "metric", "aggregation", "filter", "points": [...] } ] }</c>) kept beside the town's files.
/// </summary>
public sealed class AzureMonitorSource(
    string name, string environmentId, RegistrySource definition, AzureMonitorReader reader, ScopeStore store, string? recording, TimeProvider time) : IPastMetricSource, IPastReadStats, IProgressiveMetricSource
{
    public const int MaxParallel = 8;

    public string Name => name;
    public TimeSpan PollInterval => definition.PollInterval;
    public TimeSpan Timeout => definition.Timeout;
    public TimeSpan Window { get; } = SourceQuery.WindowOf(definition);
    private readonly AzureSettings _settings = AzureSettings.Of(definition);

    /// <summary>One resource of one system and the entry that says what to read from it.</summary>
    private sealed record Target(string SystemId, ResolvedResource Resource, MetricGroup Group);

    public async Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct)
    {
        var all = new Dictionary<string, NodeReading>();
        await PollAsync(registry, found => { lock (all) foreach (var (id, reading) in found) all[id] = reading; }, ct);
        return all;
    }

    /// <summary>
    /// Reads every resource and hands over each system's reading the moment the last of its own resources has been read, so a town with many plans lights
    /// up as the reads finish and one slow or failing read holds back only the systems that use it. A system is never reported from only some of its
    /// resources. When any read fails the poll still ends in an error saying how many, after everything that could be reported has been.
    /// </summary>
    public Task PollAsync(TownRegistry registry, Action<IReadOnlyDictionary<string, NodeReading>> publish, CancellationToken ct) =>
        PollCore(registry, publish, time.GetUtcNow(), false, ct);

    public bool CanReadPast => recording is null;

    /// <summary>
    /// The town's readings as they were at a past time, with the same rules as a live poll. An hour of each resource's series is read in one call and kept, so the frames
    /// of that hour cost no more calls (<see cref="PastChunk"/>); a resource that cannot be read fails the whole answer, as in a live poll.
    /// </summary>
    public async Task<IReadOnlyDictionary<string, NodeReading>> PollAtAsync(TownRegistry registry, DateTimeOffset at, CancellationToken ct)
    {
        var all = new Dictionary<string, NodeReading>();
        await PollCore(registry, found => { lock (all) foreach (var (id, reading) in found) all[id] = reading; }, at, true, ct);
        return all;
    }

    private readonly Dictionary<(string Resource, MetricGroup Group, DateTimeOffset Chunk, TimeSpan Length), Task<IReadOnlyList<MetricSeries>>> _days = [];
    private readonly List<(string Resource, MetricGroup Group, DateTimeOffset Chunk, TimeSpan Length)> _order = [];

    private async Task PollCore(TownRegistry registry, Action<IReadOnlyDictionary<string, NodeReading>> publish, DateTimeOffset at, bool bulk, CancellationToken ct)
    {
        var view = registry.ForEnvironment(environmentId);
        if (store.Inventory is null) await store.WaitForReadAsync(Timeout / 2, ct); // the resources to read are in the inventory
        var resolution = store.Resolve(view);
        var targets = resolution.Systems.SelectMany(s => s.Resources.SelectMany(r => _settings.Metrics.Where(g => g.Resources == r.Rule).Select(g => new Target(s.SystemId, r, g)))).ToList();
        if (targets.Count == 0) return;

        var recorded = recording is null ? null : ReadRecording(await File.ReadAllTextAsync(recording, ct));
        var gate = new SemaphoreSlim(MaxParallel);
        var errors = new List<string>();
        var names = resolution.TenantNames.ToDictionary(t => t.Id, t => t.Name);
        var seriesOf = new Dictionary<(string, MetricGroup), IReadOnlyList<MetricSeries>>();
        // for each system the reads it waits for; a read that fails is never marked done, so the systems that use it are not reported
        var waiting = targets.GroupBy(t => t.SystemId).ToDictionary(g => g.Key, g => g.Select(t => (t.Resource.Id, t.Group)).ToHashSet());
        var wanted = targets.GroupBy(t => t.SystemId).ToDictionary(g => g.Key, g => g.ToList());
        var usedBy = targets.SelectMany(t => new[] { (Key: (t.Resource.Id, t.Group), t.SystemId) }).GroupBy(x => x.Key).ToDictionary(g => g.Key, g => g.Select(x => x.SystemId).Distinct().ToList());

        async Task Read(Target target)
        {
            IReadOnlyList<MetricSeries> series;
            if (recorded is not null) series = recorded.GetValueOrDefault(target.Resource.Name) ?? [];
            else
            {
                await gate.WaitAsync(ct);
                try { series = bulk ? await ReadResourceDay(target, at, ct) : await ReadResource(target, at, ct); }
                catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
                {
                    lock (errors) errors.Add(e.Message);
                    return;
                }
                finally { gate.Release(); }
            }
            var ready = new Dictionary<string, NodeReading>();
            lock (seriesOf)
            {
                var key = (target.Resource.Id, target.Group);
                seriesOf[key] = series;
                foreach (var systemId in usedBy[key])
                {
                    waiting[systemId].Remove(key);
                    if (waiting[systemId].Count > 0) continue;
                    var read = wanted[systemId].Select(t => (Target: t, Series: seriesOf[(t.Resource.Id, t.Group)])).ToList();
                    if (Reading(read, names, at) is { } reading) ready[systemId] = reading;
                }
            }
            if (ready.Count > 0) publish(ready);
        }
        // a plan that several systems share is read once
        var unique = targets.DistinctBy(t => (t.Resource.Id, t.Group)).ToList();
        if (bulk && recorded is null && _settings.BatchMetrics) await PrefetchBatches(unique, at, ct); // only the past: a live poll reads each resource as it always did
        await Task.WhenAll(unique.Select(Read));
        if (errors.Count > 0)
            throw new HttpRequestException($"{errors.Count} of {unique.Count} resource reads failed, so the systems that use them were not reported this time; the first: {errors[0]}");
    }

    /// <summary>One system's reading from the series of all its resources, or null when none of its signals has a number.</summary>
    private NodeReading? Reading(List<(Target Target, IReadOnlyList<MetricSeries> Series)> system, Dictionary<string, string> names, DateTimeOffset at)
    {
        var values = system.Select(r => Values(r.Target, r.Series, r.Target.Group.Window ?? Window)).ToList();
        double? Worst(string signal) => Max(values, signal);
        var cpu = Worst("cpu");
        var memory = Worst("memory");
        var utilisation = Worst("utilisation");
        var throttled = Worst("throttled");
        if (cpu is null && memory is null && utilisation is null && throttled is null) return null;
        var tenants = values.Where(v => v.Tenant is not null).GroupBy(v => v.Tenant!)
            .Select(g => new TenantReading(g.Key, Max(g, "utilisation"), Max(g, "throttled"), g.Sum(v => v.Signals.GetValueOrDefault("requests") ?? 0), names.GetValueOrDefault(g.Key), Max(g, "limit"), g.Any(v => v.Idle?.Contains("utilisation") == true) ? true : null, PartsOf(g))).ToList();
        // each region's own CPU and memory, for the resources that report them and say where they are
        var regions = values.Where(v => v.Region is not null && (v.Signals.ContainsKey("cpu") || v.Signals.ContainsKey("memory"))).GroupBy(v => v.Region!, StringComparer.OrdinalIgnoreCase)
            .Select(g => new RegionReading(g.Key, null, Max(g, "cpu"), Max(g, "memory"))).OrderBy(r => r.Region, StringComparer.Ordinal).ToList();
        return new NodeReading(at, true, 0, 0, 0, 0, 0, 0, cpu, memory, utilisation, throttled, Tenants: tenants.Count == 0 ? null : tenants, Regions: regions.Count == 0 ? null : regions);
    }

    /// <summary>A tenant's parts from its resources' (usually one): a part of the same kind and name in several of them is as busy as its busiest. Null when no resource was split.</summary>
    private static IReadOnlyList<PartReading>? PartsOf(IEnumerable<ResourceValues> resources)
    {
        var parts = resources.SelectMany(r => r.Parts ?? []).GroupBy(p => (p.Kind, Name: p.Name.ToLowerInvariant()))
            .Select(g => new PartReading(g.First().Name, g.Key.Kind, MaxOf(g, "utilisation"), MaxOf(g, "throttled"), g.Sum(p => p.Signals.GetValueOrDefault("requests") ?? 0), MaxOf(g, "limit"),
                g.Any(p => p.Idle?.Contains("utilisation") == true) ? true : null)).ToList();
        return parts.Count == 0 ? null : parts;
    }

    private static double? MaxOf(IEnumerable<PartValues> parts, string signal)
    {
        var asked = parts.Where(p => p.Signals.ContainsKey(signal)).Select(p => p.Signals[signal]).ToList();
        return asked.Count == 0 || asked.Any(x => x is null) ? null : asked.Max(x => x!.Value);
    }

    /// <summary>
    /// The highest value of a signal over the resources that were asked for it. If any of them gave none the whole is unknown: the one without a number
    /// could be the one in trouble. Null too when no resource was asked.
    /// </summary>
    private static double? Max(IEnumerable<ResourceValues> values, string signal)
    {
        var asked = values.Where(v => v.Signals.ContainsKey(signal)).Select(v => v.Signals[signal]).ToList();
        return asked.Count == 0 || asked.Any(x => x is null) ? null : asked.Max(x => x!.Value);
    }

    /// <summary>One resource's numbers. Idle names the signals that had no number but are set to count as 0 then (<c>whenEmpty: idle</c>).</summary>
    private sealed record ResourceValues(string? Tenant, IReadOnlyDictionary<string, double?> Signals, string? Region = null, IReadOnlySet<string>? Idle = null, IReadOnlyList<PartValues>? Parts = null);

    /// <summary>One part of a resource: the shared pool (empty name) or one piece with capacity of its own, with the same signals a whole resource has.</summary>
    private sealed record PartValues(string Name, PartKind Kind, IReadOnlyDictionary<string, double?> Signals, IReadOnlySet<string>? Idle);

    /// <summary>The metric specs of an entry with the call each needs. Specs that agree on namespace, aggregation and filter are asked together.</summary>
    private static IEnumerable<(MetricCall Call, IReadOnlyList<string> Metrics)> Calls(MetricGroup group) =>
        group.Signals.Values.SelectMany(Flatten).Concat(group.Parts is null ? [] : [group.Parts.Own])
            .GroupBy(s => MetricCall.Of(group.Namespace, s, group.Interval))
            .Select(g => (g.Key, (IReadOnlyList<string>)g.Select(s => s.Metric).Distinct(StringComparer.OrdinalIgnoreCase).ToList()));

    /// <summary>A signal's metric and the metrics it divides by or falls back to, each of which needs reading.</summary>
    private static IEnumerable<MetricSignal> Flatten(MetricSignal s) =>
        new[] { s }.Concat(s.Over is null ? [] : Flatten(s.Over)).Concat(s.OrElse is null ? [] : Flatten(s.OrElse));

    /// <summary>
    /// How much time one read of a resource's platform metrics covers when the past is rebuilt: three hours, so the 36 frames of them cost one read. Chunks sit on the clock (00 to 03, 03 to 06, ...).
    /// A read that Azure answers with "response size exceeded maximum limit" (8 MB) is read again in <see cref="SmallChunk"/> pieces, and that resource stays on them.
    /// </summary>
    public static readonly TimeSpan PastChunk = TimeSpan.FromHours(3);

    /// <summary>The piece a read falls back to when the answer for <see cref="PastChunk"/> was too big.</summary>
    public static readonly TimeSpan SmallChunk = TimeSpan.FromHours(1);

    /// <summary>The start of the chunk a time falls in (the end of a chunk belongs to the chunk that ended).</summary>
    public static DateTimeOffset MetricChunk(DateTimeOffset at, TimeSpan chunk) => new(at.UtcDateTime.Ticks / chunk.Ticks * chunk.Ticks, TimeSpan.Zero);

    /// <summary>How many chunks a source keeps read: the frames of an hour are built one after the other, and a fill moves from one chunk to the one before it, so the one being used and the last one are enough.</summary>
    public const int ChunksKept = 2;

    /// <summary>
    /// Forgets what was read, keeping the <see cref="ChunksKept"/> chunks that were read last. <paramref name="order"/> lists the keys in the order they were read, and <paramref name="chunkOf"/> says which chunk a key is of.
    /// The newest chunks by the clock are not the ones to keep: a fill goes back in time, so the chunk it is reading is the oldest one it has.
    /// </summary>
    public static void Trim<TKey, TValue>(Dictionary<TKey, TValue> cache, List<TKey> order, Func<TKey, DateTimeOffset> chunkOf) where TKey : notnull
    {
        var keep = new HashSet<DateTimeOffset>();
        for (var i = order.Count - 1; i >= 0 && keep.Count < ChunksKept; i--) keep.Add(chunkOf(order[i]));
        foreach (var key in order.Where(k => !keep.Contains(chunkOf(k))).ToList()) { cache.Remove(key); order.Remove(key); }
    }

    /// <summary>Whether Azure refused a read because the answer would be over its 8 MB.</summary>
    public static bool IsTooLarge(Exception e) => e is HttpRequestException { StatusCode: System.Net.HttpStatusCode.BadRequest } h && h.Message.Contains("response size", StringComparison.OrdinalIgnoreCase);

    private readonly HashSet<string> _small = [];
    private int _hits;
    private int _splits;
    private int _batched;
    private int _singly;
    private string? _batchNote;
    private readonly Dictionary<string, (double Seconds, int Reads)> _groupSpent = [];

    /// <summary>What a group of metrics is called in the log: the resources it is for, the signals it reads and the dimension it splits by.</summary>
    public static string GroupName(MetricGroup group) =>
        $"{group.Resources}: {string.Join('+', group.Signals.Keys)}{(group.Parts is null ? "" : $"{(group.Signals.Count > 0 ? " " : "")}by {group.Parts.By}")}";

    /// <summary>Runs a read of the past and adds the time it took to its group, so the log can say where the time of an hour went.</summary>
    private async Task<T> Timed<T>(MetricGroup group, Func<Task<T>> read)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        try { return await read(); }
        finally
        {
            var name = GroupName(group);
            lock (_groupSpent) _groupSpent[name] = _groupSpent.TryGetValue(name, out var was) ? (was.Seconds + clock.Elapsed.TotalSeconds, was.Reads + 1) : (clock.Elapsed.TotalSeconds, 1);
        }
    }

    /// <summary>What was read for the past since the last call, for the log of a rebuilt hour.</summary>
    public PastReadStats TakeStats()
    {
        var (calls, bytes) = reader.TakeCounts();
        string? note;
        lock (_days) { note = _batchNote; _batchNote = null; }
        List<PastGroupSpent> groups;
        lock (_groupSpent) { groups = _groupSpent.Select(g => new PastGroupSpent(g.Key, g.Value.Seconds, g.Value.Reads)).OrderByDescending(g => g.Seconds).ToList(); _groupSpent.Clear(); }
        return new PastReadStats(calls, Interlocked.Exchange(ref _hits, 0), bytes / 1_048_576.0, Interlocked.Exchange(ref _splits, 0), Interlocked.Exchange(ref _batched, 0), Interlocked.Exchange(ref _singly, 0), note, groups);
    }

    /// <summary>The steps a batch is made smaller by when Azure refuses it: 50 resources, then 25, then 10. Below that the resources are read one by one.</summary>
    public static readonly int[] BatchSizes = [AzureMonitorReader.BatchLimit, 25, 10];

    private readonly Dictionary<DateTimeOffset, Task> _prefetched = [];
    private readonly List<DateTimeOffset> _prefetchOrder = [];
    private readonly HashSet<(string Resource, MetricGroup Group, DateTimeOffset Chunk, TimeSpan Length)> _fresh = [];

    private static readonly System.Text.RegularExpressions.Regex SubscriptionOf = new(@"^/subscriptions/(?<id>[0-9A-Za-z-]+)/", System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly System.Text.RegularExpressions.Regex LocationName = new("^[a-z0-9]+$", System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>
    /// Reads the three hours of many resources in a few calls instead of one call for each: resources of one subscription, region and metric namespace go 50 at a time to the batch endpoint,
    /// and what comes back is kept as if each had been read alone. A batch Azure refuses or answers badly is made smaller (25, then 10); what still cannot be read that way is simply left
    /// for the read of one resource, which is how it was always read, so a failure here only makes the hour slower. Frames of an hour that are built together share one prefetch.
    /// </summary>
    private async Task PrefetchBatches(List<Target> targets, DateTimeOffset at, CancellationToken ct)
    {
        var chunk = MetricChunk(at.AddTicks(-1), PastChunk);
        Task work;
        lock (_days)
        {
            if (!_prefetched.TryGetValue(chunk, out work!))
            {
                _prefetched[chunk] = work = PrefetchChunk(targets, chunk, ct);
                _prefetchOrder.Add(chunk);
                while (_prefetchOrder.Count > ChunksKept + 1) { _prefetched.Remove(_prefetchOrder[0]); _prefetchOrder.RemoveAt(0); }
            }
        }
        try { await work; }
        catch (OperationCanceledException)
        {
            lock (_days) { _prefetched.Remove(chunk); _prefetchOrder.Remove(chunk); } // a read that was cancelled is asked again next time
            throw;
        }
    }

    private async Task PrefetchChunk(List<Target> targets, DateTimeOffset chunk, CancellationToken ct)
    {
        var locations = (store.Inventory?.Resources ?? []).Where(r => r.Region is { Length: > 0 }).GroupBy(r => r.Id, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First().Region!.ToLowerInvariant(), StringComparer.OrdinalIgnoreCase);
        var wanted = new List<(Target Target, string Subscription, string Location, string Namespace)>();
        foreach (var t in targets)
        {
            bool known;
            lock (_days) known = _small.Contains(t.Resource.Id) || _days.ContainsKey((t.Resource.Id, t.Group, chunk, PastChunk));
            if (known || t.Group.Signals.Count == 0 && t.Group.Parts is null) continue;
            var ns = t.Group.Namespace ?? t.Resource.Type;
            if (string.IsNullOrWhiteSpace(ns) || !locations.TryGetValue(t.Resource.Id, out var location) || !LocationName.IsMatch(location)) continue;
            if (SubscriptionOf.Match(t.Resource.Id) is not { Success: true } sub) continue;
            wanted.Add((t, sub.Groups["id"].Value, location, ns));
        }
        var refused = false; // the batch endpoint is not open to this login: the rest are read one by one without asking again
        foreach (var bucket in wanted.GroupBy(w => (w.Target.Group, w.Subscription, w.Location, Namespace: w.Namespace.ToLowerInvariant())))
            foreach (var part in bucket.Select(w => w.Target).Chunk(BatchSizes[0]))
            {
                if (refused) return;
                refused = !await Timed(bucket.Key.Group, () => ReadBatch(part, bucket.Key.Group, bucket.Key.Subscription, bucket.Key.Location, bucket.Key.Namespace, chunk, 0, ct));
            }
    }

    /// <summary>Reads one batch and keeps what it read; false when the batch cannot be read at all (the login or the endpoint is refused), so the caller stops asking.</summary>
    private async Task<bool> ReadBatch(IReadOnlyList<Target> part, MetricGroup group, string subscription, string location, string metricNamespace, DateTimeOffset chunk, int size, CancellationToken ct)
    {
        var window = group.Window ?? Window;
        try
        {
            var per = part.ToDictionary(t => t.Resource.Id, _ => new List<MetricSeries>(), StringComparer.OrdinalIgnoreCase);
            var alone = new HashSet<string>(StringComparer.OrdinalIgnoreCase); // resources the batch has no usable answer for: each is read on its own, the rest keep their answer
            foreach (var (call, metrics) in Calls(group))
            {
                var answer = await reader.ReadBatchAsync(part.Select(t => t.Resource.Id).ToList(), location, subscription, metricNamespace, call, metrics, group.Parts?.By, chunk + PastChunk, PastChunk + window, ct);
                foreach (var t in part)
                {
                    if (alone.Contains(t.Resource.Id)) continue;
                    // a resource the answer says nothing about, or cut at the most series, is not taken from the batch
                    if (!answer.TryGetValue(t.Resource.Id.TrimEnd('/'), out var one) || one.Cut) { alone.Add(t.Resource.Id); continue; }
                    per[t.Resource.Id].AddRange(one.Series);
                    // a metric Azure leaves out has no data (a quiet account), which is no failure: it reads as the same empty series that a read of the resource alone gives
                    if (group.Parts is null)
                        foreach (var m in metrics.Where(m => !one.Series.Any(s => s.Metric.Equals(m, StringComparison.OrdinalIgnoreCase))))
                            per[t.Resource.Id].Add(new MetricSeries(m, call.Aggregation, call.Filter, new List<double>(), null, new List<DateTimeOffset>()));
                }
            }
            lock (_days)
                foreach (var t in part)
                {
                    if (alone.Contains(t.Resource.Id)) continue;
                    var key = (t.Resource.Id, t.Group, chunk, PastChunk);
                    if (_days.ContainsKey(key)) continue;
                    _days[key] = Task.FromResult<IReadOnlyList<MetricSeries>>(per[t.Resource.Id]);
                    _order.Add(key);
                    _fresh.Add(key);
                }
            lock (_days) Trim(_days, _order, k => k.Chunk);
            Interlocked.Add(ref _batched, part.Count - alone.Count);
            Interlocked.Add(ref _singly, alone.Count);
            return true;
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            lock (_days) _batchNote ??= e.Message.Length <= 200 ? e.Message : e.Message[..200] + "...";
            var refused = e is HttpRequestException { StatusCode: System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden or System.Net.HttpStatusCode.NotFound };
            if (!refused && size + 1 < BatchSizes.Length)
            {
                var ok = true;
                foreach (var smaller in part.Chunk(BatchSizes[size + 1]))
                    ok &= await ReadBatch(smaller, group, subscription, location, metricNamespace, chunk, size + 1, ct);
                return ok;
            }
            Interlocked.Add(ref _singly, part.Count);
            return !refused; // refused: the batch endpoint is not open to this login, so do not ask again for the rest; the resources are read one by one
        }
    }

    /// <summary>The series that were read for the window ending at <paramref name="at"/>, cut out of the hour's one read (the hour is read once, from the window before its first frame to its end).</summary>
    private async Task<IReadOnlyList<MetricSeries>> ReadResourceDay(Target target, DateTimeOffset at, CancellationToken ct)
    {
        var window = target.Group.Window ?? Window;
        bool small;
        lock (_days) small = _small.Contains(target.Resource.Id);
        var length = small ? SmallChunk : PastChunk;
        var chunk = MetricChunk(at.AddTicks(-1), length); // a frame on the hour sharp belongs to the chunk that ended
        var key = (target.Resource.Id, target.Group, chunk, length);
        Task<IReadOnlyList<MetricSeries>> read;
        lock (_days)
        {
            if (!_days.TryGetValue(key, out read!))
            {
                _days[key] = read = Timed(target.Group, () => ReadResourceWindow(target, chunk + length, length + window, ct));
                _order.Add(key);
                Trim(_days, _order, k => k.Chunk);
            }
            else if (!_fresh.Remove(key)) Interlocked.Increment(ref _hits); // the first use of what a batch read is not a frame answered from before
        }
        IReadOnlyList<MetricSeries> whole;
        try { whole = await read; }
        catch (Exception e)
        {
            lock (_days)
                if (_days.TryGetValue(key, out var kept) && ReferenceEquals(kept, read)) { _days.Remove(key); _order.Remove(key); }
            if (!small && IsTooLarge(e) && !ct.IsCancellationRequested)
            {
                lock (_days) _small.Add(target.Resource.Id);
                Interlocked.Increment(ref _splits);
                return await ReadResourceDay(target, at, ct); // the same read in pieces of an hour
            }
            throw; // a read that failed is asked again next time, not remembered as failed
        }
        return AtWindow(whole, at - window, at);
    }

    /// <summary>The points of each series that start inside [from, to); a series without times (a recording) is kept whole.</summary>
    public static IReadOnlyList<MetricSeries> AtWindow(IReadOnlyList<MetricSeries> series, DateTimeOffset from, DateTimeOffset to) =>
        series.Select(s =>
        {
            if (s.Times is null || s.Times.Count != s.Points.Count || s.Times.Any(t => t == DateTimeOffset.MinValue)) return s;
            var keep = Enumerable.Range(0, s.Points.Count).Where(i => s.Times[i] >= from && s.Times[i] < to).ToList();
            return s with { Points = keep.Select(i => s.Points[i]).ToList(), Times = keep.Select(i => s.Times[i]).ToList() };
        }).ToList();

    private Task<IReadOnlyList<MetricSeries>> ReadResourceWindow(Target target, DateTimeOffset end, TimeSpan span, CancellationToken ct) =>
        ReadResource(target, end, ct, span);

    private async Task<IReadOnlyList<MetricSeries>> ReadResource(Target target, DateTimeOffset at, CancellationToken ct, TimeSpan? over = null)
    {
        var all = new List<MetricSeries>();
        var window = over ?? target.Group.Window ?? Window;
        foreach (var (call, metrics) in Calls(target.Group))
        {
            if (target.Group.Parts is not { } parts) { all.AddRange(await reader.ReadAsync(target.Resource.Id, call, metrics, at, window, ct)); continue; }
            try { all.AddRange(await reader.ReadByPartAsync(target.Resource.Id, call, metrics, parts.By, at, window, ct)); }
            // a metric that has no such dimension is refused: read it as a whole, so the resource is shown without parts rather than not at all
            // (an answer that was only too big is not that: it fails, and the past is read in smaller pieces)
            catch (HttpRequestException e) when (e.StatusCode == System.Net.HttpStatusCode.BadRequest && !IsTooLarge(e))
            {
                all.AddRange(await reader.ReadAsync(target.Resource.Id, call, metrics, at, window, ct));
            }
        }
        return all;
    }

    private static ResourceValues Values(Target target, IReadOnlyList<MetricSeries> series, TimeSpan window)
    {
        var (signals, idle) = Compute(target.Group, series, window);
        var parts = target.Group.Parts is { } config ? PartsOf(target.Group, config, series, window) : null;
        // a database split into parts turns away what its worst part turns away: as a share of all its requests one throttling part would hide among the busy ones
        if (parts is { Count: > 0 } && signals.ContainsKey("throttled") && parts.Select(p => p.Signals.GetValueOrDefault("throttled")).Where(x => x is not null).Select(x => x!.Value).DefaultIfEmpty(-1).Max() is var worst and >= 0)
            signals["throttled"] = Math.Max(signals["throttled"] ?? 0, worst);
        return new ResourceValues(target.Resource.Tenant, signals, target.Resource.Region, idle.Count == 0 ? null : idle, parts is { Count: > 0 } ? parts : null);
    }

    /// <summary>The numbers of every signal of an entry from the series that were read for it (all of a resource's, or those of one part).</summary>
    private static (Dictionary<string, double?> Signals, HashSet<string> Idle) Compute(MetricGroup group, IReadOnlyList<MetricSeries> series, TimeSpan window)
    {
        double? Own(MetricSignal spec) =>
            AzureMonitorReader.Reduce(series.Where(s => Same(s, spec)).SelectMany(s => s.Points).ToList(), spec.Aggregation);
        // a metric with no number or 0 gives way to its orElse, when it has one
        double? Of(MetricSignal spec) => Own(spec) is { } own && (own > 0 || spec.OrElse is null) ? own : spec.OrElse is { } alt ? Of(alt) ?? Own(spec) : Own(spec);

        var signals = new Dictionary<string, double?>();
        var idle = new HashSet<string>();
        foreach (var (signal, spec) in group.Signals)
        {
            var value = Of(spec);
            // a filter that matches nothing (no 429 at all) gives no points, which is none of them, not a gap: when the whole it is a share of has points, the share is zero
            if (value is null && spec.Over is { } whole && spec.Aggregation is "total" or "count" && Of(whole) > 0) value = 0;
            if (value is not null && spec.Over is { } over)
                value = Of(over) is { } divisor && divisor > 0 ? value / divisor : null;
            if (value is not null && spec.PerSecond) value /= window.TotalSeconds;
            if (value is not null) value *= spec.Scale;
            if (value is not null && signal is "cpu" or "memory" or "utilisation" or "throttled") value = Math.Clamp(value.Value, 0, 1);
            // the read worked and gave no number: for a signal set to whenEmpty idle that means nothing happened, so 0 (a failed read never gets here, it throws)
            if (value is null && spec.EmptyIsIdle) { value = 0; idle.Add(signal); }
            signals[signal] = value is null ? null : Math.Max(0, value.Value);
        }
        return (signals, idle);
    }

    /// <summary>
    /// The parts of a resource from its split series: each piece that has a value of its own in the ownThroughput metric (and is not the pool's own series) is a dedicated part;
    /// every other named piece draws on the shared pool and is merged into one shared part. A series with no name (traffic of the account as a whole) belongs to no part.
    /// </summary>
    private static List<PartValues> PartsOf(MetricGroup group, PartsConfig config, IReadOnlyList<MetricSeries> series, TimeSpan window)
    {
        var named = series.Where(s => !string.IsNullOrEmpty(s.Part)).ToList();
        bool IsPool(string name) => config.Pool is not null && string.Equals(name, config.Pool, StringComparison.OrdinalIgnoreCase);
        var dedicated = named.Where(s => !IsPool(s.Part!) && Same(s, config.Own) && s.Points.Count > 0).Select(s => s.Part!).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.Ordinal).ToList();
        var result = new List<PartValues>();
        var shared = named.Where(s => !dedicated.Contains(s.Part!, StringComparer.OrdinalIgnoreCase)).ToList();
        if (shared.Count > 0)
        {
            var (signals, idle) = Compute(group, shared, window);
            result.Add(new PartValues("", PartKind.Shared, signals, idle.Count == 0 ? null : idle));
        }
        foreach (var name in dedicated)
        {
            var (signals, idle) = Compute(group, named.Where(s => string.Equals(s.Part, name, StringComparison.OrdinalIgnoreCase)).ToList(), window);
            result.Add(new PartValues(name, PartKind.Dedicated, signals, idle.Count == 0 ? null : idle));
        }
        return result;
    }

    private static bool Same(MetricSeries s, MetricSignal spec) =>
        s.Metric.Equals(spec.Metric, StringComparison.OrdinalIgnoreCase) && s.Aggregation.Equals(spec.Aggregation, StringComparison.OrdinalIgnoreCase) &&
        string.Equals(string.IsNullOrWhiteSpace(s.Filter) ? null : s.Filter, spec.Filter, StringComparison.OrdinalIgnoreCase);

    public static IReadOnlyDictionary<string, IReadOnlyList<MetricSeries>> ReadRecording(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var result = new Dictionary<string, IReadOnlyList<MetricSeries>>(StringComparer.OrdinalIgnoreCase);
        foreach (var resource in doc.RootElement.EnumerateObject())
            result[resource.Name] = resource.Value.EnumerateArray().Select(e => new MetricSeries(
                e.GetProperty("metric").GetString() ?? "",
                e.TryGetProperty("aggregation", out var a) ? a.GetString() ?? "average" : "average",
                e.TryGetProperty("filter", out var f) && f.ValueKind == JsonValueKind.String ? f.GetString() : null,
                e.GetProperty("points").EnumerateArray().Select(p => p.GetDouble()).ToList())).ToList();
        return result;
    }
}

public sealed class AzureMonitorSourceFactory(HttpClient? http = null, TimeProvider? time = null) : IMetricSourceFactory
{
    public const string SourceKind = "azuremonitor";

    public string Kind => SourceKind;

    public IMetricSource Create(SourceContext context)
    {
        if (AzureSettings.Of(context.Source).Metrics.Count == 0)
            throw new InvalidOperationException("it has no metrics. List the metrics to read under metrics: which scope.resources rule they are for, and which metric fills which signal (see docs/connect-your-company.md)");
        var connection = context.Source.Connection ?? "";
        string? recording = null;
        if (connection.StartsWith(ResourceGraphSourceFactory.RecordingPrefix, StringComparison.OrdinalIgnoreCase))
        {
            var file = connection[ResourceGraphSourceFactory.RecordingPrefix.Length..].Trim();
            recording = Path.IsPathRooted(file) || context.RegistryFolder is null ? file : Path.Combine(context.RegistryFolder, file);
            if (!File.Exists(recording)) throw new InvalidOperationException($"the recording {file} does not exist");
        }
        return new AzureMonitorSource(context.Source.Name, context.EnvironmentId, context.Source, new AzureMonitorReader(http ?? Shared, context.Credential),
            context.Scope ?? new ScopeStore(), recording, time ?? TimeProvider.System);
    }

    private static readonly HttpClient Shared = new();
}
