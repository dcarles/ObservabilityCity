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
    IDependencySource source, ScopeStore scope, IRegistryProvider registries, DiscoveredLinks store, TimeProvider time, ILogger<LinkDiscoveryRunner> log, Sources.Demand? demand = null) : BackgroundService
{
    /// <summary>How long the first read waits for the inventory, which says what the telemetry calls each system.</summary>
    public static readonly TimeSpan InventoryWait = TimeSpan.FromSeconds(30);

    /// <summary>
    /// A rescan asked for by an edit (a vendor, rule or ignore added) waits this long for the next edit before it starts, so that three edits in a row cost one
    /// full read of the history, not three.
    /// </summary>
    public static readonly TimeSpan RescanQuiet = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (!await Sources.Demand.WaitUntilWantedAsync(demand, ct)) return;
        if (scope.Inventory is null) await scope.WaitForReadAsync(InventoryWait, ct);
        while (!ct.IsCancellationRequested)
        {
            // nobody looks at this environment: no reads until a browser connects
            if (!await Sources.Demand.WaitUntilWantedAsync(demand, ct)) return;
            _ = store.TakeReadRequest(); // an ask made before this read is answered by it
            var interval = await CycleAsync(ct);
            var asked = store.TakeReadRequest();
            using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
            try
            {
                // the next read comes at its turn, or at once when the rules changed while this one ran
                var turn = Task.Delay(interval, time, wait.Token);
                if (await Task.WhenAny(turn, asked) == asked) await QuietAsync(ct);
                wait.Cancel();
                await turn.ContinueWith(_ => { }, TaskScheduler.Default);
                ct.ThrowIfCancellationRequested();
            }
            catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>Waits until no further read was asked for during <see cref="RescanQuiet"/>.</summary>
    public async Task QuietAsync(CancellationToken ct)
    {
        while (true)
        {
            var more = store.TakeReadRequest();
            using var quiet = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var pause = Task.Delay(RescanQuiet, time, quiet.Token);
            var first = await Task.WhenAny(pause, more);
            quiet.Cancel();
            await pause.ContinueWith(_ => { }, TaskScheduler.Default);
            ct.ThrowIfCancellationRequested();
            if (first == pause) return;
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

    /// <summary>Asks again what each remembered address is, by the rules the registry has now: a host, vendor or rule added since takes its addresses off the list at once.</summary>
    public static void Reclassify(DiscoveredLinks store, LinkClassifier classifier, ObservabilityCity.Core.Registry.Registry view)
    {
        var groupOf = view.AllNodes.ToDictionary(n => n.Id, n => n.GroupId);
        foreach (var v in view.Vendors) groupOf.TryAdd(v.Node.Id, v.Node.GroupId);
        store.Revisit((callerId, host, path) => classifier.Classify(new DependencyRow(callerId, host, path, [], 0), groupOf.GetValueOrDefault(callerId, "")));
    }

    /// <summary>The same, with a classifier made from the registry view itself. False when the environment finds no links.</summary>
    public static bool Reclassify(DiscoveredLinks store, ObservabilityCity.Core.Registry.Registry view)
    {
        if (view.ActiveEnvironment?.Links is not { } config) return false;
        Reclassify(store, new LinkClassifier(config, view.Vendors, view.AllNodes.Select(n => n.Id), LinkClassifier.ServicesOf(view.AllNodes)), view);
        // the history was read with the old rules: ask for a read now, which sees the new fingerprint and reads the whole window again
        store.RequestRead();
        return true;
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
        // a name that has never been read is read over the whole first-read window, not just the gap since the last read: its links need their days
        var fullFrom = now - config.FirstRead;
        // the rules, ignore list, vendors or town systems changed since the links were read: every name's history is read again, so a new rule shows its links at once
        var fingerprint = LinkClassifier.Fingerprint(config, view.Vendors, view.AllNodes.Select(n => n.Id));
        var rescan = store.Fingerprint != fingerprint;
        var fresh = rescan ? byRole.Keys.ToList() : byRole.Keys.Where(r => !store.AskedRoles.Contains(r, StringComparer.OrdinalIgnoreCase)).ToList();
        var rows = new List<DependencyRow>();
        if (fresh.Count == 0 || from <= fullFrom || fresh.Count == byRole.Count)
            rows.AddRange(await source.ReadDependenciesAsync(view, config.Query, byRole.Keys.ToList(), fresh.Count > 0 ? fullFrom : from, now, ct));
        else
        {
            rows.AddRange(await source.ReadDependenciesAsync(view, config.Query, byRole.Keys.Except(fresh).ToList(), from, now, ct));
            rows.AddRange(await source.ReadDependenciesAsync(view, config.Query, fresh, fullFrom, now, ct));
        }

        var classifier = new LinkClassifier(config, view.Vendors, view.AllNodes.Select(n => n.Id), LinkClassifier.ServicesOf(view.AllNodes));
        var vendorIds = view.Vendors.Select(v => v.Node.Id).ToHashSet(StringComparer.Ordinal);
        store.Judge(vendorIds.Contains, classifier.IsGatewayHost);
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
        Reclassify(store, classifier, view);
        store.Prune(now, config.KeepFor);
        store.RoleAsked(byRole.Keys);
        store.SetFingerprint(fingerprint);
        store.Finish(now);
        store.Save();
    }
}
