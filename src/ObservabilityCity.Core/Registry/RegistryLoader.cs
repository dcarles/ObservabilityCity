using System.Text.RegularExpressions;
using ObservabilityCity.Contracts;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ObservabilityCity.Core.Registry;

/// <summary>
/// Loads a registry folder: town.yaml, defaults.yaml, hub.yaml and pillars/*.yaml.
/// Settings resolve through defaults.yaml, then the pillar's defaults, then the system's own values.
/// </summary>
public static class RegistryLoader
{
    private static readonly Regex KebabId = new("^[a-z0-9]+(-[a-z0-9]+)*$", RegexOptions.Compiled);

    private static readonly IDeserializer Yaml = new DeserializerBuilder()
        .WithNamingConvention(CamelCaseNamingConvention.Instance)
        .IgnoreUnmatchedProperties()
        .Build();

    // Last resort when defaults.yaml is missing or silent about a role.
    private static readonly RoleDefaultsFile BuiltIn = new()
    {
        SlaP99Ms = 1000,
        Errors = new ErrorThresholdsFile { Amber = 0.01, Red = 0.05 },
        Resources = new ErrorThresholdsFile { Amber = 0.80, Red = 0.95 },
        Throttle = new ErrorThresholdsFile { Amber = 0.001, Red = 0.02 },
    };

    public static Registry Load(string folder)
    {
        if (!Directory.Exists(folder))
            throw new RegistryException($"Registry folder not found: {folder}");

        var town = Read<TownFile>(Path.Combine(folder, "town.yaml"));
        var defaults = File.Exists(Path.Combine(folder, "defaults.yaml"))
            ? Read<DefaultsFile>(Path.Combine(folder, "defaults.yaml"))
            : new DefaultsFile();
        var hub = Read<HubFile>(Path.Combine(folder, "hub.yaml"));

        var groups = new List<RegistryGroup>();
        var ids = new HashSet<string>();

        var hubNodes = hub.Resources
            .Select(r => ToNode(r, "hub", "hub.yaml", "hub", defaults, new DefaultsFile(), false, ids))
            .ToList();
        groups.Add(new RegistryGroup("hub", hub.DisplayName, hub.Color, true, hubNodes));

        var pillarDir = Path.Combine(folder, "pillars");
        if (Directory.Exists(pillarDir))
        {
            foreach (var file in Directory.GetFiles(pillarDir, "*.yaml").OrderBy(f => f, StringComparer.Ordinal))
            {
                var p = Read<PillarFile>(file);
                var name = Path.GetFileName(file);
                if (!KebabId.IsMatch(p.Pillar))
                    throw new RegistryException($"{name}: pillar '{p.Pillar}' must be lowercase kebab-case");
                if (Path.GetFileNameWithoutExtension(file) != p.Pillar)
                    throw new RegistryException($"{name}: pillar '{p.Pillar}' must match the file name");

                var nodes = p.Systems
                    .Select(s => ToNode(s, p.Pillar, name, p.Pillar, defaults, p.Defaults, p.External, ids))
                    .ToList();
                groups.Add(new RegistryGroup(p.Pillar, p.DisplayName, p.Color, false, nodes));
            }
        }

        return new Registry(new TownInfo(town.Id, town.Name, town.GroupLabel, town.Topology), groups);
    }

    private static RegistryNode ToNode(
        SystemFile s, string groupId, string fileName, string prefix,
        DefaultsFile appDefaults, DefaultsFile pillarDefaults, bool pillarExternal, HashSet<string> ids)
    {
        var dot = s.Id.IndexOf('.');
        if (dot <= 0 || s.Id[..dot] != prefix || !KebabId.IsMatch(s.Id[(dot + 1)..]))
            throw new RegistryException($"{fileName}: id '{s.Id}' must look like '{prefix}.some-name'");
        if (!ids.Add(s.Id))
            throw new RegistryException($"{fileName}: id '{s.Id}' is used twice in this town");

        var kind = ParseKind(s.Role, s.Id, fileName);
        var role = kind == NodeKind.Database ? "db" : kind.ToString().ToLowerInvariant(); // the YAML spelling
        appDefaults.TryGetValue(role, out var app);
        pillarDefaults.TryGetValue(role, out var pillar);

        double Resolve(Func<RoleDefaultsFile?, double?> pick, double? own) =>
            own ?? pick(pillar) ?? pick(app) ?? pick(BuiltIn)!.Value;

        return new RegistryNode(
            s.Id,
            s.Name ?? s.Id[(dot + 1)..],
            groupId,
            kind,
            s.Service,
            s.External ?? pillarExternal,
            Resolve(d => d?.SlaP99Ms, s.SlaP99Ms),
            Resolve(d => d?.Errors?.Amber, s.Errors?.Amber),
            Resolve(d => d?.Errors?.Red, s.Errors?.Red),
            Resolve(d => d?.Resources?.Amber, s.Resources?.Amber),
            Resolve(d => d?.Resources?.Red, s.Resources?.Red),
            Resolve(d => d?.Throttle?.Amber, s.Throttle?.Amber),
            Resolve(d => d?.Throttle?.Red, s.Throttle?.Red));
    }

    private static NodeKind ParseKind(string? role, string id, string fileName)
    {
        if (role is null)
            throw new RegistryException($"{fileName}: '{id}' needs a role (role inference arrives with telemetry)");
        return role.ToLowerInvariant() switch
        {
            "api" => NodeKind.Api,
            "worker" => NodeKind.Worker,
            "db" or "database" => NodeKind.Database,
            "cache" => NodeKind.Cache,
            "cron" => NodeKind.Cron,
            "gateway" => NodeKind.Gateway,
            "broker" => NodeKind.Broker,
            "egress" => NodeKind.Egress,
            _ => throw new RegistryException(
                $"{fileName}: '{id}' has unknown role '{role}'. Use api, worker, db, cache, cron, gateway, broker or egress"),
        };
    }

    private static T Read<T>(string path)
    {
        if (!File.Exists(path))
            throw new RegistryException($"Registry file not found: {path}");
        try
        {
            return Yaml.Deserialize<T>(File.ReadAllText(path)) ?? throw new RegistryException($"{path} is empty");
        }
        catch (YamlDotNet.Core.YamlException e)
        {
            throw new RegistryException($"{Path.GetFileName(path)}: {e.Message}");
        }
    }
}
