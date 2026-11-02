using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ObservabilityCity.Contracts;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>
/// Builds a snapshot on a timer and hands it to the store and the notifier. The store always holds the newest. With a keep-alive, viewers are sent a snapshot only
/// when something in it changed (its clock fields aside), or when the keep-alive has passed since the last one, so the feed shows it is alive without a new
/// snapshot every tick while the sources are read every minute or so. Without one, every tick is sent.
/// </summary>
public sealed class SnapshotPublisher(
    SnapshotBuilder builder,
    SnapshotStore store,
    ISnapshotNotifier notifier,
    TimeSpan interval,
    ILogger<SnapshotPublisher>? log = null,
    TimeSpan? keepAlive = null) : BackgroundService
{
    private string? _sent;
    private DateTimeOffset _sentAt;

    /// <summary>What the snapshot says, less the fields that move with the clock: a change here is worth sending.</summary>
    internal static string Content(Snapshot s) =>
        System.Text.Json.JsonSerializer.Serialize(s with { GeneratedAt = default, DayFraction = 0 });

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
                var now = DateTimeOffset.UtcNow;
                var content = keepAlive is null ? null : Content(snapshot);
                if (keepAlive is { } alive && content == _sent && now - _sentAt < alive) continue;
                await notifier.PublishAsync(snapshot, ct);
                _sent = content;
                _sentAt = now;
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
