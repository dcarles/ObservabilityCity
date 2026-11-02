using System.Text.Json;
using System.Text.RegularExpressions;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>
/// The message broker's backlog and dead letters, read from the platform metrics of its namespaces split by entity name. The adapter knows no
/// metric and no naming convention: the environment's <c>entities</c> block says which rule finds the namespaces, which metric is the backlog and
/// which the dead letters, and which patterns turn an entity's name into the pillar and service that read it. Each entity's numbers go to the
/// system that consumes it; a system's backlog is what waits in all its entities, in every namespace (one for each region). A namespace that cannot
/// be read fails the poll, so a number made from only some of the namespaces never reaches the town.
/// <c>file:name.json</c> replays recorded series (<c>{ "&lt;namespace name&gt;": [ { "entity", "metric", "aggregation", "points": [...] } ] }</c>).
/// </summary>
public sealed class ServiceBusSource(
    string name, string environmentId, RegistrySource definition, AzureMonitorReader reader, ScopeStore store, string? recording, TimeProvider time) : IMetricSource
{
    public string Name => name;
    public TimeSpan PollInterval => definition.PollInterval;
    public TimeSpan Timeout => definition.Timeout;
    public TimeSpan Window { get; } = SourceQuery.WindowOf(definition);

    /// <summary>How many entities the last poll found that no pattern claimed or no system consumes. They are left out; this is for the log and for tests.</summary>
    public int Unclaimed { get; private set; }

    public async Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct)
    {
        var config = definition.Entities!;
        var view = registry.ForEnvironment(environmentId);
        if (store.Inventory is null) await store.WaitForReadAsync(Timeout / 2, ct);
        var resolution = store.Resolve(view);
        var namespaces = resolution.Systems.SelectMany(s => s.Resources).Where(r => r.Rule == config.Resources).DistinctBy(r => r.Id).ToList();
        if (namespaces.Count == 0) return new Dictionary<string, NodeReading>();

        var at = time.GetUtcNow();
        var recorded = recording is null ? null : ReadRecording(await File.ReadAllTextAsync(recording, ct));
        var errors = new List<string>();
        var read = new List<EntitySeries>();
        var gate = new SemaphoreSlim(4);
        await Task.WhenAll(namespaces.Select(async ns =>
        {
            await gate.WaitAsync(ct);
            try
            {
                var series = recorded is not null ? recorded.GetValueOrDefault(ns.Name) ?? [] : await ReadNamespace(config, ns, at, ct);
                lock (read) read.AddRange(series);
            }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested) { lock (errors) errors.Add(e.Message); }
            finally { gate.Release(); }
        }));
        if (errors.Count > 0)
            throw new HttpRequestException($"{errors.Count} of {namespaces.Count} namespace reads failed, so no backlog was reported this time; the first: {errors[0]}");

        // an entity's number in one namespace, then the sum over the namespaces that hold an entity of the same name
        var backlog = Reduced(read, config.Backlog);
        var dead = Reduced(read, config.DeadLetter);
        var patterns = config.Patterns.Select(p => (Regex: new Regex(p.Match, RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)), p.Consumer)).ToList();
        var byNode = new Dictionary<string, (double Waiting, double Dead, bool HasWaiting, bool HasDead)>();
        var unclaimed = 0;
        foreach (var entity in backlog.Keys.Union(dead.Keys).Order(StringComparer.Ordinal))
        {
            var node = Consumer(registry, patterns, entity);
            if (node is null) { unclaimed++; continue; }
            var (w, d, hw, hd) = byNode.GetValueOrDefault(node.Id);
            if (backlog.TryGetValue(entity, out var b)) { w += b; hw = true; }
            if (dead.TryGetValue(entity, out var x)) { d += x; hd = true; }
            byNode[node.Id] = (w, d, hw, hd);
        }
        Unclaimed = unclaimed;
        return byNode.ToDictionary(kv => kv.Key, kv => new NodeReading(at, true, 0, 0, 0, 0, 0, 0,
            QueueDepth: kv.Value.HasWaiting ? Math.Round(kv.Value.Waiting) : null, DeadLetters: kv.Value.HasDead ? Math.Round(kv.Value.Dead) : null));
    }

    /// <summary>Each entity's number, added up over the points of each of its series the way the metric says, then summed over the namespaces.</summary>
    private static Dictionary<string, double> Reduced(IEnumerable<EntitySeries> all, EntityMetric? metric)
    {
        var sums = new Dictionary<string, double>(StringComparer.Ordinal);
        if (metric is null) return sums;
        foreach (var series in all.Where(s => s.Metric.Equals(metric.Metric, StringComparison.OrdinalIgnoreCase) && s.Aggregation.Equals(metric.Aggregation, StringComparison.OrdinalIgnoreCase)))
            if (AzureMonitorReader.Reduce(series.Points, metric.Aggregation) is { } value) sums[series.Entity] = sums.GetValueOrDefault(series.Entity) + Math.Max(0, value);
        return sums;
    }

    /// <summary>The system that consumes an entity: the first pattern that matches its name, and in the registry the system of that kind whose pillar and service code the match names.</summary>
    private static RegistryNode? Consumer(TownRegistry registry, List<(Regex Regex, string Consumer)> patterns, string entity)
    {
        foreach (var (regex, consumer) in patterns)
        {
            var match = regex.Match(entity);
            if (!match.Success) continue;
            var pillar = match.Groups["pillar"].Value;
            var service = match.Groups["service"].Value;
            return registry.Groups.Where(g => !g.IsHub && (pillar.Equals(g.Code ?? g.Id, StringComparison.OrdinalIgnoreCase) || pillar.Equals(g.Id, StringComparison.OrdinalIgnoreCase)))
                .SelectMany(g => g.Nodes)
                .FirstOrDefault(n => n.Kind.ToString().Equals(consumer, StringComparison.OrdinalIgnoreCase) && (n.ServiceCode ?? n.Service)?.Equals(service, StringComparison.OrdinalIgnoreCase) == true);
        }
        return null;
    }

    private async Task<IReadOnlyList<EntitySeries>> ReadNamespace(EntitiesConfig config, ResolvedResource ns, DateTimeOffset at, CancellationToken ct)
    {
        var all = new List<EntitySeries>();
        foreach (var group in new[] { config.Backlog, config.DeadLetter }.Where(m => m is not null).GroupBy(m => m!.Aggregation))
        {
            var call = new MetricCall(null, group.Key, null, config.Interval is { } i ? AzureMonitorReader.Iso(i) : AzureMonitorReader.Interval);
            all.AddRange(await reader.ReadByDimensionAsync(ns.Id, call, group.Select(m => m!.Metric).Distinct(StringComparer.OrdinalIgnoreCase).ToList(), config.Dimension, at, Window, ct));
        }
        return all;
    }

    public static IReadOnlyDictionary<string, IReadOnlyList<EntitySeries>> ReadRecording(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var result = new Dictionary<string, IReadOnlyList<EntitySeries>>(StringComparer.OrdinalIgnoreCase);
        foreach (var ns in doc.RootElement.EnumerateObject())
            result[ns.Name] = ns.Value.EnumerateArray().Select(e => new EntitySeries(
                e.GetProperty("entity").GetString() ?? "",
                e.GetProperty("metric").GetString() ?? "",
                e.TryGetProperty("aggregation", out var a) ? a.GetString() ?? "average" : "average",
                e.GetProperty("points").EnumerateArray().Select(p => p.GetDouble()).ToList())).ToList();
        return result;
    }
}

public sealed class ServiceBusSourceFactory(HttpClient? http = null, TimeProvider? time = null) : IMetricSourceFactory
{
    public string Kind => "servicebus";

    public IMetricSource Create(SourceContext context)
    {
        if (context.Source.Entities is null)
            throw new InvalidOperationException("it has no entities block. Say which scope.resources rule finds the namespaces, which metrics are the backlog and the dead letters, and the name patterns (see docs/config-reference.md)");
        var connection = context.Source.Connection ?? "";
        string? recording = null;
        if (connection.StartsWith(ResourceGraphSourceFactory.RecordingPrefix, StringComparison.OrdinalIgnoreCase))
        {
            var file = connection[ResourceGraphSourceFactory.RecordingPrefix.Length..].Trim();
            recording = Path.IsPathRooted(file) || context.RegistryFolder is null ? file : Path.Combine(context.RegistryFolder, file);
            if (!File.Exists(recording)) throw new InvalidOperationException($"the recording {file} does not exist");
        }
        return new ServiceBusSource(context.Source.Name, context.EnvironmentId, context.Source, new AzureMonitorReader(http ?? Shared, context.Credential),
            context.Scope ?? new ScopeStore(), recording, time ?? TimeProvider.System);
    }

    private static readonly HttpClient Shared = new();
}
