using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Logs;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Adapters.Fake;

/// <summary>
/// Makes up what the Logs tab shows for a demo system, from what the fake source is doing to it right now: 5xx requests in proportion to its error rate,
/// slow requests when p99 is over its SLA, warnings and errors (throttling on a store that turns requests away, dead letters on a consumer that parks
/// them) and the exceptions behind the errors. The entries are a pure function of the system, the reading and the clock (an entry keeps its text and its
/// time from one read to the next), and repeats are grouped with a count, newest first, as the live Logs tab does. A worker has only the logs and exceptions
/// sections. The demo has no telemetry store to link to, so its sections have no header links.
/// </summary>
public sealed class FakeLogSource(LatestState state, TimeProvider clock, TimeSpan staleAfter) : ILogSource
{
    /// <summary>Seconds between two entries.</summary>
    private const int Step = 3;

    /// <summary>How many steps back the demo looks.</summary>
    public const int Steps = 200;

    public string Name => "fake";

    public Task<SystemLogs> RecentAsync(RegistryNode node, CancellationToken ct) => Task.FromResult(Recent(node));

    public SystemLogs Recent(RegistryNode node)
    {
        var now = clock.GetUtcNow();
        var window = SourceQuery.Text(TimeSpan.FromSeconds(Steps * Step));
        var wanted = LogSections.For(node.Kind);
        var r = state.Get(node.Id);
        if (r is null || now - r.At > staleAfter) return new SystemLogs(now, true, window, node.SlaP99Ms, wanted.Select(id => new LogSection(id, [])).ToList());
        var bucket = now.ToUnixTimeSeconds() / Step;
        var rows = new List<LogRow>();
        for (var j = 0; j < Steps; j++)
        {
            var b = bucket - j;
            var h = Hash(node.Id, b);
            var at = DateTimeOffset.FromUnixTimeSeconds(b * Step + (long)(h % Step));
            if (at > now) at = now;
            foreach (var (section, level, text, result, ms) in Entries(node, r, h))
                rows.Add(new LogRow(section, at, text, 1, level, ms, result));
        }
        var config = new LogsConfig("fake", "", TimeSpan.FromSeconds(Steps * Step), []);
        var environment = new RegistryEnvironment("demo", "demo", true, [], [], new HashSet<string>(), []);
        return new SystemLogs(now, true, window, node.SlaP99Ms, QueryLogSource.Sections(rows, wanted, config, environment, node.Id, [], TimeSpan.FromSeconds(Steps * Step), now - TimeSpan.FromSeconds(Steps * Step), now));
    }

    /// <summary>
    /// What one moment of a system's life leaves behind, if anything: entries whose text does not hold an id or a duration, so that repeats group. A failed
    /// request also leaves its exception; a request over the SLA is a slow request.
    /// </summary>
    private static IEnumerable<(string Section, LogLevel Level, string Text, string? Result, double? Ms)> Entries(RegistryNode node, NodeReading r, ulong h)
    {
        double Roll(int salt) => (double)((h >> salt) % 10_000) / 10_000;
        string Pick(string[] options, int salt) => options[(int)((h >> salt) % (ulong)options.Length)];
        var slow = r.P99Ms > node.SlaP99Ms;
        var ms = Math.Max(1, (int)(r.P99Ms * (0.15 + Roll(8) * (slow ? 1.3 : 0.5))));
        var service = node.Service ?? node.Id[(node.Id.IndexOf('.') + 1)..];

        if (!r.Up)
        {
            yield return (LogSections.Logs, LogLevel.Error, Pick([
                "Health probe failed: connection refused",
                "Instance exited with code 137 and is restarting",
                "Dependency check failed: the service is not answering",
            ], 4), null, null);
            yield break;
        }

        var unhealthy = r.InstancesHealthy < r.InstancesTotal;
        var failing = Roll(5) < Math.Min(0.9, r.ErrorRate * 6);
        switch (node.Kind)
        {
            case NodeKind.Worker:
                if ((r.DeadLetters ?? 0) > 0 && Roll(2) < 0.25)
                    yield return (LogSections.Logs, LogLevel.Warn, "A message was moved to the dead-letter queue after 10 delivery attempts", null, null);
                else if ((r.OldestMessageSeconds ?? 0) >= node.BacklogAmber && Roll(3) < 0.3)
                    yield return (LogSections.Logs, LogLevel.Warn, "Falling behind: the oldest message has waited longer than it should", null, null);
                else if (failing)
                {
                    yield return (LogSections.Logs, LogLevel.Error, "Handling a message failed", null, null);
                    yield return (LogSections.Exceptions, LogLevel.Error, Pick(["TimeoutException: the database did not answer in 5000 ms", "InvalidOperationException: unexpected message shape", "HttpRequestException: 503 from a downstream call"], 6), null, null);
                }
                else if (unhealthy && Roll(7) < 0.1) yield return (LogSections.Logs, LogLevel.Warn, "Some instances are unhealthy", null, null);
                break;
            case NodeKind.Database or NodeKind.Cache:
            {
                var tenant = TenantDatabase(node, r, h);
                var prefix = tenant is null ? "" : $"{tenant}: ";
                if ((r.Throttled ?? 0) > 0 && Roll(2) < Math.Min(0.8, 0.15 + r.Throttled!.Value * 2))
                    yield return (LogSections.Logs, LogLevel.Warn, $"{prefix}Request rate is too large: some requests were turned away with 429", null, null);
                else if ((r.Utilisation ?? 0) >= node.ResourceAmber && Roll(3) < 0.3)
                    yield return (LogSections.Logs, LogLevel.Warn, $"{prefix}Provisioned throughput is close to the maximum", null, null);
                else if (failing)
                    yield return (LogSections.Logs, LogLevel.Error, $"{prefix}Query failed: transient error, the connection was reset", null, null);
                else if (unhealthy && Roll(7) < 0.1) yield return (LogSections.Logs, LogLevel.Warn, "Some nodes are unhealthy", null, null);
                break;
            }
            case NodeKind.Function:
                if (failing)
                {
                    yield return (LogSections.Logs, LogLevel.Error, "Job failed: timed out waiting for a downstream call", null, null);
                    yield return (LogSections.Exceptions, LogLevel.Error, "TimeoutException: the downstream call timed out after 5000 ms", null, null);
                }
                break;
            default:
            {
                var path = $"/api/{service}/{Pick(["items", "accounts", "orders", "statements", "limits"], 4)}";
                var verb = Pick(["GET", "GET", "GET", "POST", "PUT"], 6);
                if (failing)
                {
                    yield return (LogSections.Failed, LogLevel.Error, $"{verb} {path}", "500", ms);
                    yield return (LogSections.Exceptions, LogLevel.Error, Pick(["TimeoutException: the upstream call timed out after 5000 ms", "SqlException: transient failure (40613)", "NullReferenceException in the handler", "HttpRequestException: 503 from a dependency"], 10), null, null);
                }
                else if (slow && Roll(3) < 0.45)
                    yield return (LogSections.Slow, LogLevel.Warn, $"{verb} {path}", "200", ms);
                else if (unhealthy && Roll(7) < 0.1) yield return (LogSections.Logs, LogLevel.Warn, "Some instances are unhealthy", null, null);
                break;
            }
        }
    }

    /// <summary>The name of one tenant database of a per-tenant store, leaning to a tenant that is being throttled.</summary>
    private static string? TenantDatabase(RegistryNode node, NodeReading r, ulong h)
    {
        if (node.TenantPattern is null || r.Tenants is not { Count: > 0 } tenants) return null;
        var hot = tenants.Where(t => (t.Throttled ?? 0) > 0).ToList();
        var from = hot.Count > 0 && h % 3 != 0 ? hot : tenants;
        return RegistryEnvironment.DatabaseName(node.TenantPattern, from[(int)((h >> 12) % (ulong)from.Count)].TenantId);
    }

    /// <summary>FNV-1a over the id and the bucket: stable between runs, unlike string.GetHashCode.</summary>
    private static ulong Hash(string id, long bucket)
    {
        var h = 14695981039346656037UL;
        foreach (var c in id) { h ^= c; h *= 1099511628211UL; }
        h ^= (ulong)bucket; h *= 1099511628211UL;
        h ^= h >> 29; h *= 0xBF58476D1CE4E5B9UL; h ^= h >> 32;
        return h;
    }
}
