using System.Text.RegularExpressions;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace ObservabilityCity.Validate;

/// <summary>
/// Checks a registry folder beyond what loading it needs: the loader's own problems (format, ids, links), and then the rules that
/// keep a town readable and honest. Errors fail CI; warnings are listed and do not. Every finding names a file and a line.
/// </summary>
public static class RegistryValidator
{
    private static readonly Regex FileName = new(@"^((?:environments/)?[A-Za-z0-9._-]+\.yaml)(?: \(line (\d+)\))?", RegexOptions.Compiled);
    private static readonly Regex Colour = new("^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", RegexOptions.Compiled);
    private static readonly Regex Quoted = new("'([^']+)'", RegexOptions.Compiled);
    private static readonly Regex CallsMessage = new("^'([^']+)' calls '([^']+)'", RegexOptions.Compiled);
    private static readonly string[] TopLevel = ["town.yaml", "defaults.yaml", "hub.yaml", "layout.yaml", "fake.yaml", "third-parties.yaml"];
    private static readonly string[] Topologies = ["hub-and-spoke", "direct"];
    private static readonly string[] Blocks = ["errors", "resources", "throttle", "backlog"];

    public static ValidationResult Validate(string folder)
    {
        folder = Path.GetFullPath(folder);
        var findings = new List<Finding>();
        var ctx = new Context(folder, findings);

        Registry registry;
        try
        {
            registry = RegistryLoader.LoadResilient(folder);
        }
        catch (RegistryException e)
        {
            // town, defaults, hub or layout are unreadable: nothing further can be checked
            foreach (var problem in Split(e.Message)) ctx.FromLoader(problem, null);
            return ctx.Result();
        }

        foreach (var problem in registry.Problems) ctx.FromLoader(problem, registry);
        ctx.Registry = registry;

        CheckTown(ctx);
        CheckColoursAndNames(ctx, registry);
        CheckLayout(ctx, registry);
        CheckThresholds(ctx, registry);
        CheckCalls(ctx, registry);
        CheckHub(ctx, registry);
        CheckExternalCallers(ctx, registry);
        CheckWorkersHaveDatabases(ctx, registry);
        CheckUncalled(ctx, registry);
        CheckStandalone(ctx, registry);
        CheckServices(ctx, registry);
        CheckEnvironments(ctx, registry);
        CheckFake(ctx, registry);
        return ctx.Result();
    }

    // ── town, names, colours ────────────────────────────────────────────────

    private static void CheckTown(Context c)
    {
        var town = c.Raw("town.yaml");
        if (town.Root is null) return;
        var topology = RawYaml.Get(town.Root, "topology");
        if (topology is not null && RawYaml.Str(topology) is { } t && !Topologies.Contains(t))
            c.Error("town.yaml", RawYaml.Line(topology), "topology", $"topology '{t}' is not known. Use {string.Join(" or ", Topologies)}.{DidYouMean.Hint(t, Topologies)}");
        foreach (var key in new[] { "id", "name" })
            if (string.IsNullOrWhiteSpace(RawYaml.Str(RawYaml.Get(town.Root, key))))
                c.Error("town.yaml", 1, "town", $"town.yaml needs a non-empty '{key}'.");
    }

    private static void CheckColoursAndNames(Context c, Registry registry)
    {
        foreach (var file in c.RootFiles("hub.yaml").Concat(c.PillarFiles()))
        {
            var raw = c.Raw(file);
            if (raw.Root is null) continue;
            if (RawYaml.Get(raw.Root, "color") is { } colour && RawYaml.Str(colour) is { } text && !Colour.IsMatch(text))
                c.Error(file, RawYaml.Line(colour), "colour", $"color '{text}' is not a hex colour. Write it like \"#5aa9ff\" (quoted, so YAML keeps the #).");
            if (file != "hub.yaml" && string.IsNullOrWhiteSpace(RawYaml.Str(RawYaml.Get(raw.Root, "displayName"))))
                c.Error(file, 1, "name", "The pillar has no displayName, so its island would have a blank sign.");
        }
        foreach (var g in registry.Groups.Where(g => !g.IsHub && g.ConfigError is null && g.Nodes.Count == 0))
            c.Warn(c.PillarFile(g.Id), 1, "empty", $"Pillar '{g.Id}' has no systems, so its island would be empty.");
    }

    // ── layout ──────────────────────────────────────────────────────────────

    private static void CheckLayout(Context c, Registry registry)
    {
        var pillars = registry.Groups.Where(g => !g.IsHub).ToList();
        var layout = c.Raw("layout.yaml");
        if (layout.Root is null)
        {
            if (pillars.Count > 1)
                c.Warn("town.yaml", 1, "layout", "There is no layout.yaml, so islands stand round the hub in file-name order.");
        }
        else
        {
            var listed = RawYaml.Items(RawYaml.Get(layout.Root, "islands")).Select(RawYaml.Str).ToHashSet();
            foreach (var g in pillars.Where(g => !g.IsLostFound && !listed.Contains(g.Id)))
                c.Error(c.PillarFile(g.Id), 1, "layout", $"Pillar '{g.Id}' has no entry in layout.yaml, so its place round the hub is an accident of file order. Add '{g.Id}' to islands.");
        }
    }

    // ── thresholds ──────────────────────────────────────────────────────────

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

    private static void CheckCalls(Context c, Registry registry)
    {
        if (registry.Town.Topology != "hub-and-spoke") return;
        var groupOf = registry.Groups.SelectMany(g => g.Nodes.Select(n => (n.Id, g))).ToDictionary(x => x.Id, x => x.g);
        foreach (var g in registry.Groups.Where(g => !g.IsHub))
            foreach (var n in g.Nodes)
                foreach (var callee in n.Calls)
                {
                    var target = groupOf[callee];
                    if (target.IsHub || target.Id == g.Id) continue;
                    var at = c.Locate(n.Id, callee);
                    c.Error(at.File, at.Line, "cross-pillar-call",
                        $"'{n.Id}' calls '{callee}' in pillar '{target.Id}' directly. In a hub-and-spoke town calls between pillars go through the hub: call the hub's gateway or Service Bus instead, or set topology: direct.");
                }
    }

    private static void CheckHub(Context c, Registry registry)
    {
        var allowed = new[] { NodeKind.Gateway, NodeKind.Broker, NodeKind.Egress, NodeKind.Database };
        var seen = new HashSet<NodeKind>();
        foreach (var n in registry.Groups.Where(g => g.IsHub).SelectMany(g => g.Nodes))
        {
            var at = c.Locate(n.Id);
            if (!allowed.Contains(n.Kind))
                c.Error(at.File, at.Line, "hub", $"'{n.Id}' has role {n.Kind.ToString().ToLowerInvariant()}, but the hub only draws a gateway, broker, egress and database.");
            else if (!seen.Add(n.Kind))
                c.Error(at.File, at.Line, "hub", $"'{n.Id}' is a second {n.Kind.ToString().ToLowerInvariant()} on the hub, which has room for one of each.");
        }
    }

    private static void CheckExternalCallers(Context c, Registry registry)
    {
        var hub = c.Raw("hub.yaml");
        foreach (var caller in registry.ExternalCallers.Where(x => x.Calls.Count == 0))
        {
            var line = hub.FindScalar(caller.Id) ?? 1;
            c.Warn("hub.yaml", line, "external-caller", $"External caller '{caller.Id}' reaches no system, so no traffic is drawn for it.");
        }
    }

    // ── services ────────────────────────────────────────────────────────────

    private static void CheckWorkersHaveDatabases(Context c, Registry registry)
    {
        foreach (var g in registry.Groups.Where(g => !g.IsHub && g.ConfigError is null))
        {
            var dbs = g.Nodes.Where(n => n.Kind == NodeKind.Database).ToList();
            foreach (var w in g.Nodes.Where(n => n.Kind == NodeKind.Worker))
            {
                var hasDb = w.Calls.Any(id => dbs.Any(d => d.Id == id)) || (w.Service is not null && dbs.Any(d => d.Service == w.Service));
                if (hasDb) continue;
                var at = c.Locate(w.Id);
                c.Warn(at.File, at.Line, "worker-db", $"Worker '{w.Id}' has no database: none in its service and none under calls. Workers normally keep their state somewhere.");
            }
        }
    }

    private static void CheckUncalled(Context c, Registry registry)
    {
        var called = registry.AllNodes.SelectMany(n => n.Calls).Concat(registry.ExternalCallers.SelectMany(x => x.Calls)).ToHashSet();
        foreach (var g in registry.Groups.Where(g => !g.IsHub && !g.IsLostFound))
            foreach (var n in g.Nodes.Where(n => n.Kind is NodeKind.Api or NodeKind.Cache or NodeKind.Database && !n.External && !called.Contains(n.Id)))
            {
                var at = c.Locate(n.Id);
                c.Warn(at.File, at.Line, "uncalled", $"Nothing calls '{n.Id}': no system lists it under calls and it is not external. It will sit idle on the map; add the caller or mark it external.");
            }
    }

    private static void CheckStandalone(Context c, Registry registry)
    {
        foreach (var g in registry.Groups.Where(g => !g.IsHub && g.ConfigError is null && g.Nodes.Count > 0 && TownLinks.Of(registry)[g.Id].Standalone))
            c.Warn(c.PillarFile(g.Id), 1, "standalone", $"Island '{g.Id}' stands alone: it has no API, no topics or subscriptions, no calls to or from other islands and no third party, so nothing connects it to the town. Add an API, a messaging block or a calls link.");
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

    private static void CheckEnvironments(Context c, Registry registry)
    {
        var tenanted = registry.AllNodes.Where(n => n.TenantPattern is not null).ToList();
        if (registry.Environments.Count == 0)
        {
            foreach (var n in tenanted)
            {
                var at = c.Locate(n.Id);
                c.Warn(at.File, at.Line, "tenants", $"'{n.Id}' has a tenantPattern, but the town has no environments folder, so there are no tenants to draw. Add environments/{{env}}.yaml with a tenants list.");
            }
            return;
        }
        foreach (var env in registry.Environments)
        {
            var file = $"environments/{env.Id}.yaml";
            foreach (var warning in Registry.EnvironmentWarnings(env, registry.ForEnvironment(env.Id)))
                c.Warn(file, 1, "tenants", warning);
        }
    }

    // ── fake data ───────────────────────────────────────────────────────────

    private static void CheckFake(Context c, Registry registry)
    {
        var path = Path.Combine(c.Folder, "fake.yaml");
        if (!File.Exists(path)) return;
        try
        {
            FakeProfiles.Load(c.Folder);
        }
        catch (Exception e)
        {
            var inner = e.InnerException ?? e;
            var line = (e as YamlException)?.Start.Line ?? (inner as YamlException)?.Start.Line ?? 1;
            c.Error("fake.yaml", (int)Math.Max(1, line), "fake", $"fake.yaml cannot be read: {inner.Message}");
            return;
        }

        var ids = registry.AllNodes.Concat(registry.Vendors.Select(v => v.Node)).Select(n => n.Id).ToHashSet(); // vendors have fake profiles too
        var aliases = c.Aliases();
        var raw = c.Raw("fake.yaml");
        if (raw.Root is null) return;
        foreach (var (key, value) in raw.Root.Children)
        {
            var id = RawYaml.Str(key) ?? "?";
            var line = RawYaml.Line(key);
            var skipped = registry.Groups.Any(g => g.ConfigError is not null && id.StartsWith(g.Id + "."));
            if (!ids.Contains(id) && !aliases.Contains(id) && !skipped) // a pillar that failed to load has no systems to name
                c.Error("fake.yaml", line, "fake", $"fake.yaml describes '{id}', which is not a system in this town.{DidYouMean.Hint(id, ids)}");
            if (value is not YamlMappingNode profile) continue;
            foreach (var field in new[] { "rps", "p99Ms", "perInstanceRps" })
                if (RawYaml.Get(profile, field) is { } f && RawYaml.Number(f) is not >= 0)
                    c.Error("fake.yaml", RawYaml.Line(f), "fake", $"{id}: {field} must be a number, 0 or more.");
            if (RawYaml.Get(profile, "perInstanceRps") is { } per && RawYaml.Number(per) is 0)
                c.Error("fake.yaml", RawYaml.Line(per), "fake", $"{id}: perInstanceRps must be above 0, or the autoscaler would divide by zero.");
            if (RawYaml.Get(profile, "errorRate") is { } er && RawYaml.Number(er) is not (>= 0 and <= 1))
                c.Error("fake.yaml", RawYaml.Line(er), "fake", $"{id}: errorRate must be a share between 0 and 1.");
            var min = RawYaml.Get(profile, "minInstances");
            var max = RawYaml.Get(profile, "maxInstances");
            if (min is not null && RawYaml.Number(min) is not >= 1)
                c.Error("fake.yaml", RawYaml.Line(min), "fake", $"{id}: minInstances must be 1 or more.");
            if (min is not null && max is not null && RawYaml.Number(min) > RawYaml.Number(max))
                c.Error("fake.yaml", RawYaml.Line(min), "fake", $"{id}: minInstances ({RawYaml.Str(min)}) is above maxInstances ({RawYaml.Str(max)}).");
        }
    }

    private static IEnumerable<string> Split(string message)
    {
        var lines = message.Split('\n');
        if (lines.Length > 1 && lines[0].StartsWith("The registry has"))
            return lines.Skip(1).Select(l => l.TrimStart(' ', '-').Trim()).Where(l => l.Length > 0);
        return [message];
    }

    // ── shared state ────────────────────────────────────────────────────────

    private sealed class Context(string folder, List<Finding> findings)
    {
        private readonly Dictionary<string, RawYaml> _raw = new();
        private HashSet<string>? _aliases;

        public string Folder { get; } = folder;
        public Registry? Registry { get; set; }

        public ValidationResult Result()
        {
            // the same problem can be found twice (by the loader and by a check); keep one
            var distinct = findings.DistinctBy(f => (f.File, f.Line, f.Message)).OrderBy(f => f.File, StringComparer.Ordinal).ThenBy(f => f.Line).ToList();
            return new ValidationResult(Folder, distinct);
        }

        public void Error(string file, int line, string rule, string message) => findings.Add(new Finding(Severity.Error, Rel(file), Math.Max(1, line), rule, message));
        public void Warn(string file, int line, string rule, string message) => findings.Add(new Finding(Severity.Warning, Rel(file), Math.Max(1, line), rule, message));

        private string Rel(string file) => file.Replace('\\', '/');

        /// <summary>Raw tree of a file given relative to the registry folder.</summary>
        public RawYaml Raw(string file)
        {
            if (!_raw.TryGetValue(file, out var r)) _raw[file] = r = RawYaml.Load(Path.Combine(Folder, file));
            return r;
        }

        public IEnumerable<string> RootFiles(params string[] names) => names.Where(n => File.Exists(Path.Combine(Folder, n)));

        public IEnumerable<string> PillarFiles()
        {
            var dir = Path.Combine(Folder, "pillars");
            return Directory.Exists(dir)
                ? Directory.GetFiles(dir, "*.yaml").OrderBy(f => f, StringComparer.Ordinal).Select(f => "pillars/" + Path.GetFileName(f))
                : [];
        }

        public string PillarFile(string pillarId) => "pillars/" + pillarId + ".yaml";

        public HashSet<string> Aliases()
        {
            if (_aliases is not null) return _aliases;
            _aliases = [];
            foreach (var file in RootFiles("hub.yaml").Concat(PillarFiles()))
                foreach (var key in new[] { "systems", "resources" })
                    foreach (var system in Raw(file).Entries(key))
                        foreach (var a in RawYaml.Items(RawYaml.Get(system, "aliases")))
                            if (RawYaml.Str(a) is { } alias) _aliases.Add(alias);
            return _aliases;
        }

        /// <summary>The file and line of a system, or of one entry in its calls.</summary>
        public (string File, int Line) Locate(string systemId, string? callee = null)
        {
            var dot = systemId.IndexOf('.');
            var prefix = dot > 0 ? systemId[..dot] : systemId;
            var file = prefix == "hub" ? "hub.yaml" : PillarFile(prefix);
            var raw = Raw(file);
            var line = (callee is not null ? raw.FindCall(systemId, callee) : null) ?? raw.FindSystem(systemId) ?? 1;
            return (file, line);
        }

        /// <summary>Turns one of the loader's messages into a finding by working out which file and line it is about.</summary>
        public void FromLoader(string message, Registry? registry)
        {
            string file;
            int? line = null;
            var calls = CallsMessage.Match(message);
            if (FileName.Match(message) is { Success: true } m)
            {
                file = m.Groups[1].Value;
                file = TopLevel.Contains(file) || file.StartsWith("environments/") ? file : PillarFile(Path.GetFileNameWithoutExtension(file));
                if (m.Groups[2].Success) line = int.Parse(m.Groups[2].Value);
                if (message.Contains("external caller") && Quoted.Matches(message) is { Count: > 1 } q)
                    line = Raw(file).FindScalar(q[1].Groups[1].Value);
            }
            else if (calls.Success)
            {
                var at = Locate(calls.Groups[1].Value, calls.Groups[2].Value);
                (file, line) = (at.File, at.Line);
            }
            else if (Quoted.Match(message) is { Success: true } first)
            {
                var at = Locate(first.Groups[1].Value);
                (file, line) = (at.File, at.Line);
            }
            else
            {
                file = "town.yaml";
            }

            if (line is null)
            {
                var raw = Raw(file);
                foreach (Match t in Quoted.Matches(message))
                    if ((line = raw.FindScalar(t.Groups[1].Value)) is not null) break;
            }
            Error(file, line ?? 1, "registry", message);
        }
    }
}
