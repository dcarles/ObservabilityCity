using System.Text.RegularExpressions;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ObservabilityCity.Core.Registry;

/// <summary>
/// One entry of the discovered file as the panel lists it: a third party or one of the company's own services (Kind vendor or internal), or an ignored
/// host (Kind ignore). Id is what Remove asks for: the vendor's id, or the ignore pattern itself. Host is the first domain of a vendor, or the host an
/// ignore pattern matches. CalledBy is who calls a vendor.
/// </summary>
public sealed record AddedHost(string Id, string Name, string Host, string Kind, IReadOnlyList<string> CalledBy);

/// <summary>What the panel asks to add: a host, and what to make of it.</summary>
public sealed record AddHost(string Host, string Kind, IReadOnlyList<string> CalledBy);

/// <summary>A links rule added from the panel: calls to this host whose path starts like this go to this system, through the gateway.</summary>
public sealed record AddRule(string Host, string Path, string Target);

/// <summary>
/// The hosts added from the Unknown hosts panel, kept in the town's <c>_discovered/third-parties.yaml</c>. The file has the same shape as
/// <c>third-parties.yaml</c> (a <c>vendors:</c> list with the same keys), plus an <c>ignoreHosts:</c> list like the environment file's. The app writes
/// the entries it adds, and every key of a vendor survives a later save, so the file can be edited by hand (a name, an SLA, services). Comments do not
/// survive a save. The registry reads it next to <c>third-parties.yaml</c> (which wins when both have the same id) and adds the ignored hosts to every
/// environment's <c>links.ignoreHosts</c>. A broken file is read as empty: it never stops the town.
/// </summary>
public static class AddedHosts
{
    public const string FileName = "third-parties.yaml";
    public const string VendorKind = "vendor";
    public const string InternalKind = "internal";
    public const string IgnoreKind = "ignore";
    public const string RuleKind = "rule";
    public static readonly string[] Kinds = [VendorKind, InternalKind, IgnoreKind];

    private static readonly object Gate = new();
    private static readonly ISerializer Writer = new SerializerBuilder().WithNamingConvention(CamelCaseNamingConvention.Instance)
        .ConfigureDefaultValuesHandling(DefaultValuesHandling.OmitDefaults | DefaultValuesHandling.OmitEmptyCollections).Build();
    private static readonly IDeserializer Reader = new DeserializerBuilder().WithNamingConvention(CamelCaseNamingConvention.Instance).IgnoreUnmatchedProperties().Build();
    private static readonly Regex HostName = new(@"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    public static string PathIn(string folder) => Path.Combine(folder, RegistryReloader.DiscoveredFolder, FileName);

    /// <summary>Whether the text can be added: a plain host name, no scheme, port or path.</summary>
    public static bool IsHostName(string host) => host.Length is > 0 and <= 253 && HostName.IsMatch(host);

    /// <summary>The id the vendor of a host gets: <c>ext.</c> and the host with its dots made dashes.</summary>
    public static string VendorId(string host) => "ext." + Regex.Replace(host.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');

    /// <summary>An <c>ignoreHosts</c> pattern that matches exactly this host.</summary>
    public static string IgnorePattern(string host) => "^" + Regex.Escape(host) + "$";

    /// <summary>
    /// A path pattern for the paths a rule should explain: the first two parts of the path, so every call under that service is explained and not one
    /// path at a time. Written into the file, where it can be made wider or narrower by hand.
    /// </summary>
    public static string PathPattern(string path)
    {
        var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries).Take(2).ToList();
        return parts.Count == 0 ? "^/" : "^/" + string.Join("/", parts.Select(Regex.Escape)) + "(/|$)";
    }

    /// <summary>The rules of the file, in order.</summary>
    internal static IReadOnlyList<LinkRuleFile> RulesIn(string folder)
    {
        lock (Gate) return Load(folder).Rules;
    }

    /// <summary>The file as the registry reads it. A missing or damaged file is empty.</summary>
    internal static ThirdPartiesFile ReadFile(string folder)
    {
        lock (Gate) return new ThirdPartiesFile { Vendors = Load(folder).Vendors };
    }

    /// <summary>The ignore patterns of the file, in order.</summary>
    internal static IReadOnlyList<string> IgnorePatterns(string folder)
    {
        lock (Gate) return Load(folder).IgnoreHosts;
    }

    /// <summary>Everything in the file, vendors first, as the panel lists it.</summary>
    public static IReadOnlyList<AddedHost> Read(string folder)
    {
        lock (Gate)
        {
            var file = Load(folder);
            return file.Vendors.Select(v => new AddedHost(v.Id, v.Name ?? v.Id, v.Domains.FirstOrDefault() ?? v.Id, v.Internal ? InternalKind : VendorKind, v.CalledBy))
                .Concat(file.IgnoreHosts.Select(p => new AddedHost(p, HostOf(p), HostOf(p), IgnoreKind, [])))
                .Concat(file.Rules.Select(r => new AddedHost(RuleId(r), r.Target, r.Path ?? r.Host, RuleKind, [])))
                .ToList();
        }
    }

    /// <summary>Adds a host. One already there changes kind (and callers) and keeps every other key it was given, such as a name that was edited.</summary>
    public static void Add(string folder, AddHost host)
    {
        lock (Gate)
        {
            var file = Load(folder);
            if (host.Kind == IgnoreKind)
            {
                var pattern = IgnorePattern(host.Host);
                if (!file.IgnoreHosts.Contains(pattern, StringComparer.Ordinal)) file.IgnoreHosts.Add(pattern);
                file.Vendors.RemoveAll(v => v.Id == VendorId(host.Host));
            }
            else
            {
                var id = VendorId(host.Host);
                var vendor = file.Vendors.FirstOrDefault(v => v.Id == id);
                if (vendor is null) file.Vendors.Add(vendor = new VendorFile { Id = id, Name = host.Host, Domains = [host.Host] });
                vendor.CalledBy = host.CalledBy.ToList();
                vendor.Internal = host.Kind == InternalKind;
                file.IgnoreHosts.RemoveAll(p => p == IgnorePattern(host.Host));
            }
            Save(folder, file);
        }
    }

    /// <summary>Adds a rule for a path on a gateway host, unless an identical one is there.</summary>
    public static void AddRule(string folder, AddRule rule)
    {
        lock (Gate)
        {
            var file = Load(folder);
            var entry = new LinkRuleFile { Host = IgnorePattern(rule.Host), Path = PathPattern(rule.Path), Target = rule.Target, Gateway = true };
            if (!file.Rules.Any(r => RuleId(r) == RuleId(entry))) file.Rules.Add(entry);
            Save(folder, file);
        }
    }

    /// <summary>What Remove asks for to take a rule out.</summary>
    private static string RuleId(LinkRuleFile r) => $"rule:{r.Host}|{r.Path}|{r.Target}";

    /// <summary>Takes an entry out by its id (a vendor's id or an ignore pattern). False when it was not there.</summary>
    public static bool Remove(string folder, string id)
    {
        lock (Gate)
        {
            var file = Load(folder);
            var removed = file.Vendors.RemoveAll(v => string.Equals(v.Id, id, StringComparison.OrdinalIgnoreCase)) + file.IgnoreHosts.RemoveAll(p => p == id) + file.Rules.RemoveAll(r => RuleId(r) == id);
            if (removed == 0) return false;
            Save(folder, file);
            return true;
        }
    }

    private static string HostOf(string pattern) =>
        pattern.StartsWith('^') && pattern.EndsWith('$') ? Regex.Unescape(pattern[1..^1]) : pattern;

    private static Stored Load(string folder)
    {
        var path = PathIn(folder);
        if (!File.Exists(path)) return new Stored();
        try
        {
            var file = Reader.Deserialize<Stored>(File.ReadAllText(path)) ?? new Stored();
            file.Vendors = (file.Vendors ?? []).Where(v => v is { Id.Length: > 0 }).ToList();
            file.IgnoreHosts = (file.IgnoreHosts ?? []).Where(p => !string.IsNullOrWhiteSpace(p)).ToList();
            file.Rules = (file.Rules ?? []).Where(r => !string.IsNullOrWhiteSpace(r.Host) && !string.IsNullOrWhiteSpace(r.Target)).ToList();
            // the first version of this file listed `added:` entries; they are read as the vendors and ignored hosts they stand for, and saved in the new shape next time
            foreach (var old in file.Added ?? [])
            {
                if (!IsHostName(old.Host ?? "")) continue;
                if (old.Kind == IgnoreKind)
                {
                    if (!file.IgnoreHosts.Contains(IgnorePattern(old.Host!))) file.IgnoreHosts.Add(IgnorePattern(old.Host!));
                }
                else if (!file.Vendors.Any(v => v.Id == VendorId(old.Host!)))
                    file.Vendors.Add(new VendorFile { Id = VendorId(old.Host!), Name = old.Host, CalledBy = old.CalledBy ?? [], Domains = [old.Host!], Internal = old.Kind == InternalKind });
            }
            // an old file is saved in the new shape at once, so it can be edited by hand right away
            var converted = file.Added is { Count: > 0 };
            file.Added = null;
            if (converted) { try { Save(folder, file); } catch (IOException) { /* read-only folder: the converted entries still apply */ } }
            return file;
        }
        catch (Exception e) when (e is IOException or YamlDotNet.Core.YamlException) { return new Stored(); }
    }

    private static void Save(string folder, Stored file)
    {
        var path = PathIn(folder);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        // written beside the file and moved over it, so a reader never sees half a file
        var temp = path + ".tmp";
        File.WriteAllText(temp, Writer.Serialize(file));
        File.Move(temp, path, overwrite: true);
    }

    private sealed class Stored
    {
        public List<VendorFile> Vendors { get; set; } = [];
        public List<string> IgnoreHosts { get; set; } = [];
        public List<LinkRuleFile> Rules { get; set; } = [];
        /// <summary>The first version of the file. Only read.</summary>
        public List<OldEntry>? Added { get; set; }
    }

    private sealed class OldEntry
    {
        public string? Host { get; set; }
        public string? Kind { get; set; }
        public List<string>? CalledBy { get; set; }
    }
}
