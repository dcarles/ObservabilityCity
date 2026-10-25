using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>Builds a snapshot on a timer and hands it to the store and the notifier.</summary>
public sealed class SnapshotPublisher(
    SnapshotBuilder builder,
    SnapshotStore store,
    ISnapshotNotifier notifier,
    TimeSpan interval,
    ILogger<SnapshotPublisher>? log = null) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(interval);
        do
        {
            // One bad tick must not stop the publisher: the viewers would be left looking at a frozen town.
            try
            {
                var snapshot = builder.Build();
                store.Set(snapshot);
                await notifier.PublishAsync(snapshot, ct);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                log?.LogWarning(e, "Could not publish a snapshot; trying again on the next tick");
            }
        }
        while (await WaitNext(timer, ct));
    }

    private static async Task<bool> WaitNext(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
