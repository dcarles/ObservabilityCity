using Microsoft.Extensions.Logging;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ObservabilityCity.Core.Links;

/// <summary>A call between two systems that the telemetry showed, and the last day it did.</summary>
public sealed record FoundLink(string Caller, string Target, bool Gateway, DateOnly LastSeen);

/// <summary>
/// What link discovery has learned about one environment: the days each call was seen on, the addresses no rule explains, and how far the last read
/// went. It is kept in memory and saved under the town's <c>_discovered/links/&lt;environment&gt;/</c> folder (one file for each pillar of the caller, plus
/// the read state), so a restart carries on from the gap instead of reading a week again. The pillar files are never touched.
/// </summary>
public sealed class DiscoveredLinks
{
    public const string StateFile = "state.yaml";

    private static readonly ISerializer Writer = new SerializerBuilder().WithNamingConvention(CamelCaseNamingConvention.Instance)
        .ConfigureDefaultValuesHandling(DefaultValuesHandling.OmitNull).Build();
    private static readonly IDeserializer Reader = new DeserializerBuilder().WithNamingConvention(CamelCaseNamingConvention.Instance).IgnoreUnmatchedProperties().Build();

    private readonly object _gate = new();
    private readonly string? _folder;

    /// <summary>Who sends how much to each API. Kept in memory only: it is a rolling measure, not history.</summary>
    public LinkTraffic Traffic { get; } = new();

    private readonly Dictionary<(string Caller, string Target, bool Gateway), SortedSet<DateOnly>> _links = [];
    private readonly Dictionary<(string Caller, string Host, string Path), (SortedSet<DateOnly> Days, double Calls)> _unresolved = [];
    private DateTimeOffset? _readUpTo;
    private string? _error;
    private int _version;

    /// <summary>A store that lives in memory only (no folder to save to).</summary>
    public DiscoveredLinks() : this(null) { }

    /// <summary>A store that saves to <paramref name="folder"/> and starts from what is already there.</summary>
    public DiscoveredLinks(string? folder, ILogger? log = null)
    {
        _folder = folder;
        if (folder is not null) Load(folder, log);
    }

    /// <summary>Changes whenever what the store would show changes, so the registry view is made again only then.</summary>
    public int Version { get { lock (_gate) return _version; } }

    /// <summary>How far the last successful read went; the next one starts here.</summary>
    public DateTimeOffset? ReadUpTo { get { lock (_gate) return _readUpTo; } }

    /// <summary>Why the last read failed, or null.</summary>
    public string? Error { get { lock (_gate) return _error; } }

    public void RecordLink(string caller, string target, bool gateway, IEnumerable<DateOnly> days)
    {
        lock (_gate)
        {
            if (!_links.TryGetValue((caller, target, gateway), out var seen)) _links[(caller, target, gateway)] = seen = [];
            foreach (var day in days) seen.Add(day);
            _version++;
        }
    }

    public void RecordUnresolved(string caller, string host, string? path, IEnumerable<DateOnly> days, double calls)
    {
        lock (_gate)
        {
            var key = (caller, host, path ?? "");
            var (seen, total) = _unresolved.TryGetValue(key, out var old) ? old : ([], 0d);
            foreach (var day in days) seen.Add(day);
            _unresolved[key] = (seen, Math.Max(total, calls));
            _version++;
        }
    }

    public void Finish(DateTimeOffset readUpTo)
    {
        lock (_gate)
        {
            _readUpTo = readUpTo;
            _error = null;
            _version++;
        }
    }

    public void Fail(string error)
    {
        lock (_gate)
        {
            _error = error;
            _version++;
        }
    }

    /// <summary>Forgets days older than <paramref name="keepFor"/> and the links and addresses with none left.</summary>
    public void Prune(DateTimeOffset now, TimeSpan keepFor)
    {
        var oldest = DateOnly.FromDateTime(now.UtcDateTime - keepFor);
        lock (_gate)
        {
            foreach (var key in _links.Keys.ToList())
            {
                _links[key].RemoveWhere(d => d < oldest);
                if (_links[key].Count == 0) _links.Remove(key);
            }
            foreach (var key in _unresolved.Keys.ToList())
            {
                _unresolved[key].Days.RemoveWhere(d => d < oldest);
                if (_unresolved[key].Days.Count == 0) _unresolved.Remove(key);
            }
            _version++;
        }
    }

    /// <summary>The links seen on at least <paramref name="minDays"/> different days that have not gone <paramref name="keepFor"/> without being seen.</summary>
    public IReadOnlyList<FoundLink> Found(DateTimeOffset now, int minDays, TimeSpan keepFor)
    {
        var oldest = DateOnly.FromDateTime(now.UtcDateTime - keepFor);
        lock (_gate)
            return _links.Select(kv => (kv.Key, Days: kv.Value.Where(d => d >= oldest).ToList()))
                .Where(x => x.Days.Count >= minDays)
                .Select(x => new FoundLink(x.Key.Caller, x.Key.Target, x.Key.Gateway, x.Days.Max()))
                .OrderBy(l => l.Caller, StringComparer.Ordinal).ThenBy(l => l.Target, StringComparer.Ordinal)
                .ToList();
    }

    /// <summary>
    /// One line for each address no rule explains that was seen on at least <paramref name="minDays"/> days (the busiest first), so a missing rule shows
    /// up as something to add. At most <paramref name="limit"/> lines, then one that counts the rest. A failed read comes first.
    /// </summary>
    public IReadOnlyList<string> Notices(int minDays, int limit = 20)
    {
        lock (_gate)
        {
            var lines = new List<string>();
            if (_error is not null) lines.Add($"Link discovery failed, still showing the links found before: {_error}");
            if (Traffic.Error is { } trafficError) lines.Add($"Link traffic could not be read, so the split between outside and town callers keeps its last numbers: {trafficError}");
            var open = _unresolved.Where(kv => kv.Value.Days.Count >= minDays).OrderByDescending(kv => kv.Value.Calls).ThenBy(kv => kv.Key.Host, StringComparer.Ordinal).ToList();
            foreach (var ((caller, host, path), (days, calls)) in open.Take(limit))
                lines.Add($"Unresolved call: '{caller}' calls {host}{path}, about {Math.Round(calls):0} calls on {days.Count} days, and no links rule explains it. Add a rule, an ignore pattern or a third party domain.");
            if (open.Count > limit) lines.Add($"Link discovery: {open.Count - limit} more unresolved calls not shown.");
            return lines;
        }
    }

    public void Save()
    {
        if (_folder is null) return;
        lock (_gate)
        {
            Directory.CreateDirectory(_folder);
            var byPillar = _links.GroupBy(kv => kv.Key.Caller.Split('.')[0]).ToDictionary(g => g.Key, g => g.ToList());
            foreach (var file in Directory.GetFiles(_folder, "*.yaml").Where(f => Path.GetFileName(f) != StateFile && !byPillar.ContainsKey(Path.GetFileNameWithoutExtension(f))))
                File.Delete(file);
            foreach (var (pillar, links) in byPillar)
                WriteIfChanged(Path.Combine(_folder, pillar + ".yaml"), Writer.Serialize(new LinksFile
                {
                    Links = links.OrderBy(kv => kv.Key.Caller, StringComparer.Ordinal).ThenBy(kv => kv.Key.Target, StringComparer.Ordinal)
                        .Select(kv => new LinkEntry { Caller = kv.Key.Caller, Target = kv.Key.Target, Gateway = kv.Key.Gateway, LastSeen = kv.Value.Max().ToString("yyyy-MM-dd"), Days = kv.Value.Select(d => d.ToString("yyyy-MM-dd")).ToList() }).ToList(),
                }));
            WriteIfChanged(Path.Combine(_folder, StateFile), Writer.Serialize(new StateData
            {
                ReadUpTo = _readUpTo?.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                Unresolved = _unresolved.OrderBy(kv => kv.Key.Caller, StringComparer.Ordinal).ThenBy(kv => kv.Key.Host, StringComparer.Ordinal)
                    .Select(kv => new UnresolvedEntry { Caller = kv.Key.Caller, Host = kv.Key.Host, Path = kv.Key.Path.Length == 0 ? null : kv.Key.Path, Calls = kv.Value.Calls, Days = kv.Value.Days.Select(d => d.ToString("yyyy-MM-dd")).ToList() }).ToList(),
            }));
        }
    }

    private static void WriteIfChanged(string path, string text)
    {
        if (!File.Exists(path) || File.ReadAllText(path) != text) File.WriteAllText(path, text);
    }

    private void Load(string folder, ILogger? log)
    {
        if (!Directory.Exists(folder)) return;
        foreach (var file in Directory.GetFiles(folder, "*.yaml").OrderBy(f => f, StringComparer.Ordinal))
        {
            try
            {
                var text = File.ReadAllText(file);
                if (Path.GetFileName(file) == StateFile)
                {
                    var state = Reader.Deserialize<StateData>(text);
                    if (state is null) continue;
                    if (DateTimeOffset.TryParse(state.ReadUpTo, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var at)) _readUpTo = at;
                    foreach (var u in state.Unresolved)
                        _unresolved[(u.Caller, u.Host, u.Path ?? "")] = (Days(u.Days), u.Calls);
                    continue;
                }
                foreach (var l in Reader.Deserialize<LinksFile>(text)?.Links ?? [])
                    _links[(l.Caller, l.Target, l.Gateway)] = Days(l.Days);
            }
            catch (Exception e) when (e is IOException or YamlDotNet.Core.YamlException)
            {
                // a damaged cache is read again from the telemetry; losing it costs one long read, never the town
                log?.LogWarning(e, "Could not read {File}; link discovery will find those links again", file);
            }
        }
    }

    private static SortedSet<DateOnly> Days(IEnumerable<string> days) =>
        [.. days.Select(d => DateOnly.TryParse(d, out var day) ? (DateOnly?)day : null).OfType<DateOnly>()];

    private sealed class LinksFile { public List<LinkEntry> Links { get; set; } = []; }
    private sealed class LinkEntry
    {
        public string Caller { get; set; } = "";
        public string Target { get; set; } = "";
        public bool Gateway { get; set; }
        public string LastSeen { get; set; } = "";
        public List<string> Days { get; set; } = [];
    }
    private sealed class StateData
    {
        public string? ReadUpTo { get; set; }
        public List<UnresolvedEntry> Unresolved { get; set; } = [];
    }
    private sealed class UnresolvedEntry
    {
        public string Caller { get; set; } = "";
        public string Host { get; set; } = "";
        public string? Path { get; set; }
        public double Calls { get; set; }
        public List<string> Days { get; set; } = [];
    }
}
