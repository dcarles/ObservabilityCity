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
            NodeKind.Cron => (0.2, 20000.0, 1.0, 1, 1),
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
        };
    }
}
