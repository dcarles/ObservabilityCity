using System.Text.RegularExpressions;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ObservabilityCity.Core.Registry;

/// <summary>One host somebody added from the Unknown hosts panel: a third party, one of the company's own services, or a host to ignore.</summary>
public sealed record AddedHost(string Host, string Kind, IReadOnlyList<string> CalledBy);

/// <summary>
/// The hosts added from the Unknown hosts panel, kept in the town's <c>_discovered/third-parties.yaml</c>. The app writes the file and nothing else does;
/// the registry reads it when it loads, next to <c>third-parties.yaml</c> (which wins when both have the same id) and adds the ignored hosts to every
/// environment's <c>links.ignoreHosts</c>. A broken file is read as empty: it never stops the town.
/// </summary>
public static class AddedHosts
{
    public const string FileName = "third-parties.yaml";
    public const string VendorKind = "vendor";
    public const string InternalKind = "internal";
    public const string IgnoreKind = "ignore";
    public static readonly string[] Kinds = [VendorKind, InternalKind, IgnoreKind];

    private static readonly object Gate = new();
    private static readonly ISerializer Writer = new SerializerBuilder().WithNamingConvention(CamelCaseNamingConvention.Instance)
        .ConfigureDefaultValuesHandling(DefaultValuesHandling.OmitDefaults).Build();
    private static readonly IDeserializer Reader = new DeserializerBuilder().WithNamingConvention(CamelCaseNamingConvention.Instance).IgnoreUnmatchedProperties().Build();
    private static readonly Regex HostName = new(@"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    public static string PathIn(string folder) => Path.Combine(folder, RegistryReloader.DiscoveredFolder, FileName);

    /// <summary>Whether the text can be added: a plain host name, no scheme, port or path.</summary>
    public static bool IsHostName(string host) => host.Length is > 0 and <= 253 && HostName.IsMatch(host);

    /// <summary>The id the vendor of a host gets: <c>ext.</c> and the host with its dots made dashes.</summary>
    public static string VendorId(string host) => "ext." + Regex.Replace(host.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');

    /// <summary>An <c>ignoreHosts</c> pattern that matches exactly this host.</summary>
    public static string IgnorePattern(string host) => "^" + Regex.Escape(host) + "$";

    /// <summary>Everything added so far, in the order it was added. A missing or damaged file is nothing.</summary>
    public static IReadOnlyList<AddedHost> Read(string folder)
    {
        lock (Gate)
        {
            var path = PathIn(folder);
            if (!File.Exists(path)) return [];
            try
            {
                var file = Reader.Deserialize<StoredHosts>(File.ReadAllText(path));
                return (file?.Added ?? []).Where(a => IsHostName(a.Host) && Kinds.Contains(a.Kind)).Select(a => new AddedHost(a.Host, a.Kind, a.CalledBy)).ToList();
            }
            catch (Exception e) when (e is IOException or YamlDotNet.Core.YamlException) { return []; }
        }
    }

    /// <summary>Adds a host, or changes how it is added when it already is (a host is in the file once).</summary>
    public static void Add(string folder, AddedHost host)
    {
        lock (Gate)
        {
            var all = Read(folder).Where(a => !string.Equals(a.Host, host.Host, StringComparison.OrdinalIgnoreCase)).Append(host).ToList();
            Save(folder, all);
        }
    }

    /// <summary>Takes a host out again. False when it was not there.</summary>
    public static bool Remove(string folder, string host)
    {
        lock (Gate)
        {
            var all = Read(folder);
            var kept = all.Where(a => !string.Equals(a.Host, host, StringComparison.OrdinalIgnoreCase)).ToList();
            if (kept.Count == all.Count) return false;
            Save(folder, kept);
            return true;
        }
    }

    private static void Save(string folder, List<AddedHost> all)
    {
        var path = PathIn(folder);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var text = Writer.Serialize(new StoredHosts { Added = all.Select(a => new StoredHost { Host = a.Host, Kind = a.Kind, CalledBy = a.CalledBy.ToList() }).ToList() });
        // written beside the file and moved over it, so a reader never sees half a file
        var temp = path + ".tmp";
        File.WriteAllText(temp, text);
        File.Move(temp, path, overwrite: true);
    }

    private sealed class StoredHosts
    {
        public List<StoredHost> Added { get; set; } = [];
    }

    private sealed class StoredHost
    {
        public string Host { get; set; } = "";
        public string Kind { get; set; } = "";
        public List<string> CalledBy { get; set; } = [];
    }
}
