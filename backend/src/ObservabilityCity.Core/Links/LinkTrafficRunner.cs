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
    IDependencySource source, ScopeStore scope, IRegistryProvider registries, LinkTraffic traffic, TimeProvider time, ILogger<LinkTrafficRunner> log, IRateHistory? history = null) : BackgroundService
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

        await SeedAsync(view, config, ct);
        var now = time.GetUtcNow();
        var rows = await source.ReadDependenciesAsync(view, config.Query, byRole.Keys.ToList(), now - config.ShareWindow, now, ct);
        var classifier = new LinkClassifier(links, view.Vendors, view.AllNodes.Select(n => n.Id), LinkClassifier.ServicesOf(view.AllNodes));
        var calls = new List<(string, string, double)>();
        foreach (var row in rows)
        {
            if (!byRole.TryGetValue(row.Caller, out var caller)) continue;
            var result = classifier.Classify(row, caller.GroupId);
            if (result.Outcome is LinkOutcome.Found or LinkOutcome.Vendor && result.Target is { } target && target != caller.Id) calls.Add((caller.Id, target, row.Calls));
        }
        traffic.Update(calls, config.ShareWindow, config.MinCalls);
    }

    /// <summary>
    /// Asks once for each API's average rate over the share window, so the outside share does not have to wait for the town's own history. A source that
    /// cannot say, or an answer that fails, leaves things as they were (the split then follows the current rate until ten minutes of history) and is tried again next cycle.
    /// </summary>
    private async Task SeedAsync(Registry.Registry view, LinkTrafficConfig config, CancellationToken ct)
    {
        if (history is not { CanReadRates: true } || traffic.Seeded) return;
        try
        {
            traffic.Seed(await history.ReadAverageRatesAsync(view, config.ShareWindow, ct));
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            log.LogWarning(e, "Reading the earlier request rates failed; the outside share follows the current rate for now");
        }
    }
}
