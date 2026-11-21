using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;

namespace ObservabilityCity.Core.History;

/// <summary>One frame of the day index: when it was taken, how many systems were not healthy (degraded and down, dead letters not counted) and how many of those were down.</summary>
public sealed record HistoryPoint(DateTimeOffset At, int Unhealthy, int Down);

/// <summary>What the store holds: the oldest and newest frame, how many there are and what they take on disk.</summary>
public sealed record HistorySummary(DateTimeOffset? Oldest, DateTimeOffset? Newest, int Frames, long Bytes);

/// <summary>
/// Frames of one environment, kept as plain files. One gzip file for each hour (<c>recorded/2026-11-21/10.jsonl.gz</c>, hours in UTC): its first line is a whole snapshot and each
/// later line only what changed since the one before (see <see cref="SnapshotPatch"/>). Every frame is its own gzip member appended to the file, so a crash loses at most the
/// frame being written. A small index for each day (<c>index/2026-11-21.jsonl</c>) lists every frame with its counts, so the time bar loads without opening an hour file; a
/// missing or damaged index is rebuilt from the hour files. Frames older than the limit are deleted whole, never the hour being written.
/// </summary>
public sealed class FileHistoryStore
{
    private const string RecordedFolder = "recorded";
    private const string IndexFolder = "index";

    private readonly string _root;
    private readonly TimeSpan _interval;
    private readonly ILogger? _log;
    private readonly object _gate = new();
    private DateTimeOffset _hour;
    private JsonNode? _previous;

    public FileHistoryStore(string root, TimeSpan interval, ILogger? log = null)
    {
        _root = root;
        _interval = interval;
        _log = log;
    }

    public string Root => _root;

    private static string DayName(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    private static DateTimeOffset HourOf(DateTimeOffset at) => new(at.Year, at.Month, at.Day, at.Hour, 0, 0, TimeSpan.Zero);
    private string HourFile(DateTimeOffset hour) => Path.Combine(_root, RecordedFolder, DayName(hour), hour.UtcDateTime.ToString("HH", CultureInfo.InvariantCulture) + ".jsonl.gz");
    private string IndexFile(string day) => Path.Combine(_root, IndexFolder, day + ".jsonl");

    /// <summary>Saves one frame. The first frame of an hour (or after a restart) is a whole snapshot, the others hold the changes. Returns true when this frame started a new hour.</summary>
    public bool Append(DateTimeOffset at, JsonNode snapshot, int unhealthy, int down)
    {
        at = at.ToUniversalTime();
        lock (_gate)
        {
            var hour = HourOf(at);
            var newHour = hour != _hour;
            var file = HourFile(hour);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var line = new JsonObject { ["t"] = at.ToString("O", CultureInfo.InvariantCulture) };
            if (newHour || _previous is null) line["f"] = snapshot.DeepClone();
            else line["p"] = SnapshotPatch.Diff(_previous, snapshot);
            using (var stream = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.Read))
            using (var gzip = new GZipStream(stream, CompressionLevel.Optimal))
            {
                var bytes = Encoding.UTF8.GetBytes(line.ToJsonString() + "\n");
                gzip.Write(bytes, 0, bytes.Length);
            }
            _hour = hour;
            _previous = snapshot.DeepClone();
            AppendIndex(at, unhealthy, down);
            return newHour;
        }
    }

    private void AppendIndex(DateTimeOffset at, int unhealthy, int down)
    {
        var file = IndexFile(DayName(at));
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.AppendAllText(file, $"{{\"t\":\"{at.ToString("O", CultureInfo.InvariantCulture)}\",\"u\":{unhealthy},\"x\":{down}}}\n");
    }

    private static IEnumerable<JsonObject> Lines(string file)
    {
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var gzip = new GZipStream(stream, CompressionMode.Decompress);
        using var reader = new StreamReader(gzip, Encoding.UTF8);
        while (reader.ReadLine() is { } text)
        {
            if (text.Length == 0) continue;
            var line = TryParse(text, out var broken);
            if (broken) yield break; // a frame cut off by a crash ends the file
            if (line is not null) yield return line;
        }
    }

    private static JsonObject? TryParse(string text, out bool broken)
    {
        try
        {
            broken = false;
            return JsonNode.Parse(text) as JsonObject;
        }
        catch (JsonException)
        {
            broken = true;
            return null;
        }
    }

    private static bool TimeOf(JsonObject line, out DateTimeOffset at)
    {
        at = default;
        return line["t"] is JsonValue v && v.TryGetValue<string>(out var text) && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out at);
    }

    /// <summary>Every frame of one hour, in order: its time and its whole snapshot (rebuilt from the whole one and the changes).</summary>
    private IEnumerable<(DateTimeOffset At, JsonNode Snapshot)> Hour(DateTimeOffset hour)
    {
        var file = HourFile(hour);
        if (!File.Exists(file)) yield break;
        JsonNode? current = null;
        using (var lines = Lines(file).GetEnumerator())
        {
            while (true)
            {
                bool more;
                try { more = lines.MoveNext(); }
                catch (Exception e) when (e is InvalidDataException or IOException) { yield break; }
                if (!more) yield break;
                var line = lines.Current;
                if (!TimeOf(line, out var at)) continue;
                if (line["f"] is { } whole) current = whole.DeepClone();
                else if (line["p"] is JsonArray ops && current is not null) current = SnapshotPatch.Apply(current, ops);
                else continue;
                yield return (at, current);
            }
        }
    }

    /// <summary>The newest frame at or before this time, as the snapshot's JSON text, unless it is older than two frame gaps (then there was no data at that moment).</summary>
    public (DateTimeOffset At, string Json)? FrameAtOrBefore(DateTimeOffset at)
    {
        at = at.ToUniversalTime();
        for (var hour = HourOf(at); hour >= HourOf(at) - TimeSpan.FromHours(1); hour -= TimeSpan.FromHours(1))
        {
            (DateTimeOffset At, JsonNode Snapshot)? found = null;
            foreach (var frame in Hour(hour))
            {
                if (frame.At > at) break;
                found = frame;
            }
            if (found is { } f) return at - f.At <= _interval * 2 ? (f.At, f.Snapshot.ToJsonString()) : null;
        }
        return null;
    }

    /// <summary>Up to <paramref name="count"/> frames from this time on (the first frame at or after it), each with its snapshot as JSON text.</summary>
    public IReadOnlyList<(DateTimeOffset At, string Json)> FramesFrom(DateTimeOffset from, int count)
    {
        from = from.ToUniversalTime();
        var result = new List<(DateTimeOffset, string)>();
        var last = DateTimeOffset.UtcNow.AddHours(1);
        for (var hour = HourOf(from); hour <= last && result.Count < count; hour += TimeSpan.FromHours(1))
        {
            foreach (var frame in Hour(hour))
            {
                if (frame.At < from) continue;
                result.Add((frame.At, frame.Snapshot.ToJsonString()));
                if (result.Count >= count) break;
            }
        }
        return result;
    }

    private static DateTimeOffset? FileHour(string file)
    {
        var day = Path.GetFileName(Path.GetDirectoryName(file)!);
        var hour = Path.GetFileNameWithoutExtension(Path.GetFileNameWithoutExtension(file));
        return DateTimeOffset.TryParseExact($"{day} {hour}", "yyyy-MM-dd HH", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var at) ? at : null;
    }

    /// <summary>Every frame from this time on, from the day index (damaged lines are skipped). A missing index is rebuilt first.</summary>
    public IReadOnlyList<HistoryPoint> Points(DateTimeOffset since)
    {
        since = since.ToUniversalTime();
        EnsureIndex();
        var folder = Path.Combine(_root, IndexFolder);
        if (!Directory.Exists(folder)) return [];
        var points = new List<HistoryPoint>();
        foreach (var file in Directory.EnumerateFiles(folder, "*.jsonl").Order(StringComparer.Ordinal))
        {
            if (string.CompareOrdinal(Path.GetFileNameWithoutExtension(file), DayName(since)) < 0) continue;
            foreach (var text in ReadAllLinesShared(file))
            {
                try
                {
                    if (JsonNode.Parse(text) is JsonObject o && TimeOf(o, out var at) && at >= since)
                        points.Add(new HistoryPoint(at, o["u"]?.GetValue<int>() ?? 0, o["x"]?.GetValue<int>() ?? 0));
                }
                catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException) { /* a damaged line is left out */ }
            }
        }
        return points.OrderBy(p => p.At).ToList();
    }

    private static IEnumerable<string> ReadAllLinesShared(string file)
    {
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var lines = new List<string>();
        while (reader.ReadLine() is { } text) if (text.Length > 0) lines.Add(text);
        return lines;
    }

    public HistorySummary Summary(DateTimeOffset since)
    {
        var points = Points(since);
        var bytes = 0L;
        foreach (var folder in new[] { RecordedFolder, IndexFolder })
        {
            var path = Path.Combine(_root, folder);
            if (Directory.Exists(path)) bytes += Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length);
        }
        return new HistorySummary(points.Count == 0 ? null : points[0].At, points.Count == 0 ? null : points[^1].At, points.Count, bytes);
    }

    /// <summary>Makes an index for every day that has hour files and none (or a damaged one that has fewer frames than its hours), by reading the hour files.</summary>
    public void EnsureIndex()
    {
        var recorded = Path.Combine(_root, RecordedFolder);
        if (!Directory.Exists(recorded)) return;
        lock (_gate)
        {
            foreach (var dayFolder in Directory.EnumerateDirectories(recorded))
            {
                var day = Path.GetFileName(dayFolder);
                var index = IndexFile(day);
                if (File.Exists(index) && IndexIsComplete(index, dayFolder)) continue;
                try { RebuildDay(dayFolder, index); }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    _log?.LogWarning(e, "Could not rebuild the history index for {Day}", day);
                }
            }
        }
    }

    // An index is complete when it names a frame in the last hour file of its day (a cheap check; a gap in the middle of an index that is otherwise intact is not worth a scan).
    private bool IndexIsComplete(string index, string dayFolder)
    {
        var lastHour = Directory.EnumerateFiles(dayFolder, "*.jsonl.gz").Select(FileHour).Where(h => h is not null).Select(h => h!.Value).DefaultIfEmpty().Max();
        if (lastHour == default) return true;
        try
        {
            var lines = ReadAllLinesShared(index).ToList();
            if (lines.Count == 0) return false;
            var last = JsonNode.Parse(lines[^1]) as JsonObject;
            return last is not null && TimeOf(last, out var at) && at >= lastHour;
        }
        catch (Exception e) when (e is JsonException or IOException) { return false; }
    }

    private void RebuildDay(string dayFolder, string index)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(index)!);
        var text = new StringBuilder();
        foreach (var file in Directory.EnumerateFiles(dayFolder, "*.jsonl.gz").Order(StringComparer.Ordinal))
        {
            if (FileHour(file) is not { } hour) continue;
            foreach (var (at, snapshot) in Hour(hour))
            {
                var (unhealthy, down) = Counts(snapshot);
                text.Append(CultureInfo.InvariantCulture, $"{{\"t\":\"{at.ToString("O", CultureInfo.InvariantCulture)}\",\"u\":{unhealthy},\"x\":{down}}}\n");
            }
        }
        File.WriteAllText(index, text.ToString());
    }

    /// <summary>The counts a frame is indexed with, from the snapshot's own totals.</summary>
    public static (int Unhealthy, int Down) Counts(JsonNode snapshot)
    {
        var totals = snapshot["totals"];
        var degraded = totals?["degraded"]?.GetValue<int>() ?? 0;
        var down = totals?["down"]?.GetValue<int>() ?? 0;
        return (degraded + down, down);
    }

    /// <summary>Deletes the hour files and index files of frames older than the limit. The hour being written is never touched: it is newer than any limit.</summary>
    public int Prune(DateTimeOffset oldest)
    {
        oldest = oldest.ToUniversalTime();
        var removed = 0;
        lock (_gate)
        {
            var recorded = Path.Combine(_root, RecordedFolder);
            if (Directory.Exists(recorded))
            {
                foreach (var file in Directory.EnumerateFiles(recorded, "*.jsonl.gz", SearchOption.AllDirectories).ToList())
                {
                    if (FileHour(file) is not { } hour || hour + TimeSpan.FromHours(1) > oldest || hour == _hour) continue;
                    TryDelete(file);
                    removed++;
                }
                foreach (var folder in Directory.EnumerateDirectories(recorded).ToList())
                    if (!Directory.EnumerateFileSystemEntries(folder).Any()) TryDelete(folder);
            }
            var index = Path.Combine(_root, IndexFolder);
            if (Directory.Exists(index))
                foreach (var file in Directory.EnumerateFiles(index, "*.jsonl").ToList())
                {
                    if (!DateTimeOffset.TryParseExact(Path.GetFileNameWithoutExtension(file), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var day)) continue;
                    if (day + TimeSpan.FromDays(1) > oldest) continue;
                    TryDelete(file);
                }
        }
        return removed;
    }

    private void TryDelete(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path);
            else File.Delete(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _log?.LogWarning(e, "Could not delete the old history file {Path}", path);
        }
    }
}
