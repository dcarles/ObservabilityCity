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
        var arrived = Reduced(read, config.Throughput);
        var patterns = config.Patterns.Select(p => (Regex: new Regex(p.Match, RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)), p.Consumer)).ToList();
        var byNode = new Dictionary<string, (double Waiting, double Dead, bool HasWaiting, bool HasDead)>();
        var queues = new Dictionary<string, List<QueueReading>>();
        var unclaimed = 0;
        foreach (var entity in backlog.Keys.Union(dead.Keys).Union(arrived.Keys).Order(StringComparer.Ordinal))
        {
            var claim = Claim(registry, patterns, entity);
            if (claim is null) { unclaimed++; continue; }
            _seen[entity] = claim;
        }
        foreach (var (entity, claim) in _seen.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            var node = claim.Node;
            var (w, d, hw, hd) = byNode.GetValueOrDefault(node.Id);
            if (backlog.TryGetValue(entity, out var b)) { w += b; hw = true; }
            if (dead.TryGetValue(entity, out var x)) { d += x; hd = true; }
            byNode[node.Id] = (w, d, hw, hd);
            if (!queues.TryGetValue(node.Id, out var own)) queues[node.Id] = own = [];
            // an entity Azure sent nothing for this time keeps its place in the list (with no numbers), so a quiet queue neither vanishes nor ages
            own.Add(new QueueReading(entity, backlog.TryGetValue(entity, out var qb) ? Math.Round(qb) : null, dead.TryGetValue(entity, out var qd) ? Math.Round(qd) : null,
                arrived.TryGetValue(entity, out var qa) ? Math.Round(qa / Window.TotalSeconds, 3) : null, claim.ProducerGroup, claim.ProducerService));
        }
        Unclaimed = unclaimed;
        return byNode.ToDictionary(kv => kv.Key, kv => new NodeReading(at, true, 0, 0, 0, 0, 0, 0,
            QueueDepth: kv.Value.HasWaiting ? Math.Round(kv.Value.Waiting) : null, DeadLetters: kv.Value.HasDead ? Math.Round(kv.Value.Dead) : null, Queues: queues[kv.Key]));
    }

    /// <summary>What the source has worked out about each entity it has seen: whose it is to read and, when the name says, who publishes it. Kept between polls.</summary>
    private readonly Dictionary<string, EntityClaim> _seen = new(StringComparer.Ordinal);

    private sealed record EntityClaim(RegistryNode Node, string? ProducerGroup, string? ProducerService);

    /// <summary>Each entity's number, added up over the points of each of its series the way the metric says, then summed over the namespaces.</summary>
    private static Dictionary<string, double> Reduced(IEnumerable<EntitySeries> all, EntityMetric? metric)
    {
        var sums = new Dictionary<string, double>(StringComparer.Ordinal);
        if (metric is null) return sums;
        foreach (var series in all.Where(s => s.Metric.Equals(metric.Metric, StringComparison.OrdinalIgnoreCase) && s.Aggregation.Equals(metric.Aggregation, StringComparison.OrdinalIgnoreCase)))
            if (AzureMonitorReader.Reduce(series.Points, metric.Aggregation) is { } value) sums[series.Entity] = sums.GetValueOrDefault(series.Entity) + Math.Max(0, value);
        return sums;
    }

    /// <summary>
    /// Whose an entity is: the first pattern that matches its name decides. The consumer is the system of the pattern's kind whose service code the group <c>service</c> names, in the
    /// pillar the group <c>pillar</c> names, or in any pillar when the pattern has no such group (then the code must belong to one system only). The groups <c>producerPillar</c>
    /// and <c>producer</c> name the publisher the same way, and the entity is then a route from that service to the consumer.
    /// </summary>
    private static EntityClaim? Claim(TownRegistry registry, List<(Regex Regex, string Consumer)> patterns, string entity)
    {
        foreach (var (regex, consumer) in patterns)
        {
            var match = regex.Match(entity);
            if (!match.Success) continue;
            var service = match.Groups["service"].Value;
            var pillars = registry.Groups.Where(g => !g.IsHub).ToList();
            if (match.Groups["pillar"] is { Success: true } named) pillars = pillars.Where(g => Is(g, named.Value)).ToList();
            var found = pillars.SelectMany(g => g.Nodes)
                .Where(n => n.Kind.ToString().Equals(consumer, StringComparison.OrdinalIgnoreCase) && (n.ServiceCode ?? n.Service)?.Equals(service, StringComparison.OrdinalIgnoreCase) == true).ToList();
            if (found.Count != 1) return null; // none, or the code is shared by several pillars: not claimed rather than guessed
            string? group = null, publisher = null;
            if (match.Groups["producerPillar"] is { Success: true } producerPillar && match.Groups["producer"] is { Success: true } producer
                && registry.Groups.FirstOrDefault(g => !g.IsHub && Is(g, producerPillar.Value)) is { } from
                && from.Nodes.FirstOrDefault(n => (n.ServiceCode ?? n.Service)?.Equals(producer.Value, StringComparison.OrdinalIgnoreCase) == true)?.Service is { } name)
                (group, publisher) = (from.Id, name);
            return new EntityClaim(found[0], group, publisher);
        }
        return null;
    }

    private static bool Is(RegistryGroup g, string pillar) => pillar.Equals(g.Code ?? g.Id, StringComparison.OrdinalIgnoreCase) || pillar.Equals(g.Id, StringComparison.OrdinalIgnoreCase);

    private async Task<IReadOnlyList<EntitySeries>> ReadNamespace(EntitiesConfig config, ResolvedResource ns, DateTimeOffset at, CancellationToken ct)
    {
        var all = new List<EntitySeries>();
        foreach (var group in new[] { config.Backlog, config.DeadLetter, config.Throughput }.Where(m => m is not null).GroupBy(m => m!.Aggregation))
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
