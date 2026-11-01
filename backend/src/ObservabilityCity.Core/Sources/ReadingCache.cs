using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace ObservabilityCity.Core.Sources;

/// <summary>
/// The last readings of each source, saved under the town's <c>_discovered/readings/&lt;environment&gt;/</c> folder after every poll and read back when
/// the server starts. A reading keeps the time it was taken, so the town's own freshness rule decides whether it still counts: a restart within the
/// source's freshness window carries on from the last picture instead of showing everything as no data until the first reads finish, and anything older
/// comes back as stale (grey) exactly as it would have. Nothing here makes old numbers look fresh.
/// </summary>
public sealed class ReadingCache(string folder, ILogger? log = null)
{
    private static readonly JsonSerializerOptions Json = new() { Converters = { new JsonStringEnumConverter() }, WriteIndented = false };
    private readonly object _gate = new();

    private string PathOf(string source) => Path.Combine(folder, string.Concat(source.Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c)) + ".json");

    /// <summary>Saves a source's newest readings, replacing the file. A failure to save is logged and never stops the poll.</summary>
    public void Save(string source, IReadOnlyDictionary<string, NodeReading> readings)
    {
        if (readings.Count == 0) return;
        try
        {
            lock (_gate)
            {
                Directory.CreateDirectory(folder);
                var path = PathOf(source);
                File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(readings, Json));
                File.Move(path + ".tmp", path, overwrite: true);
            }
        }
        catch (Exception e) { log?.LogWarning(e, "Could not save the readings of source {Source}", source); }
    }

    /// <summary>What was saved for a source, or nothing when there is no file or it cannot be read.</summary>
    public IReadOnlyDictionary<string, NodeReading> Load(string source)
    {
        try
        {
            var path = PathOf(source);
            if (!File.Exists(path)) return new Dictionary<string, NodeReading>();
            return JsonSerializer.Deserialize<Dictionary<string, NodeReading>>(File.ReadAllText(path), Json) ?? new Dictionary<string, NodeReading>();
        }
        catch (Exception e)
        {
            log?.LogWarning(e, "Could not read the saved readings of source {Source}; starting without them", source);
            return new Dictionary<string, NodeReading>();
        }
    }
}
