namespace ObservabilityCity.Core.History;

/// <summary>One point of the strip: a frame's time, how many buildings were degraded or down, and whether the frame was rebuilt from the cloud rather than recorded.</summary>
public sealed record HistoryReadPoint(DateTimeOffset At, int Unhealthy, int Down, bool Rebuilt);

/// <summary>
/// What the history holds, recorded and rebuilt together. Where both have a frame for the same moment the recorded one is the one shown. A frame says which store it came from, so the screen can
/// say "rebuilt" for the others.
/// </summary>
public sealed class HistoryReader(FileHistoryStore recorded, FileHistoryStore? rebuilt)
{
    public FileHistoryStore Recorded => recorded;
    public FileHistoryStore? Rebuilt => rebuilt;

    /// <summary>The newest frame at or before a time from either store (the recorded one when both are at the same moment), under the stores' own limit of two gaps.</summary>
    public (DateTimeOffset At, string Json, bool Rebuilt)? FrameAtOrBefore(DateTimeOffset at)
    {
        var a = recorded.FrameAtOrBefore(at);
        var b = rebuilt?.FrameAtOrBefore(at);
        if (a is null && b is null) return null;
        if (b is null || (a is not null && a.Value.At >= b.Value.At)) return (a!.Value.At, a.Value.Json, false);
        return (b.Value.At, b.Value.Json, true);
    }

    /// <summary>Up to <paramref name="count"/> frames in a row from a time, in time order, from both stores.</summary>
    public IReadOnlyList<(DateTimeOffset At, string Json, bool Rebuilt)> FramesFrom(DateTimeOffset from, int count)
    {
        var merged = new SortedDictionary<DateTimeOffset, (string Json, bool Rebuilt)>();
        foreach (var f in rebuilt?.FramesFrom(from, count) ?? []) merged[f.At] = (f.Json, true);
        foreach (var f in recorded.FramesFrom(from, count)) merged[f.At] = (f.Json, false); // recorded wins
        return merged.Take(count).Select(kv => (kv.Key, kv.Value.Json, kv.Value.Rebuilt)).ToList();
    }

    public IReadOnlyList<HistoryReadPoint> Points(DateTimeOffset since)
    {
        var merged = new SortedDictionary<DateTimeOffset, HistoryReadPoint>();
        foreach (var p in rebuilt?.Points(since) ?? []) merged[p.At] = new HistoryReadPoint(p.At, p.Unhealthy, p.Down, true);
        foreach (var p in recorded.Points(since)) merged[p.At] = new HistoryReadPoint(p.At, p.Unhealthy, p.Down, false);
        return merged.Values.ToList();
    }

    public HistorySummary Summary(DateTimeOffset since)
    {
        var a = recorded.Summary(since);
        var b = rebuilt?.Summary(since) ?? new HistorySummary(null, null, 0, 0);
        var all = Points(since);
        return new HistorySummary(all.Count == 0 ? null : all[0].At, all.Count == 0 ? null : all[^1].At, all.Count, a.Bytes + b.Bytes);
    }
}
