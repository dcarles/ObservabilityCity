using Microsoft.Extensions.Hosting;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>Builds a snapshot on a timer and hands it to the store and the notifier.</summary>
public sealed class SnapshotPublisher(
    SnapshotBuilder builder,
    SnapshotStore store,
    ISnapshotNotifier notifier,
    TimeSpan interval) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(interval);
        do
        {
            var snapshot = builder.Build();
            store.Set(snapshot);
            await notifier.PublishAsync(snapshot, ct);
        }
        while (await WaitNext(timer, ct));
    }

    private static async Task<bool> WaitNext(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
