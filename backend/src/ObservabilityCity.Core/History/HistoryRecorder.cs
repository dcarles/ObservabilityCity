using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.History;

/// <summary>
/// Saves the environment's newest snapshot every <see cref="HistoryOptions.Interval"/>, on the clock (10:00, 10:05, ...), while the environment is being read. When nobody
/// is looking the sources are not polled (the snapshot is still built, from old readings), so no frame is saved: a gap shows as a gap, never as the same picture repeated. Nor is a frame saved while every source is late, which would be a grey town. The cleaner runs
/// when the recorder starts and then each time a new hour file is begun.
/// </summary>
public sealed class HistoryRecorder(
    FileHistoryStore store,
    SnapshotStore latest,
    HistoryOptions options,
    Demand? gate = null,
    TimeProvider? time = null,
    ILogger<HistoryRecorder>? log = null,
    FileHistoryStore? rebuilt = null) : BackgroundService
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    /// <summary>The snapshot as the browser receives it, in the same words as the live feed.</summary>
    public static JsonNode ToJson(Snapshot snapshot) => JsonSerializer.SerializeToNode(snapshot, Json)!;

    /// <summary>The next moment on the clock after this one.</summary>
    public static DateTimeOffset NextSlot(DateTimeOffset now, TimeSpan interval)
    {
        var ticks = interval.Ticks;
        return new DateTimeOffset((now.UtcTicks / ticks + 1) * ticks, TimeSpan.Zero);
    }

    /// <summary>Deletes what is older than the days kept, in the recorded store and in the rebuilt one.</summary>
    private void Prune()
    {
        var oldest = _time.GetUtcNow() - options.Keep;
        store.Prune(oldest);
        rebuilt?.Prune(oldest);
    }

    /// <summary>Saves a frame now if there is a snapshot with fresh data to save. Returns whether one was saved.</summary>
    public bool RecordOnce(DateTimeOffset slot)
    {
        if (latest.Latest is not { } snapshot) return false;
        // Every source is late (the connection or the login is gone): the town would be grey, and a grey frame saved now could never be replaced by the rebuild. The slot stays
        // a gap, which the filler makes up from the sources once they answer again.
        if (snapshot.Sources is { Count: > 0 } sources && sources.All(s => s.Overdue)) return false;
        var json = ToJson(snapshot);
        var (unhealthy, down) = (snapshot.Totals.Degraded + snapshot.Totals.Down, snapshot.Totals.Down);
        var newHour = store.Append(slot, json, unhealthy, down);
        if (newHour) Prune();
        return true;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        try
        {
            store.EnsureIndex();
            rebuilt?.EnsureIndex();
            Prune();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log?.LogWarning(e, "History could not be tidied at start");
        }
        while (!ct.IsCancellationRequested)
        {
            var slot = NextSlot(_time.GetUtcNow(), options.Interval);
            try { await Task.Delay(TimeSpan.FromTicks(Math.Max(0, (slot - _time.GetUtcNow()).Ticks)), _time, ct); }
            catch (OperationCanceledException) { return; }
            if (gate is not null && !gate.Wanted) continue;
            // One bad frame must not stop the recorder: the history would have a hole with no sign of why.
            try { RecordOnce(slot); }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                log?.LogWarning(e, "Could not save a history frame; trying again at the next one");
            }
        }
    }
}
