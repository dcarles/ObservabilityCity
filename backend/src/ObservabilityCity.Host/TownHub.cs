using Microsoft.AspNetCore.SignalR;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Snapshots;

namespace ObservabilityCity.Host;

/// <summary>Browsers connect here and receive "snapshot" messages.</summary>
public sealed class TownHub(SnapshotStore store) : Hub
{
    public const string SnapshotMethod = "snapshot";

    public override async Task OnConnectedAsync()
    {
        // A new viewer sees the town straight away instead of waiting for the next tick.
        if (store.Latest is { } latest)
            await Clients.Caller.SendAsync(SnapshotMethod, latest);
        await base.OnConnectedAsync();
    }
}

/// <summary>The SignalR implementation of the snapshot transport.</summary>
public sealed class SignalRSnapshotNotifier(IHubContext<TownHub> hub) : ISnapshotNotifier
{
    public Task PublishAsync(Snapshot snapshot, CancellationToken ct) =>
        hub.Clients.All.SendAsync(TownHub.SnapshotMethod, snapshot, ct);
}
