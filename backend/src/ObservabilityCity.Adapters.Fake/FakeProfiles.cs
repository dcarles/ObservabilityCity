using ObservabilityCity.Contracts;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ObservabilityCity.Adapters.Fake;

/// <summary>Baseline numbers for one node. All optional; the kind supplies the rest.</summary>
public sealed class FakeProfile
{
    public double? Rps { get; set; }
    public double? P99Ms { get; set; }
    public double? ErrorRate { get; set; }
    public double? PerInstanceRps { get; set; }
    public int? MinInstances { get; set; }
    public int? MaxInstances { get; set; }
    /// <summary>Regions the service runs in, with the weight of each in its requests. Two or more make the region view show.</summary>
    public Dictionary<string, double>? Regions { get; set; }
}

/// <summary>Reads fake.yaml from a registry folder: node id to profile. The file is optional.</summary>
public static class FakeProfiles
{
    public static IReadOnlyDictionary<string, FakeProfile> Load(string registryFolder)
    {
        var path = Path.Combine(registryFolder, "fake.yaml");
        if (!File.Exists(path)) return new Dictionary<string, FakeProfile>();
        var yaml = new DeserializerBuilder().WithNamingConvention(CamelCaseNamingConvention.Instance).Build();
        return yaml.Deserialize<Dictionary<string, FakeProfile>>(File.ReadAllText(path)) ?? new();
    }

    public static FakeProfile Fill(FakeProfile? p, NodeKind kind)
    {
        var (rps, p99, perInst, min, max) = kind switch
        {
            NodeKind.Api => (120.0, 180.0, 40.0, 2, 24),
            NodeKind.Worker => (30.0, 6000.0, 12.0, 1, 12),
            NodeKind.Database => (200.0, 25.0, 120.0, 2, 6),
            NodeKind.Cache => (400.0, 3.0, 300.0, 2, 6),
            NodeKind.Function => (0.2, 20000.0, 1.0, 1, 1),
            NodeKind.Gateway => (500.0, 90.0, 120.0, 3, 40),
            NodeKind.Broker => (260.0, 12.0, 120.0, 2, 8),
            _ => (60.0, 400.0, 30.0, 2, 10),
        };
        return new FakeProfile
        {
            Rps = p?.Rps ?? rps,
            P99Ms = p?.P99Ms ?? p99,
            ErrorRate = p?.ErrorRate ?? 0.002,
            PerInstanceRps = p?.PerInstanceRps ?? perInst,
            MinInstances = p?.MinInstances ?? min,
            MaxInstances = p?.MaxInstances ?? max,
            Regions = p?.Regions,
        };
    }
}

/// <summary>
/// Reads fake-assets.yaml from a registry folder: the basic buildings (key vault, storage, App Configuration) a demo town shows, with no inventory behind them.
/// The file is optional. Each entry names its pillar (or <c>hub</c>, with a <c>group</c>: the cluster it stands in), and may name the service it belongs to (the registry's service name).
/// </summary>
public static class FakeAssets
{
    private sealed class Entry
    {
        public string Pillar { get; set; } = "";
        public string Name { get; set; } = "";
        public string? Label { get; set; }
        public string Shape { get; set; } = "box";
        public string? Service { get; set; }
        public string? Region { get; set; }
        public string? Group { get; set; }
    }

    public static IReadOnlyList<Core.Scope.ResolvedAsset> Load(string registryFolder)
    {
        var path = Path.Combine(registryFolder, "fake-assets.yaml");
        if (!File.Exists(path)) return [];
        var yaml = new DeserializerBuilder().WithNamingConvention(CamelCaseNamingConvention.Instance).Build();
        return (yaml.Deserialize<List<Entry>>(File.ReadAllText(path)) ?? [])
            .Select(e => new Core.Scope.ResolvedAsset($"{e.Pillar}.{e.Name.ToLowerInvariant()}", e.Pillar, e.Name, e.Label ?? e.Shape, e.Shape, "demo", e.Service, e.Region, "", "demo", null, e.Group))
            .ToList();
    }
}
