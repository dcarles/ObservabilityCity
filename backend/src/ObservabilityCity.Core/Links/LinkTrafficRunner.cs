using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;

namespace ObservabilityCity.Core.Links;

/// <summary>
/// Measures how much each town system sends to each API, in the background, and keeps <see cref="LinkTraffic"/> up to date. Each read looks back
/// <see cref="LinkTrafficConfig.ShareWindow"/> (so the shares are smooth) and classifies the addresses with the same rules link discovery uses. A read that
/// fails leaves the last numbers in place and is reported as a notice.
/// </summary>
public sealed class LinkTrafficRunner(
    IDependencySource source, ScopeStore scope, IRegistryProvider registries, LinkTraffic traffic, TimeProvider time, ILogger<LinkTrafficRunner> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (scope.Inventory is null) await scope.WaitForReadAsync(LinkDiscoveryRunner.InventoryWait, ct);
        while (!ct.IsCancellationRequested)
        {
            var interval = await CycleAsync(ct);
            try { await Task.Delay(interval, time, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>One read that cannot throw: a failure is kept for the notices and the numbers from before stay. Returns how long to wait before the next one.</summary>
    public async Task<TimeSpan> CycleAsync(CancellationToken ct)
    {
        try
        {
            await RunOnceAsync(ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            traffic.Fail(e.Message.ReplaceLineEndings(" "));
            log.LogWarning(e, "Reading link traffic failed; the numbers from before stay");
        }
        return registries.Current.ActiveEnvironment?.Links?.Traffic?.Interval ?? LinkTrafficConfig.DefaultInterval;
    }

    /// <summary>One read over the share window. Public so tests can drive it.</summary>
    public async Task RunOnceAsync(CancellationToken ct)
    {
        var view = registries.Current;
        if (view.ActiveEnvironment?.Links is not { Traffic: { } config } links) return;
        var resolution = scope.Resolve(view);
        var byRole = new Dictionary<string, RegistryNode>(StringComparer.OrdinalIgnoreCase);
        foreach (var node in view.AllNodes.Where(n => n.Kind is NodeKind.Api or NodeKind.Worker && n.DiscoverLinks))
            if (resolution.System(node.Id)?.TelemetryRole is { Length: > 0 } role) byRole.TryAdd(role, node);
        if (byRole.Count == 0) return;

        var now = time.GetUtcNow();
        var rows = await source.ReadDependenciesAsync(view, config.Query, byRole.Keys.ToList(), now - config.ShareWindow, now, ct);
        var classifier = new LinkClassifier(links, view.Vendors, view.AllNodes.Select(n => n.Id));
        var calls = new List<(string, string, double)>();
        foreach (var row in rows)
        {
            if (!byRole.TryGetValue(row.Caller, out var caller)) continue;
            var result = classifier.Classify(row, caller.GroupId);
            if (result.Outcome == LinkOutcome.Found && result.Target != caller.Id) calls.Add((caller.Id, result.Target!, row.Calls));
        }
        traffic.Update(calls, config.ShareWindow, config.MinCalls);
    }
}
