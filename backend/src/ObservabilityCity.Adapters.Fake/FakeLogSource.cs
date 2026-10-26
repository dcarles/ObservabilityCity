using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Adapters.Fake;

/// <summary>
/// Makes up log lines that fit what the fake source is doing to a system right now: errors in proportion to its error rate, slow-request warnings
/// when p99 is over its SLA, throttling on a store that turns requests away, dead letters on a consumer that parks them. The lines are a pure
/// function of the system, the reading and the clock (a line keeps its text and its time from one poll to the next), so a viewer sees a steady log
/// that scrolls, not one that reshuffles.
/// </summary>
public sealed class FakeLogSource(LatestState state, TimeProvider clock, TimeSpan staleAfter) : ILogSource
{
    /// <summary>Seconds between two lines.</summary>
    private const int Step = 3;

    public const int MaxLines = 200;

    public string Name => "fake";

    public Task<IReadOnlyList<LogLine>> RecentAsync(RegistryNode node, int limit, CancellationToken ct) =>
        Task.FromResult(Recent(node, limit));

    public IReadOnlyList<LogLine> Recent(RegistryNode node, int limit)
    {
        var now = clock.GetUtcNow();
        var r = state.Get(node.Id);
        if (r is null || now - r.At > staleAfter) return [];
        var count = Math.Clamp(limit, 0, MaxLines);
        var bucket = now.ToUnixTimeSeconds() / Step;
        var lines = new List<LogLine>(count);
        for (var j = 0; j < count; j++)
        {
            var b = bucket - j;
            var h = Hash(node.Id, b);
            var at = DateTimeOffset.FromUnixTimeSeconds(b * Step + (long)(h % Step));
            if (at > now) at = now;
            var (level, message) = Line(node, r, h);
            lines.Add(new LogLine(at, level, message));
        }
        return lines;
    }

    private static (LogLevel, string) Line(RegistryNode node, NodeReading r, ulong h)
    {
        double Roll(int salt) => (double)((h >> salt) % 10_000) / 10_000;
        string Pick(string[] options, int salt) => options[(int)((h >> salt) % (ulong)options.Length)];
        var slow = r.P99Ms > node.SlaP99Ms;
        var ms = Math.Max(1, (int)(r.P99Ms * (0.15 + Roll(8) * (slow ? 1.3 : 0.5))));
        var id = (h >> 20).ToString("x8")[..8];
        var service = node.Service ?? node.Id[(node.Id.IndexOf('.') + 1)..];

        if (!r.Up)
            return (LogLevel.Error, Pick([
                "Health probe failed: connection refused",
                "Instance exited with code 137 and is restarting",
                "Dependency check failed: the service is not answering",
            ], 4));

        var unhealthy = r.InstancesHealthy < r.InstancesTotal;
        switch (node.Kind)
        {
            case NodeKind.Worker:
            {
                if ((r.DeadLetters ?? 0) > 0 && Roll(2) < 0.25)
                    return (LogLevel.Warn, $"Message {id} moved to the dead-letter queue after 10 delivery attempts");
                if ((r.OldestMessageSeconds ?? 0) >= node.BacklogAmber && Roll(3) < 0.3)
                    return (LogLevel.Warn, $"Falling behind: the oldest message has waited {r.OldestMessageSeconds:0} s ({r.QueueDepth ?? 0:0} waiting)");
                if (Roll(5) < Math.Min(0.9, r.ErrorRate * 6))
                    return (LogLevel.Error, $"Handling message {id} failed: {Pick(["TimeoutException: the database did not answer in 5000 ms", "InvalidOperationException: unexpected message shape", "HttpRequestException: 503 from a downstream call"], 6)}");
                if (unhealthy && Roll(7) < 0.1) return (LogLevel.Warn, $"{r.InstancesTotal - r.InstancesHealthy} of {r.InstancesTotal} instances are unhealthy");
                return (LogLevel.Info, $"Handled message {id} in {ms} ms");
            }
            case NodeKind.Database or NodeKind.Cache:
            {
                var tenant = TenantDatabase(node, r, h);
                var prefix = tenant is null ? "" : $"{tenant}: ";
                if ((r.Throttled ?? 0) > 0 && Roll(2) < Math.Min(0.8, 0.15 + r.Throttled!.Value * 2))
                    return (LogLevel.Warn, $"{prefix}Request rate is too large: 429 for {r.Throttled.Value * 100:0}% of requests, retry after {20 + (int)(Roll(9) * 480)} ms");
                if ((r.Utilisation ?? 0) >= node.ResourceAmber && Roll(3) < 0.3)
                    return (LogLevel.Warn, $"{prefix}Provisioned throughput at {r.Utilisation!.Value * 100:0}% of the maximum");
                if (Roll(5) < Math.Min(0.9, r.ErrorRate * 6))
                    return (LogLevel.Error, $"{prefix}Query failed: transient error, the connection was reset");
                if (unhealthy && Roll(7) < 0.1) return (LogLevel.Warn, $"{r.InstancesTotal - r.InstancesHealthy} of {r.InstancesTotal} nodes are unhealthy");
                return (LogLevel.Info, node.Kind == NodeKind.Cache
                    ? Pick(["Cache hit ratio 0.97 over the last minute", $"Evicted {1 + (int)(Roll(9) * 40)} expired keys", "Replication in sync"], 4)
                    : $"{prefix}{Pick(["Checkpoint complete in " + ms + " ms", "Index maintenance finished", $"Query served in {ms} ms"], 4)}");
            }
            case NodeKind.Cron:
            {
                if (Roll(5) < Math.Min(0.9, r.ErrorRate * 6)) return (LogLevel.Error, "Job failed: timed out waiting for a downstream call");
                return (LogLevel.Info, $"Job finished in {Math.Max(1, ms / 100)} s");
            }
            default:
            {
                var path = $"/api/{service}/{Pick(["items", "accounts", "orders", "statements", "limits"], 4)}";
                var verb = Pick(["GET", "GET", "GET", "POST", "PUT"], 6);
                if (Roll(5) < Math.Min(0.9, r.ErrorRate * 6))
                    return (LogLevel.Error, $"{verb} {path} 500 in {ms} ms: {Pick(["TimeoutException: the upstream call timed out after 5000 ms", "SqlException: transient failure (40613)", "NullReferenceException in the handler", "HttpRequestException: 503 from a dependency"], 10)}");
                if (slow && Roll(3) < 0.45)
                    return (LogLevel.Warn, $"{verb} {path} 200 in {ms} ms, over the {node.SlaP99Ms:0} ms SLA");
                if (unhealthy && Roll(7) < 0.1) return (LogLevel.Warn, $"{r.InstancesTotal - r.InstancesHealthy} of {r.InstancesTotal} instances are unhealthy");
                return (LogLevel.Info, $"{verb} {path} 200 in {ms} ms");
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
