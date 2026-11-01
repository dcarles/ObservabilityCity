using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;

namespace ObservabilityCity.Core.Links;

/// <summary>
/// Reads the calls the systems make, in the background, and keeps <see cref="DiscoveredLinks"/> up to date. The first read looks back
/// <see cref="LinkDiscovery.FirstRead"/>; after that each read starts where the last one ended, so a restart reads only the gap. A read that fails
/// leaves what was found before in place and is reported as a notice. Buildings never wait for it: the town draws the links already in the store.
/// </summary>
public sealed class LinkDiscoveryRunner(
    IDependencySource source, ScopeStore scope, IRegistryProvider registries, DiscoveredLinks store, TimeProvider time, ILogger<LinkDiscoveryRunner> log) : BackgroundService
{
    /// <summary>How long the first read waits for the inventory, which says what the telemetry calls each system.</summary>
    public static readonly TimeSpan InventoryWait = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (scope.Inventory is null) await scope.WaitForReadAsync(InventoryWait, ct);
        while (!ct.IsCancellationRequested)
        {
            var interval = await CycleAsync(ct);
            try { await Task.Delay(interval, time, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>One read that cannot throw: a failure is kept for the notices and the links found before stay. Returns how long to wait before the next one.</summary>
    public async Task<TimeSpan> CycleAsync(CancellationToken ct)
    {
        try
        {
            await RunOnceAsync(ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            store.Fail(e.Message.ReplaceLineEndings(" "));
            log.LogWarning(e, "Link discovery failed; the links found before stay");
        }
        return registries.Current.ActiveEnvironment?.Links?.Interval ?? LinkDiscovery.DefaultInterval;
    }

    /// <summary>One read: asks for the gap since the last one, classifies what comes back and saves it. Public so tests can drive it.</summary>
    public async Task RunOnceAsync(CancellationToken ct)
    {
        var view = registries.Current;
        if (view.ActiveEnvironment?.Links is not { } config) return;
        var resolution = scope.Resolve(view);
        var byRole = LinkCallers.ByRole(view, id => resolution.System(id)?.TelemetryRole);
        if (byRole.Count == 0) return;

        var now = time.GetUtcNow();
        var from = store.ReadUpTo is { } last && last > now - config.FirstRead ? last : now - config.FirstRead;
        var rows = await source.ReadDependenciesAsync(view, config.Query, byRole.Keys.ToList(), from, now, ct);

        var classifier = new LinkClassifier(config, view.Vendors, view.AllNodes.Select(n => n.Id), LinkClassifier.ServicesOf(view.AllNodes));
        foreach (var row in rows)
        {
            if (!byRole.TryGetValue(row.Caller, out var caller)) continue;
            var result = classifier.Classify(row, caller.GroupId);
            switch (result.Outcome)
            {
                case LinkOutcome.Found when result.Target != caller.Id:
                    store.RecordLink(caller.Id, result.Target!, result.Gateway, row.Days);
                    break;
                case LinkOutcome.Unresolved:
                    store.RecordUnresolved(caller.Id, row.Host, row.Path, row.Days, row.Calls);
                    break;
                case LinkOutcome.OutsideTown:
                    store.RecordOutside(caller.Id, row.Host, row.Path, result.Target!, row.Days, row.Calls);
                    break;
            }
        }
        // a rule added since an address was remembered takes it off the lists now, not when its days age out
        var groupOf = view.AllNodes.ToDictionary(n => n.Id, n => n.GroupId);
        foreach (var v in view.Vendors) groupOf.TryAdd(v.Node.Id, v.Node.GroupId);
        store.Revisit((callerId, host, path) => classifier.Classify(new DependencyRow(callerId, host, path, [], 0), groupOf.GetValueOrDefault(callerId, "")));
        store.Prune(now, config.KeepFor);
        store.Finish(now);
        store.Save();
    }
}
