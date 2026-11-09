using System.Text.RegularExpressions;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace ObservabilityCity.Validate;

/// <summary>Rules about thresholds, services and database engines. Part of <see cref="RegistryValidator"/>.</summary>
public static partial class RegistryValidator
{
    private static void CheckThresholds(Context c, Registry registry)
    {
        var flagged = new HashSet<string>();
        var badDefaults = new HashSet<string>(); // "defaults.yaml|role" or "pillars/x.yaml|role": the cause is reported there, not on every system
        var defaults = c.Raw("defaults.yaml");
        if (defaults.Root is not null)
            foreach (var (role, block) in defaults.Root.Children)
                if (block is YamlMappingNode map && CheckBlock(c, "defaults.yaml", map, RawYaml.Str(role) ?? "?", null)) badDefaults.Add($"defaults.yaml|{RawYaml.Str(role)}");

        foreach (var file in c.RootFiles("hub.yaml").Concat(c.PillarFiles()))
        {
            var raw = c.Raw(file);
            if (raw.Root is null) continue;
            if (RawYaml.Get(raw.Root, "defaults") is YamlMappingNode pd)
                foreach (var (role, block) in pd.Children)
                    if (block is YamlMappingNode map && CheckBlock(c, file, map, $"defaults for {RawYaml.Str(role)}", null)) badDefaults.Add($"{file}|{RawYaml.Str(role)}");
            foreach (var key in new[] { "systems", "resources" })
                foreach (var system in raw.Entries(key))
                {
                    var id = RawYaml.Str(RawYaml.Get(system, "id")) ?? "?";
                    if (CheckBlock(c, file, system, id, id)) flagged.Add(id);
                }
        }

        // a system whose own numbers are fine can still end up inverted once they meet the defaults
        foreach (var n in registry.AllNodes.Where(n => !flagged.Contains(n.Id)))
        {
            var where = c.Locate(n.Id);
            var role = n.Kind == NodeKind.Database ? "db" : n.Kind.ToString().ToLowerInvariant();
            if (badDefaults.Contains($"defaults.yaml|{role}") || badDefaults.Contains($"{where.File}|{role}")) continue;
            void Inverted(string what, double amber, double red)
            {
                if (amber >= red) c.Error(where.File, where.Line, "threshold", $"'{n.Id}' ends up with {what} amber ({amber}) at or above red ({red}) after the defaults are applied.");
            }
            Inverted("error", n.ErrorAmber, n.ErrorRed);
            Inverted("resource", n.ResourceAmber, n.ResourceRed);
            Inverted("throttle", n.ThrottleAmber, n.ThrottleRed);
            Inverted("backlog", n.BacklogAmber, n.BacklogRed);
        }
    }

    /// <summary>Checks one block of threshold settings. Returns true when it found a problem.</summary>
    private static bool CheckBlock(Context c, string file, YamlMappingNode block, string owner, string? systemId)
    {
        var bad = false;
        void Err(YamlNode at, string message)
        {
            bad = true;
            c.Error(file, RawYaml.Line(at), "threshold", $"{owner}: {message}");
        }

        if (RawYaml.Get(block, "slaP99Ms") is { } sla && RawYaml.Number(sla) is not > 0)
            Err(sla, $"slaP99Ms must be a number above 0 (milliseconds), not '{RawYaml.Str(sla)}'.");

        foreach (var name in Blocks)
        {
            if (RawYaml.Get(block, name) is not YamlMappingNode map) continue;
            var upper = name == "backlog" ? double.PositiveInfinity : 1.0;
            var unit = name == "backlog" ? "seconds above 0" : "a share between 0 and 1 (0.05 is 5%)";
            double? amber = null, red = null;
            foreach (var level in new[] { "amber", "red" })
            {
                if (RawYaml.Get(map, level) is not { } node) continue;
                var v = RawYaml.Number(node);
                if (v is null or <= 0 || v > upper) Err(node, $"{name}.{level} must be {unit}, not '{RawYaml.Str(node)}'.");
                else if (level == "amber") amber = v;
                else red = v;
            }
            if (amber is not null && red is not null && amber >= red)
                Err(map, $"{name}.amber ({amber}) must be below {name}.red ({red}), or amber would never show.");
        }
        return bad;
    }

    // ── calls ───────────────────────────────────────────────────────────────

    /// <summary>Once a town lists its database engines, a database that does not say which one it runs on is a gap in its labels.</summary>
    private static void CheckDatabaseEngines(Context c, Registry registry)
    {
        if (registry.DatabaseEngines.Count == 0) return;
        foreach (var n in registry.AllNodes.Where(n => n.Kind == NodeKind.Database && n.Engine is null && !n.Id.StartsWith(RegistryVendor.GroupId + ".")))
        {
            var at = c.Locate(n.Id);
            c.Warn(at.File, at.Line, "db-engine", $"Database '{n.Id}' has no engine, so it shows no engine label. Add engine: with one of {string.Join(", ", registry.DatabaseEngines.Select(e => e.Id))}.");
        }
    }

    /// <summary>A service belongs to one pillar: the same service name in two would be drawn as two unrelated pads and read as one in the topics.</summary>
    private static void CheckServices(Context c, Registry registry)
    {
        var owners = new Dictionary<string, List<string>>(); // service to the pillars that use it
        foreach (var g in registry.Groups.Where(g => !g.IsHub && g.ConfigError is null))
            foreach (var service in g.Nodes.Select(n => n.Service).OfType<string>().Distinct())
                (owners.TryGetValue(service, out var l) ? l : owners[service] = []).Add(g.Id);
        foreach (var (service, pillars) in owners.Where(o => o.Value.Count > 1))
            foreach (var pillar in pillars)
            {
                var first = registry.Groups.First(g => g.Id == pillar).Nodes.First(n => n.Service == service);
                var at = c.Locate(first.Id);
                c.Warn(at.File, at.Line, "service-split",
                    $"Service '{service}' is split across pillars {string.Join(" and ", pillars.Select(p => $"'{p}'"))}. A service belongs to one pillar: give each its own name (for example '{pillar}-{service}'), or move the systems together.");
            }
    }

    // ── environments and tenants ────────────────────────────────────────────
}
