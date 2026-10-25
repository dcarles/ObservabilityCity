using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace ObservabilityCity.Validate;

/// <summary>
/// A registry file read as a plain YAML tree, which keeps line numbers (the loader's typed model does not).
/// A file that cannot be parsed has no Root; the loader reports that problem itself.
/// </summary>
internal sealed class RawYaml
{
    public string Path { get; }
    public YamlMappingNode? Root { get; }

    private RawYaml(string path, YamlMappingNode? root)
    {
        Path = path;
        Root = root;
    }

    public static RawYaml Load(string path)
    {
        if (!File.Exists(path)) return new RawYaml(path, null);
        try
        {
            var stream = new YamlStream();
            using var reader = new StreamReader(path);
            stream.Load(reader);
            return new RawYaml(path, stream.Documents.Count > 0 ? stream.Documents[0].RootNode as YamlMappingNode : null);
        }
        catch (YamlException)
        {
            return new RawYaml(path, null);
        }
    }

    public static YamlNode? Get(YamlMappingNode? map, string key)
    {
        if (map is null) return null;
        foreach (var (k, v) in map.Children)
            if (k is YamlScalarNode { Value: { } name } && name == key) return v;
        return null;
    }

    public static string? Str(YamlNode? node) => (node as YamlScalarNode)?.Value;

    public static int Line(YamlNode node) => (int)node.Start.Line;

    public static double? Number(YamlNode? node) =>
        Str(node) is { } s && double.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : null;

    /// <summary>The entries of a sequence node, or none when the node is missing or not a sequence.</summary>
    public static IEnumerable<YamlNode> Items(YamlNode? node) => node is YamlSequenceNode seq ? seq.Children : [];

    /// <summary>The mappings under a key such as "systems" or "resources".</summary>
    public IEnumerable<YamlMappingNode> Entries(string key) => Items(Get(Root, key)).OfType<YamlMappingNode>();

    /// <summary>The line of the first place a scalar with this value appears, preferring an "id:" value.</summary>
    public int? FindScalar(string value)
    {
        if (Root is null) return null;
        int? any = null;
        foreach (var node in Walk(Root))
        {
            if (node is not YamlMappingNode map) continue;
            foreach (var (k, v) in map.Children)
            {
                if (v is not YamlScalarNode { Value: { } s } || s != value) continue;
                if (Str(k) == "id") return Line(v);
                any ??= Line(v);
            }
        }
        if (any is null)
            foreach (var node in Walk(Root))
                if (node is YamlSequenceNode seq)
                    foreach (var item in seq.Children)
                        if (Str(item) == value) return Line(item);
        return any;
    }

    /// <summary>The line of "callee" inside the calls list of the system with this id.</summary>
    public int? FindCall(string systemId, string callee)
    {
        foreach (var key in new[] { "systems", "resources" })
            foreach (var system in Entries(key))
                if (Str(Get(system, "id")) == systemId)
                    foreach (var c in Items(Get(system, "calls")))
                        if (Str(c) == callee) return Line(c);
        return null;
    }

    public int? FindSystem(string systemId)
    {
        foreach (var key in new[] { "systems", "resources" })
            foreach (var system in Entries(key))
                if (Get(system, "id") is { } id && Str(id) == systemId) return Line(id);
        return null;
    }

    private static IEnumerable<YamlNode> Walk(YamlNode node)
    {
        yield return node;
        switch (node)
        {
            case YamlMappingNode map:
                foreach (var (k, v) in map.Children)
                {
                    foreach (var x in Walk(k)) yield return x;
                    foreach (var x in Walk(v)) yield return x;
                }
                break;
            case YamlSequenceNode seq:
                foreach (var c in seq.Children)
                    foreach (var x in Walk(c)) yield return x;
                break;
        }
    }
}
