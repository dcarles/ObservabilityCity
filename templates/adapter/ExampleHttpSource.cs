using System.Net.Http.Json;
using System.Text.Json.Serialization;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace Template.Adapters;

/// <summary>Makes the source for each environment source of kind example-http.</summary>
public sealed class ExampleHttpSourceFactory(HttpClient? http = null, TimeProvider? time = null) : IMetricSourceFactory
{
    private static readonly HttpClient Shared = new();

    public string Kind => "example-http";

    public IMetricSource Create(SourceContext context)
    {
        // Say what is wrong in words: the host reports it at start-up and leaves this source out, and the rest of the town carries on.
        if (!Uri.TryCreate(context.Source.Connection, UriKind.Absolute, out var address))
            throw new InvalidOperationException("connection must be the address to read, for example https://metrics.example.test/readings");
        return new ExampleHttpSource(context.Source, context.EnvironmentId, address, http ?? Shared, time ?? TimeProvider.System);
    }
}

/// <summary>
/// Reads one JSON document and turns it into readings. A real adapter asks its own system (a query, a metrics API) here; everything else, the
/// polling, the timeout, the stale state, is the core's. The rules this keeps:
/// answer only for systems the registry has; leave out a system you know nothing about (the town then shows it as having no data);
/// pass the cancellation token to every call; throw when the source cannot be read, so the readings go stale instead of looking fresh.
/// </summary>
public sealed class ExampleHttpSource(RegistrySource definition, string environmentId, Uri address, HttpClient http, TimeProvider time) : IMetricSource
{
    public string Name => definition.Name;

    // the environment file's pollSeconds and timeoutSeconds, with the defaults when it says nothing
    public TimeSpan PollInterval => definition.PollInterval;
    public TimeSpan Timeout => definition.Timeout;

    public async Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct)
    {
        // the poller hands over the whole town; this environment sees only the systems deployed in it
        var view = registry.ForEnvironment(environmentId);
        var answer = await http.GetFromJsonAsync<Answer>(address, ct) ?? throw new InvalidOperationException($"{address} answered with nothing");
        var now = time.GetUtcNow();
        var readings = new Dictionary<string, NodeReading>();
        foreach (var node in view.AllNodes)
        {
            if (!answer.Systems.TryGetValue(node.Id, out var s)) continue;
            readings[node.Id] = new NodeReading(
                At: now,
                Up: s.InstancesHealthy > 0,
                InstancesTotal: s.Instances,
                InstancesHealthy: s.InstancesHealthy,
                Load: s.Cpu ?? 0,
                RequestsPerSecond: s.RequestsPerSecond,
                ErrorRate: s.ErrorRate,
                P99Ms: s.P99Ms,
                Cpu: s.Cpu);
        }
        return readings;
    }

    private sealed record Answer([property: JsonPropertyName("systems")] Dictionary<string, Reading> Systems);

    private sealed record Reading(
        [property: JsonPropertyName("requestsPerSecond")] double RequestsPerSecond,
        [property: JsonPropertyName("errorRate")] double ErrorRate,
        [property: JsonPropertyName("p99Ms")] double P99Ms,
        [property: JsonPropertyName("instances")] int Instances,
        [property: JsonPropertyName("instancesHealthy")] int InstancesHealthy,
        [property: JsonPropertyName("cpu")] double? Cpu);
}
