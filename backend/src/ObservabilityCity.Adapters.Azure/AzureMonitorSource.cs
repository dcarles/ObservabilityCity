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

/// <summary>The points one metric gave over the window, as asked: this metric, added up this way, with this filter. No point is a gap the cloud left, not a zero.</summary>
public sealed record MetricSeries(string Metric, string Aggregation, string? Filter, IReadOnlyList<double> Points);

/// <summary>
/// Reads platform metrics of single resources from the Azure Monitor metrics API. The adapter knows no metric: which ones to ask for, for which
/// resources, and what they mean comes from the environment's <c>metrics</c> entries.
/// </summary>
public sealed class AzureMonitorReader(HttpClient http, ICredentialSource? credential)
{
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
        using var request = new HttpRequestMessage(HttpMethod.Get, Url(resourceId, call, metrics, end, window));
        if (credential is not null)
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await credential.GetTokenAsync(TokenScope, ct));
        using var response = await http.SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"Azure Monitor answered {(int)response.StatusCode} {response.ReasonPhrase} for {Last(resourceId)}: {Trim(text)}");
        return Parse(text, call);
    }

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
            if (metric.TryGetProperty("timeseries", out var all) && all.ValueKind == JsonValueKind.Array)
                foreach (var one in all.EnumerateArray())
                    if (one.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
                        foreach (var point in data.EnumerateArray())
                            if (point.TryGetProperty(field, out var number) && number.ValueKind == JsonValueKind.Number && number.TryGetDouble(out var d) && double.IsFinite(d))
                                points.Add(d);
            series.Add(new MetricSeries(name, call.Aggregation, call.Filter, points));
        }
        return series;
    }

    /// <summary>The points added up the way the aggregation says: the average of averages, the sum of totals and counts, the highest maximum, the lowest minimum. Null with no point.</summary>
    public static double? Reduce(IReadOnlyList<double> points, string aggregation)
    {
        if (points.Count == 0) return null;
        return aggregation.ToLowerInvariant() switch
        {
            "total" or "count" => points.Sum(),
            "maximum" => points.Max(),
            "minimum" => points.Min(),
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
    string name, string environmentId, RegistrySource definition, AzureMonitorReader reader, ScopeStore store, string? recording, TimeProvider time) : IMetricSource
{
    public const int MaxParallel = 8;

    public string Name => name;
    public TimeSpan PollInterval => definition.PollInterval;
    public TimeSpan Timeout => definition.Timeout;
    public TimeSpan Window { get; } = SourceQuery.WindowOf(definition);

    /// <summary>One resource of one system and the entry that says what to read from it.</summary>
    private sealed record Target(string SystemId, ResolvedResource Resource, MetricGroup Group);

    public async Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct)
    {
        var view = registry.ForEnvironment(environmentId);
        if (store.Inventory is null) await store.WaitForReadAsync(Timeout / 2, ct); // the resources to read are in the inventory
        var resolution = store.Resolve(view);
        var targets = resolution.Systems.SelectMany(s => s.Resources.SelectMany(r => definition.Metrics.Where(g => g.Resources == r.Rule).Select(g => new Target(s.SystemId, r, g)))).ToList();
        if (targets.Count == 0) return new Dictionary<string, NodeReading>();

        var at = time.GetUtcNow();
        var recorded = recording is null ? null : ReadRecording(await File.ReadAllTextAsync(recording, ct));
        var gate = new SemaphoreSlim(MaxParallel);
        var errors = new List<string>();
        async Task<(Target Target, IReadOnlyList<MetricSeries> Series)> Read(Target target)
        {
            if (recorded is not null) return (target, recorded.GetValueOrDefault(target.Resource.Name) ?? []);
            await gate.WaitAsync(ct);
            try { return (target, await ReadResource(target, at, ct)); }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                lock (errors) errors.Add(e.Message);
                return (target, []);
            }
            finally { gate.Release(); }
        }
        // a plan that several systems share is read once
        var unique = targets.DistinctBy(t => (t.Resource.Id, t.Group)).ToList();
        var done = await Task.WhenAll(unique.Select(Read));
        if (errors.Count > 0)
            throw new HttpRequestException($"{errors.Count} of {unique.Count} resource reads failed, so nothing was reported this time; the first: {errors[0]}");
        var seriesOf = done.ToDictionary(d => (d.Target.Resource.Id, d.Target.Group), d => d.Series);
        var read = targets.Select(t => (Target: t, Series: seriesOf[(t.Resource.Id, t.Group)])).ToList();

        var names = resolution.TenantNames.ToDictionary(t => t.Id, t => t.Name);
        var readings = new Dictionary<string, NodeReading>();
        foreach (var system in read.GroupBy(r => r.Target.SystemId))
        {
            var values = system.Select(r => Values(r.Target, r.Series, r.Target.Group.Window ?? Window)).ToList();
            double? Worst(string signal) => Max(values, signal);
            var cpu = Worst("cpu");
            var memory = Worst("memory");
            var utilisation = Worst("utilisation");
            var throttled = Worst("throttled");
            if (cpu is null && memory is null && utilisation is null && throttled is null) continue;
            var tenants = values.Where(v => v.Tenant is not null).GroupBy(v => v.Tenant!)
                .Select(g => new TenantReading(g.Key, Max(g, "utilisation"), Max(g, "throttled"), g.Sum(v => v.Signals.GetValueOrDefault("requests") ?? 0), names.GetValueOrDefault(g.Key), Max(g, "limit"))).ToList();
            readings[system.Key] = new NodeReading(at, true, 0, 0, 0, 0, 0, 0, cpu, memory, utilisation, throttled, Tenants: tenants.Count == 0 ? null : tenants);
        }
        return readings;
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

    private sealed record ResourceValues(string? Tenant, IReadOnlyDictionary<string, double?> Signals);

    /// <summary>The metric specs of an entry with the call each needs. Specs that agree on namespace, aggregation and filter are asked together.</summary>
    private static IEnumerable<(MetricCall Call, IReadOnlyList<string> Metrics)> Calls(MetricGroup group) =>
        group.Signals.Values.SelectMany(Flatten)
            .GroupBy(s => MetricCall.Of(group.Namespace, s, group.Interval))
            .Select(g => (g.Key, (IReadOnlyList<string>)g.Select(s => s.Metric).Distinct(StringComparer.OrdinalIgnoreCase).ToList()));

    /// <summary>A signal's metric and the metrics it divides by or falls back to, each of which needs reading.</summary>
    private static IEnumerable<MetricSignal> Flatten(MetricSignal s) =>
        new[] { s }.Concat(s.Over is null ? [] : Flatten(s.Over)).Concat(s.OrElse is null ? [] : Flatten(s.OrElse));

    private async Task<IReadOnlyList<MetricSeries>> ReadResource(Target target, DateTimeOffset at, CancellationToken ct)
    {
        var all = new List<MetricSeries>();
        foreach (var (call, metrics) in Calls(target.Group))
            all.AddRange(await reader.ReadAsync(target.Resource.Id, call, metrics, at, target.Group.Window ?? Window, ct));
        return all;
    }

    private static ResourceValues Values(Target target, IReadOnlyList<MetricSeries> series, TimeSpan window)
    {
        double? Own(MetricSignal spec) =>
            AzureMonitorReader.Reduce(series.Where(s => Same(s, spec)).SelectMany(s => s.Points).ToList(), spec.Aggregation);
        // a metric with no number or 0 gives way to its orElse, when it has one
        double? Of(MetricSignal spec) => Own(spec) is { } own && (own > 0 || spec.OrElse is null) ? own : spec.OrElse is { } alt ? Of(alt) ?? Own(spec) : Own(spec);

        var signals = new Dictionary<string, double?>();
        foreach (var (signal, spec) in target.Group.Signals)
        {
            var value = Of(spec);
            // a filter that matches nothing (no 429 at all) gives no points, which is none of them, not a gap: when the whole it is a share of has points, the share is zero
            if (value is null && spec.Over is { } whole && spec.Aggregation is "total" or "count" && Of(whole) > 0) value = 0;
            if (value is not null && spec.Over is { } over)
                value = Of(over) is { } divisor && divisor > 0 ? value / divisor : null;
            if (value is not null && spec.PerSecond) value /= window.TotalSeconds;
            if (value is not null) value *= spec.Scale;
            if (value is not null && signal is "cpu" or "memory" or "utilisation" or "throttled") value = Math.Clamp(value.Value, 0, 1);
            signals[signal] = value is null ? null : Math.Max(0, value.Value);
        }
        return new ResourceValues(target.Resource.Tenant, signals);
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
    public string Kind => "azuremonitor";

    public IMetricSource Create(SourceContext context)
    {
        if (context.Source.Metrics.Count == 0)
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
