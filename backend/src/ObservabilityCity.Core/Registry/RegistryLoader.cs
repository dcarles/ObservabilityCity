using System.Text.RegularExpressions;
using ObservabilityCity.Contracts;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ObservabilityCity.Core.Registry;

/// <summary>
/// Loads a registry folder: town.yaml, defaults.yaml, hub.yaml, an optional layout.yaml and pillars/*.yaml.
/// Settings resolve through defaults.yaml, then the pillar's defaults, then the system's own values.
/// Every problem found in the files is collected and reported together, each naming its file, with a
/// "did you mean" for names that are close to a real one.
/// </summary>
public static class RegistryLoader
{
    private static readonly Regex KebabId = new("^[a-z0-9]+(-[a-z0-9]+)*$", RegexOptions.Compiled);
    private static readonly Regex UnknownKey = new("Property '([^']+)' not found", RegexOptions.Compiled);

    // Strict on purpose: a misspelt key such as "cals" must be an error, not silently ignored.
    private static readonly IDeserializer Yaml = new DeserializerBuilder()
        .WithNamingConvention(CamelCaseNamingConvention.Instance)
        .Build();

    private static readonly string[] Roles = ["api", "worker", "db", "cache", "cron", "gateway", "broker", "egress"];

    // Every key a registry file may use, for suggesting the right one when a key is misspelt.
    private static readonly string[] KnownKeys =
    [
        "id", "name", "groupLabel", "topology", "pillar", "displayName", "color", "external", "defaults", "systems", "resources",
        "externalCallers", "islands", "role", "service", "slaP99Ms", "errors", "resources", "throttle", "backlog", "calls", "aliases",
        "amber", "red", "vendors", "calledBy", "gatewayCalls",
    ];

    // Last resort when defaults.yaml is missing or silent about a role.
    private static readonly RoleDefaultsFile BuiltIn = new()
    {
        SlaP99Ms = 1000,
        Errors = new ErrorThresholdsFile { Amber = 0.01, Red = 0.05 },
        Resources = new ErrorThresholdsFile { Amber = 0.80, Red = 0.95 },
        Throttle = new ErrorThresholdsFile { Amber = 0.001, Red = 0.02 },
        Backlog = new ErrorThresholdsFile { Amber = 60, Red = 300 },
    };

    /// <summary>Strict load: any problem in any file fails the whole load, with every problem listed. This is what CI and the validator use.</summary>
    public static Registry Load(string folder) => Build(folder, resilient: false);

    /// <summary>
    /// Resilient load, for a running app. A pillar file that cannot be read, or has problems of its own, is skipped and its island
    /// is returned empty with a ConfigError, so the rest of the town still renders. Call links that point nowhere are dropped.
    /// Everything worked around is listed in Registry.Notices. The files every pillar depends on (town, defaults, hub, layout)
    /// still have to be sound: when they are not this throws, and the caller keeps the registry it already has.
    /// </summary>
    public static Registry LoadResilient(string folder) => Build(folder, resilient: true);

    private static Registry Build(string folder, bool resilient)
    {
        if (!Directory.Exists(folder))
            throw new RegistryException($"Registry folder not found: {folder}");

        var errors = new List<string>();
        var notices = new List<string>();
        var problems = new List<string>(); // every individual problem a resilient load worked around
        // Problems that are not in a pillar's own file: errors in a strict load, notices in a resilient one.
        void Problem(string message)
        {
            if (!resilient) { errors.Add(message); return; }
            notices.Add(message);
            problems.Add(message);
        }
        var town = Read<TownFile>(Path.Combine(folder, "town.yaml"));
        var defaults = File.Exists(Path.Combine(folder, "defaults.yaml"))
            ? Read<DefaultsFile>(Path.Combine(folder, "defaults.yaml"))
            : new DefaultsFile();
        CheckRoleKeys(defaults, "defaults.yaml", errors);
        var hub = Read<HubFile>(Path.Combine(folder, "hub.yaml"));
        var layoutPath = Path.Combine(folder, "layout.yaml");
        var layout = File.Exists(layoutPath) ? Read<LayoutFile>(layoutPath) : new LayoutFile();

        var thirdPartiesPath = Path.Combine(folder, "third-parties.yaml");
        var thirdParties = File.Exists(thirdPartiesPath) ? Read<ThirdPartiesFile>(thirdPartiesPath) : new ThirdPartiesFile();

        var ids = new HashSet<string>();
        var aliases = new Dictionary<string, string>(); // old id to current id

        var hubNodes = hub.Resources
            .Select(r => ToNode(r, "hub", "hub.yaml", "hub", defaults, new DefaultsFile(), false, ids, aliases, errors))
            .OfType<RegistryNode>()
            .ToList();
        var hubGroup = new RegistryGroup("hub", hub.DisplayName, hub.Color, true, hubNodes);

        var pillars = new List<RegistryGroup>();
        var brokenPillars = new HashSet<string>();
        var pillarDir = Path.Combine(folder, "pillars");
        if (Directory.Exists(pillarDir))
        {
            foreach (var file in Directory.GetFiles(pillarDir, "*.yaml").OrderBy(f => f, StringComparer.Ordinal))
            {
                var name = Path.GetFileName(file);
                var stem = Path.GetFileNameWithoutExtension(file);
                var own = new List<string>();
                RegistryGroup? group = null;
                try
                {
                    group = LoadPillar(file, name, defaults, resilient ? new HashSet<string>(ids) : ids, resilient ? new Dictionary<string, string>(aliases) : aliases, own, out var pillarIds, out var pillarAliases);
                    if (resilient && own.Count == 0)
                    {
                        ids = pillarIds;
                        foreach (var (old, current) in pillarAliases) aliases[old] = current;
                    }
                }
                catch (RegistryException e) when (resilient)
                {
                    own.Add(e.Message);
                }

                if (own.Count == 0 && group is not null)
                {
                    pillars.Add(group);
                    continue;
                }
                if (!resilient)
                {
                    errors.AddRange(own);
                    if (group is not null) pillars.Add(group);
                    continue;
                }
                // Skipped: the island stays on the map, empty, saying what is wrong.
                var id = KebabId.IsMatch(stem) ? stem : group?.Id ?? "broken-" + pillars.Count;
                brokenPillars.Add(id);
                var shown = group is { DisplayName.Length: > 0 } ? group.DisplayName : stem;
                var detail = own.Count == 1 ? own[0] : $"{own[0]} (and {own.Count - 1} more)";
                pillars.Add(new RegistryGroup(id, shown, group?.Color ?? "#d63a2f", false, [], ConfigError: detail));
                notices.Add($"{name} was skipped: {detail}");
                problems.AddRange(own);
            }
        }

        var groups = new List<RegistryGroup> { hubGroup };
        groups.AddRange(Order(pillars, layout, Problem));
        var ringCapacity = CheckRingCapacity(layout, pillars.Count, errors);

        // every declared call must point at a system in this town (by id or by an old alias), and not at itself
        var resolved = new Dictionary<string, IReadOnlyList<string>>();
        foreach (var node in groups.SelectMany(g => g.Nodes))
        {
            var calls = new List<string>();
            foreach (var callee in node.Calls)
            {
                var target = ids.Contains(callee) ? callee : aliases.GetValueOrDefault(callee);
                if (target is null)
                {
                    // a call into a pillar that was skipped is the skipped pillar's problem, not this one's
                    if (resilient && brokenPillars.Contains(callee.Split('.')[0])) continue;
                    Problem($"'{node.Id}' calls '{callee}', which is not in this town.{DidYouMean.Hint(callee, ids.Concat(aliases.Keys))}");
                }
                else if (target == node.Id)
                    Problem($"'{node.Id}' lists itself under calls");
                else
                    calls.Add(target);
            }
            resolved[node.Id] = calls.Distinct().ToList();
        }

        // gateway calls: systems on other islands, reached through the API gateway
        var groupOfNode = groups.SelectMany(g => g.Nodes.Select(n => (Id: n.Id, Group: g.Id))).ToDictionary(x => x.Id, x => x.Group);
        var resolvedGateway = new Dictionary<string, IReadOnlyList<string>>();
        foreach (var node in groups.SelectMany(g => g.Nodes))
        {
            var calls = new List<string>();
            foreach (var callee in node.GatewayCalls)
            {
                var target = ids.Contains(callee) ? callee : aliases.GetValueOrDefault(callee);
                if (target is null)
                {
                    if (resilient && brokenPillars.Contains(callee.Split('.')[0])) continue;
                    Problem($"'{node.Id}' reaches '{callee}' through the gateway (gatewayCalls), which is not in this town.{DidYouMean.Hint(callee, ids.Concat(aliases.Keys))}");
                }
                else if (groupOfNode[target] == node.GroupId)
                    Problem($"'{node.Id}' lists '{target}' under gatewayCalls, but it is on the same island: use calls");
                else
                    calls.Add(target);
            }
            resolvedGateway[node.Id] = calls.Distinct().ToList();
        }

        var byId = groups.SelectMany(g => g.Nodes).ToDictionary(n => n.Id);
        var callers = new List<ExternalCaller>();
        foreach (var c in hub.ExternalCallers)
        {
            if (!KebabId.IsMatch(c.Id)) Problem($"hub.yaml: external caller '{c.Id}' must be lowercase kebab-case");
            if (callers.Any(x => x.Id == c.Id)) { Problem($"hub.yaml: external caller '{c.Id}' is listed twice"); if (resilient) continue; }
            var calls = new List<string>();
            foreach (var callee in c.Calls)
            {
                var target = ids.Contains(callee) ? callee : aliases.GetValueOrDefault(callee);
                if (target is null)
                {
                    if (resilient && brokenPillars.Contains(callee.Split('.')[0])) continue;
                    Problem($"hub.yaml: external caller '{c.Id}' calls '{callee}', which is not in this town.{DidYouMean.Hint(callee, ids.Concat(aliases.Keys))}");
                }
                else if (!byId[target].External) Problem($"hub.yaml: external caller '{c.Id}' calls '{target}', which is not marked external");
                else calls.Add(target);
            }
            callers.Add(new ExternalCaller(c.Id, c.Name ?? c.Id, calls));
        }

        var vendors = new List<RegistryVendor>();
        foreach (var v in thirdParties.Vendors)
        {
            var node = ToNode(new SystemFile { Id = v.Id, Name = v.Name, Role = "api", SlaP99Ms = v.SlaP99Ms, Errors = v.Errors }, RegistryVendor.GroupId,
                "third-parties.yaml", RegistryVendor.GroupId, defaults, new DefaultsFile(), false, ids, aliases, errors);
            if (node is null) continue;
            var calledBy = new List<string>();
            foreach (var caller in v.CalledBy)
            {
                var target = ids.Contains(caller) ? caller : aliases.GetValueOrDefault(caller);
                if (target is null)
                {
                    if (resilient && brokenPillars.Contains(caller.Split('.')[0])) continue;
                    Problem($"third-parties.yaml: '{v.Id}' is called by '{caller}', which is not in this town.{DidYouMean.Hint(caller, ids.Concat(aliases.Keys))}");
                }
                else if (target.StartsWith(RegistryVendor.GroupId + ".")) Problem($"third-parties.yaml: '{v.Id}' is called by '{target}', which is another third party");
                else calledBy.Add(target);
            }
            if (v.CalledBy.Count == 0) Problem($"third-parties.yaml: '{v.Id}' needs calledBy: the systems whose calls show how it is doing");
            vendors.Add(new RegistryVendor(node, calledBy.Distinct().ToList()));
        }

        if (errors.Count == 1) throw new RegistryException(errors[0]);
        if (errors.Count > 1)
            throw new RegistryException($"The registry has {errors.Count} problems:\n" + string.Join("\n", errors.Select(e => "  - " + e)));

        var final = groups.Select(g => g with { Nodes = g.Nodes.Select(n => n with { Calls = resolved[n.Id], GatewayCalls = resolvedGateway[n.Id] }).ToList() }).ToList();
        return new Registry(new TownInfo(town.Id, town.Name, town.GroupLabel, town.Topology), final, callers) { Notices = notices, Problems = problems, Vendors = vendors, RingCapacity = ringCapacity };
    }

    /// <summary>Reads one pillar file. Problems found in it go to <paramref name="errors"/>; the ids and aliases it would add are returned, so a caller can drop them with the file.</summary>
    private static RegistryGroup LoadPillar(
        string file, string name, DefaultsFile defaults, HashSet<string> ids, Dictionary<string, string> aliases, List<string> errors,
        out HashSet<string> pillarIds, out Dictionary<string, string> pillarAliases)
    {
        pillarIds = ids;
        pillarAliases = aliases;
        var p = Read<PillarFile>(file);
        CheckRoleKeys(p.Defaults, name, errors);
        if (!KebabId.IsMatch(p.Pillar))
            errors.Add($"{name}: pillar '{p.Pillar}' must be lowercase kebab-case");
        else if (Path.GetFileNameWithoutExtension(file) != p.Pillar)
            errors.Add($"{name}: pillar '{p.Pillar}' must match the file name");

        var nodes = p.Systems
            .Select(s => ToNode(s, p.Pillar, name, p.Pillar, defaults, p.Defaults, p.External, ids, aliases, errors))
            .OfType<RegistryNode>()
            .ToList();
        return new RegistryGroup(p.Pillar, p.DisplayName, p.Color, false, nodes);
    }

    /// <summary>Pillars in layout.yaml order, then any that it does not list in file order. Lost &amp; found is always last.</summary>
    private static IEnumerable<RegistryGroup> Order(List<RegistryGroup> pillars, LayoutFile layout, Action<string> problem)
    {
        var byId = pillars.ToDictionary(p => p.Id, p => p);
        var seen = new HashSet<string>();
        var ordered = new List<RegistryGroup>();
        foreach (var id in layout.Islands)
        {
            if (!byId.TryGetValue(id, out var g))
                problem($"layout.yaml: island '{id}' has no pillar file.{DidYouMean.Hint(id, byId.Keys)}");
            else if (!seen.Add(id))
                problem($"layout.yaml: island '{id}' is listed twice");
            else
                ordered.Add(g);
        }
        ordered.AddRange(pillars.Where(p => !seen.Contains(p.Id)));
        return ordered.Where(p => !p.IsLostFound).Concat(ordered.Where(p => p.IsLostFound));
    }

    /// <summary>
    /// The ring capacity from layout.yaml, within its limits, and the pillar count it allows. These are errors even in a resilient load:
    /// a town that does not fit on two rings cannot be drawn at all.
    /// </summary>
    private static int CheckRingCapacity(LayoutFile layout, int pillarCount, List<string> errors)
    {
        var capacity = layout.RingCapacity ?? Registry.DefaultRingCapacity;
        if (capacity is < Registry.MinRingCapacity or > Registry.MaxRingCapacity)
        {
            errors.Add($"layout.yaml: ringCapacity must be between {Registry.MinRingCapacity} and {Registry.MaxRingCapacity}, not {capacity}");
            return Registry.DefaultRingCapacity;
        }
        var max = Registry.MaxPillars(capacity);
        if (pillarCount > max)
        {
            var needed = (pillarCount + 2) / 2;
            var hint = needed <= Registry.MaxRingCapacity
                ? $"set ringCapacity to {needed} or more in layout.yaml"
                : $"{Registry.MaxPillars(Registry.MaxRingCapacity)} is the most a town can hold (ringCapacity {Registry.MaxRingCapacity})";
            errors.Add($"layout.yaml: {pillarCount} pillars do not fit on two rings of {capacity}: at most {max}. {hint}. Lost & found counts as a pillar");
        }
        return capacity;
    }

    private static void CheckRoleKeys(DefaultsFile defaults, string fileName, List<string> errors)
    {
        foreach (var role in defaults.Keys)
            if (!Roles.Contains(role))
                errors.Add($"{fileName}: defaults for unknown role '{role}'. Use {RoleList}.{DidYouMean.Hint(role, Roles)}");
    }

    private static string RoleList => "api, worker, db, cache, cron, gateway, broker or egress";

    private static RegistryNode? ToNode(
        SystemFile s, string groupId, string fileName, string prefix,
        DefaultsFile appDefaults, DefaultsFile pillarDefaults, bool pillarExternal,
        HashSet<string> ids, Dictionary<string, string> aliases, List<string> errors)
    {
        var dot = s.Id.IndexOf('.');
        if (dot <= 0 || s.Id[..dot] != prefix || !KebabId.IsMatch(s.Id[(dot + 1)..]))
        {
            errors.Add($"{fileName}: id '{s.Id}' must look like '{prefix}.some-name'");
            return null;
        }
        if (!ids.Add(s.Id))
        {
            errors.Add($"{fileName}: id '{s.Id}' is used twice in this town");
            return null;
        }
        foreach (var alias in s.Aliases)
        {
            if (alias == s.Id) errors.Add($"{fileName}: '{s.Id}' lists itself as an alias");
            else if (ids.Contains(alias) || !aliases.TryAdd(alias, s.Id))
                errors.Add($"{fileName}: alias '{alias}' of '{s.Id}' is already taken by another system");
        }

        if (!TryParseKind(s.Role, s.Id, fileName, errors, out var kind)) return null;
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
            Resolve(d => d?.Throttle?.Red, s.Throttle?.Red),
            Resolve(d => d?.Backlog?.Amber, s.Backlog?.Amber),
            Resolve(d => d?.Backlog?.Red, s.Backlog?.Red),
            s.Calls)
        {
            GatewayCalls = s.GatewayCalls,
        };
    }

    private static bool TryParseKind(string? role, string id, string fileName, List<string> errors, out NodeKind kind)
    {
        kind = default;
        if (role is null)
        {
            errors.Add($"{fileName}: '{id}' needs a role (role inference arrives with telemetry)");
            return false;
        }
        var parsed = role.ToLowerInvariant() switch
        {
            "api" => NodeKind.Api,
            "worker" => NodeKind.Worker,
            "db" or "database" => NodeKind.Database,
            "cache" => NodeKind.Cache,
            "cron" => NodeKind.Cron,
            "gateway" => NodeKind.Gateway,
            "broker" => NodeKind.Broker,
            "egress" => NodeKind.Egress,
            _ => (NodeKind?)null,
        };
        if (parsed is null)
        {
            errors.Add($"{fileName}: '{id}' has unknown role '{role}'. Use {RoleList}.{DidYouMean.Hint(role, Roles)}");
            return false;
        }
        kind = parsed.Value;
        return true;
    }

    private static T Read<T>(string path)
    {
        if (!File.Exists(path))
            throw new RegistryException($"Registry file not found: {path}");
        var name = Path.GetFileName(path);
        try
        {
            return Yaml.Deserialize<T>(File.ReadAllText(path)) ?? throw new RegistryException($"{name} is empty");
        }
        catch (YamlDotNet.Core.YamlException e)
        {
            var text = (e.InnerException ?? e).Message;
            var at = e.Start.Line > 0 ? $" (line {e.Start.Line})" : "";
            if (UnknownKey.Match(text) is { Success: true } m)
            {
                var key = m.Groups[1].Value;
                throw new RegistryException($"{name}{at}: unknown key '{key}'.{DidYouMean.Hint(key, KnownKeys)}");
            }
            throw new RegistryException($"{name}{at}: {text}");
        }
    }
}
