using Microsoft.AspNetCore.SignalR;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Snapshots;

namespace ObservabilityCity.Host;

/// <summary>
/// Browsers connect here and receive "snapshot" messages for one environment: the one in the address' ?env=, or the default environment
/// when it names none. Naming one that does not exist gets an "environmentUnknown" message and no snapshots, never another environment's:
/// a typo must not leave anyone looking at production by mistake.
/// </summary>
public sealed class TownHub(EnvironmentSet environments) : Hub
{
    public const string SnapshotMethod = "snapshot";
    public const string UnknownMethod = "environmentUnknown";

    public override async Task OnConnectedAsync()
    {
        var asked = Context.GetHttpContext()?.Request.Query["env"].ToString();
        if (environments.Find(asked) is not { } rt)
        {
            await Clients.Caller.SendAsync(UnknownMethod, new { requested = asked, environments = environments.All.Select(e => e.Id) });
            await base.OnConnectedAsync();
            return;
        }
        await Groups.AddToGroupAsync(Context.ConnectionId, rt.Id);
        // A new viewer sees the town straight away instead of waiting for the next tick.
        if (rt.Store.Latest is { } latest)
            await Clients.Caller.SendAsync(SnapshotMethod, latest);
        await base.OnConnectedAsync();
    }
}

/// <summary>The SignalR implementation of the snapshot transport.</summary>
public sealed class SignalRSnapshotNotifier(IHubContext<TownHub> hub) : ISnapshotNotifier
{
    public Task PublishAsync(Snapshot snapshot, CancellationToken ct) =>
        hub.Clients.Group(snapshot.Environment).SendAsync(TownHub.SnapshotMethod, snapshot, ct);
}
