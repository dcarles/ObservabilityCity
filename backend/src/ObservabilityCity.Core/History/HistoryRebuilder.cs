using System.Globalization;
using Microsoft.Extensions.Logging;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.History;

/// <summary>
/// Fills the gaps of the history by asking the cloud what it was like (see <see cref="PastFrameBuilder"/>), and keeps the frames it makes in a store of their own beside the recorded one, so a
/// recorded frame is never replaced by a rebuilt one. A gap is a time slot (a multiple of the interval) neither store has a frame for. The unit is the hour: the slots of an hour that are
/// missing are all built first and saved together, so an hour is either filled or not at all, and a rebuilt hour is never touched again. Only hours that are over are filled; the hour being lived is the recorder's.
/// </summary>
public sealed class HistoryRebuilder(FileHistoryStore recorded, FileHistoryStore rebuilt, PastFrameBuilder frames, TimeSpan interval, TimeProvider time, ILogger? log = null, int framesAtOnce = HistoryRebuilder.FramesAtOnce)
{
    /// <summary>How many frames of an hour are built at the same time.</summary>
    public const int FramesAtOnce = 3;

    private static DateTimeOffset HourOf(DateTimeOffset at) => new(at.UtcDateTime.Year, at.UtcDateTime.Month, at.UtcDateTime.Day, at.UtcDateTime.Hour, 0, 0, TimeSpan.Zero);

    /// <summary>Whether any of these sources can say what the past was (a metric source that is not a recording).</summary>
    public bool CanRebuildFrom(IReadOnlyList<IMetricSource> sources) => sources.Any(s => s is IPastMetricSource { CanReadPast: true });

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
    /// Builds and saves the missing slots of one hour. Returns how many frames were saved; throws, saving nothing of
    /// the hour, when any frame could not be built (a source failed), so the hour stays a gap that is tried again.
    /// </summary>
    public async Task<int> RebuildHourAsync(DateTimeOffset hour, CancellationToken ct)
    {
        hour = HourOf(hour);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var have = recorded.Points(hour).Where(p => p.At < hour.AddHours(1)).Select(p => Round(p.At)).ToHashSet();
        var todo = Slots(hour, hour.AddHours(1)).Where(slot => !have.Contains(slot)).ToList();
        var done = 0;
        // a few frames at a time: one after the other an hour takes about a minute. Not more, so that the cloud's limits on questions at once are kept to. The first frame to fail
        // fails the hour and stops the others (nothing is saved of a part-built hour)
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        using var gate = new SemaphoreSlim(Math.Max(1, framesAtOnce));
        var results = await Task.WhenAll(todo.Select(async slot =>
        {
            await gate.WaitAsync(stop.Token);
            try
            {
                stop.Token.ThrowIfCancellationRequested();
                var frameClock = System.Diagnostics.Stopwatch.StartNew();
                var json = HistoryRecorder.ToJson(await frames.BuildAsync(slot, stop.Token));
                log?.LogInformation("History: built the frame {At} ({Done} of {Total} of the hour) in {Seconds:0.0} s", slot.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture), Interlocked.Increment(ref done), todo.Count, frameClock.Elapsed.TotalSeconds);
                return (At: slot, Json: json);
            }
            catch { stop.Cancel(); throw; }
            finally { gate.Release(); }
        }));
        var built = results.OrderBy(r => r.At).ToList();
        foreach (var (at, json) in built)
        {
            var (unhealthy, down) = FileHistoryStore.Counts(json);
            rebuilt.Append(at, json, unhealthy, down);
        }
        log?.LogInformation("History: rebuilt {Frames} frames of the hour {Hour} in {Seconds:0.0} s", built.Count, hour.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture), clock.Elapsed.TotalSeconds);
        return built.Count;
    }
}
