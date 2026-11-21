using System.Globalization;
using Microsoft.Extensions.Logging;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.History;

/// <summary>
/// Fills the gaps of the history by asking the cloud what it was like (see <see cref="PastFrameBuilder"/>), and keeps the frames it makes in a store of their own beside the recorded one, so a
/// recorded frame is never replaced by a rebuilt one. A gap is a time slot (a multiple of the interval) neither store has a frame for. The unit is the hour: the slots of an hour that are
/// missing are all built first and saved together, so an hour is either filled or not at all, and a rebuilt hour is never touched again. Only hours that are over are filled; the hour being lived is the recorder's.
/// </summary>
public sealed class HistoryRebuilder(FileHistoryStore recorded, FileHistoryStore rebuilt, PastFrameBuilder frames, TimeSpan interval, TimeProvider time, ILogger? log = null)
{
    private static DateTimeOffset HourOf(DateTimeOffset at) => new(at.UtcDateTime.Year, at.UtcDateTime.Month, at.UtcDateTime.Day, at.UtcDateTime.Hour, 0, 0, TimeSpan.Zero);

    /// <summary>The slots of a stretch of time, oldest first: every multiple of the interval from the first one at or after <paramref name="from"/> up to (not including) <paramref name="to"/>.</summary>
    public IEnumerable<DateTimeOffset> Slots(DateTimeOffset from, DateTimeOffset to)
    {
        var step = interval.Ticks;
        var first = new DateTimeOffset((from.UtcDateTime.Ticks + step - 1) / step * step, TimeSpan.Zero);
        for (var slot = first; slot < to; slot += interval) yield return slot;
    }

    /// <summary>
    /// The hours in [from, now) that have a slot with no frame, newest first (what is nearest to now is what people look at). An hour the rebuilt store already holds is left out, whatever it
    /// holds: it was filled once and is not filled again. Needs the day indexes of both stores.
    /// </summary>
    public IReadOnlyList<DateTimeOffset> MissingHours(DateTimeOffset from)
    {
        var now = time.GetUtcNow();
        var end = HourOf(now); // the hour being lived is not rebuilt
        from = HourOf(from);
        var have = recorded.Points(from).Select(p => p.At).Concat(rebuilt.Points(from).Select(p => p.At)).Select(Round).ToHashSet();
        var filled = rebuilt.Points(from).Select(p => HourOf(p.At)).ToHashSet();
        return Slots(from, end).Where(s => !have.Contains(s)).Select(HourOf).Distinct().Where(h => !filled.Contains(h)).OrderByDescending(h => h).ToList();
    }

    private DateTimeOffset Round(DateTimeOffset at) => new(at.UtcDateTime.Ticks / interval.Ticks * interval.Ticks, TimeSpan.Zero);

    /// <summary>
    /// Builds and saves the missing slots of one hour. <paramref name="health"/> is read once for the whole stretch being filled. Returns how many frames were saved; throws, saving nothing of
    /// the hour, when any frame could not be built (a source failed), so the hour stays a gap that is tried again.
    /// </summary>
    public async Task<int> RebuildHourAsync(DateTimeOffset hour, IReadOnlyDictionary<string, Func<DateTimeOffset, IReadOnlyList<ResourceHealthEvent>>> health, CancellationToken ct)
    {
        hour = HourOf(hour);
        var have = recorded.Points(hour).Where(p => p.At < hour.AddHours(1)).Select(p => Round(p.At)).ToHashSet();
        var built = new List<(DateTimeOffset At, System.Text.Json.Nodes.JsonNode Json)>();
        foreach (var slot in Slots(hour, hour.AddHours(1)))
        {
            if (have.Contains(slot)) continue;
            ct.ThrowIfCancellationRequested();
            built.Add((slot, HistoryRecorder.ToJson(await frames.BuildAsync(slot, health, ct))));
        }
        foreach (var (at, json) in built)
        {
            var (unhealthy, down) = FileHistoryStore.Counts(json);
            rebuilt.Append(at, json, unhealthy, down);
        }
        log?.LogInformation("History: rebuilt {Frames} frames of the hour {Hour}", built.Count, hour.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture));
        return built.Count;
    }

    /// <summary>Reads the health sources' logs once for everything from <paramref name="from"/> on, and gives the reports open at any time in it.</summary>
    public async Task<IReadOnlyDictionary<string, Func<DateTimeOffset, IReadOnlyList<ResourceHealthEvent>>>> ReadHealthAsync(IEnumerable<IMetricSource> sources, Registry.Registry registry, DateTimeOffset from, CancellationToken ct)
    {
        var result = new Dictionary<string, Func<DateTimeOffset, IReadOnlyList<ResourceHealthEvent>>>();
        foreach (var source in sources.OfType<IPastHealthSource>())
            result[source.Name] = await source.ReadSinceAsync(registry, from, ct);
        return result;
    }
}
