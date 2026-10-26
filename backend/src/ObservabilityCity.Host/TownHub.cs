using Microsoft.AspNetCore.SignalR;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Snapshots;

namespace ObservabilityCity.Host;

/// <summary>
/// Browsers connect here and receive "snapshot" messages for one environment of one town: the ones in the address' ?town= and ?env=, or the default
/// town and its default environment when it names none. Naming one that does not exist gets an "environmentUnknown" message and no snapshots, never
/// another one's: a typo must not leave anyone looking at production by mistake.
/// </summary>
public sealed class TownHub(TownSet towns, IslandViews views) : Hub
{
    public const string SnapshotMethod = "snapshot";
    public const string UnknownMethod = "environmentUnknown";
    private const string ViewKey = "islands";

    public override async Task OnConnectedAsync()
    {
        var http = Context.GetHttpContext();
        var asked = http?.Request.Query["env"].ToString();
        var askedTown = http?.Request.Query["town"].ToString();
        var environments = towns.EnvironmentsOf(askedTown);
        if (environments.Find(asked) is not { } rt)
        {
            await Clients.Caller.SendAsync(UnknownMethod, new
            {
                requested = asked,
                requestedTown = askedTown,
                environments = environments.All.Select(e => e.Id),
                towns = towns.All.Select(t => t.Id),
            });
            await base.OnConnectedAsync();
            return;
        }
        Context.Items["env"] = rt.Key;
        await Enter(rt, IslandViews.Parse(http?.Request.Query["islands"].ToArray()));
        await base.OnConnectedAsync();
    }

    /// <summary>
    /// Changes which islands this browser looks at, without reconnecting. An empty list shows the whole town. The browser gets the town as it
    /// now looks through the new filter straight away.
    /// </summary>
    public async Task SetIslands(string[]? islands)
    {
        if (Context.Items["env"] is not string key || RuntimeOf(key) is not { } rt) return;
        var next = IslandViews.Parse(islands);
        if (Context.Items[ViewKey] is IReadOnlyList<string> current)
        {
            if (current.SequenceEqual(next)) return;
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, IslandViews.GroupOf(rt.Key, current));
            views.Leave(rt.Key, current);
        }
        await Enter(rt, next);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (Context.Items["env"] is string key && Context.Items[ViewKey] is IReadOnlyList<string> islands) views.Leave(key, islands);
        await base.OnDisconnectedAsync(exception);
    }

    private EnvironmentRuntime? RuntimeOf(string key) => towns.All.SelectMany(t => t.Environments.All).FirstOrDefault(e => e.Key == key);

    private async Task Enter(EnvironmentRuntime rt, IReadOnlyList<string> islands)
    {
        Context.Items[ViewKey] = islands;
        await Groups.AddToGroupAsync(Context.ConnectionId, views.Join(rt.Key, islands));
        // A new viewer sees the town straight away instead of waiting for the next tick.
        var first = islands.Count == 0 ? rt.Store.Latest : rt.Store.Latest is null ? null : rt.Builder.Build(islands);
        if (first is not null) await Clients.Caller.SendAsync(SnapshotMethod, first);
    }
}

/// <summary>The SignalR implementation of the snapshot transport, for the environments of one town.</summary>
public sealed class SignalRSnapshotNotifier(IHubContext<TownHub> hub, EnvironmentSet environments, IslandViews views) : ISnapshotNotifier
{
    public async Task PublishAsync(Snapshot snapshot, CancellationToken ct)
    {
        if (environments.Find(snapshot.Environment) is not { } rt) return;
        await hub.Clients.Group(rt.Key).SendAsync(TownHub.SnapshotMethod, snapshot, ct);
        // one filtered snapshot for each island filter in use, shared by every browser that looks through it
        foreach (var (group, islands) in views.InUse(rt.Key))
            await hub.Clients.Group(group).SendAsync(TownHub.SnapshotMethod, rt.Builder.Build(islands), ct);
    }
}
