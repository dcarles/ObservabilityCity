using System.Text.RegularExpressions;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Sources;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ObservabilityCity.Core.Registry;

/// <summary>
/// Loads a registry folder: town.yaml (which also sets the island order and ring size), defaults.yaml, hub.yaml and groups/*.yaml (pillars/, the older name of the folder, reads the same).
/// Settings resolve through defaults.yaml, then the pillar's defaults, then the system's own values.
/// Every problem found in the files is collected and reported together, each naming its file, with a
/// "did you mean" for names that are close to a real one.
/// </summary>
public static partial class RegistryLoader
{
    private static readonly Regex KebabId = new("^[a-z0-9]+(-[a-z0-9]+)*$", RegexOptions.Compiled);
    private static readonly Regex UnknownKey = new("Property '([^']+)' not found", RegexOptions.Compiled);

    // Strict on purpose: a misspelt key such as "cals" must be an error, not silently ignored.
    private static readonly IDeserializer Yaml = new DeserializerBuilder()
        .WithNamingConvention(CamelCaseNamingConvention.Instance)
        .Build();

    /// <summary>The reader every registry file is read with, for a module's settings too (see <see cref="SourceSettings.TryBind"/>).</summary>
    internal static IDeserializer Strict => Yaml;

    /// <summary>The key a "property not found" message is about, or null for any other message.</summary>
    internal static string? UnknownKeyOf(string message) => UnknownKey.Match(message) is { Success: true } m ? m.Groups[1].Value : null;

    /// <summary>The keys of a source that the core reads itself. Every other key belongs to the module of the source's kind.</summary>
    public static IReadOnlyCollection<string> SourceKeys => SourceFile.KeyNames;

    private static readonly string[] Roles = ["api", "worker", "db", "cache", "function", "cron", "gateway", "broker", "egress"];

    // Every key a registry file may use, for suggesting the right one when a key is misspelt.
    private static readonly string[] KnownKeys =
    [
        "id", "name", "groupLabel", "topology", "expectedWarnings", "ringCapacity", "databaseEngines", "engine", "type", "rule", "file", "pillar", "displayName", "color", "external", "defaults", "systems", "resources",
        "externalCallers", "islands", "role", "service", "slaP99Ms", "errors", "resources", "throttle", "backlog", "calls", "aliases",
        "amber", "red", "vendors", "calledBy", "gatewayCalls", "messaging", "topics", "subscriptions", "topic", "consumer",
        "tenantPattern", "order", "default", "sources", "kind", "connection", "tenants", "exclude", "environments", "fake", "undeclaredTenants",
        "signals", "credentials", "credential", "pollSeconds", "timeoutSeconds", "lateAfterSeconds", "tenantId", "clientId", "clientSecretEnv",
        "scope", "inventory", "telemetryStore", "telemetryStoreId", "workspace", "workspaceId", "variables", "account", "subscription", "pillarAccounts", "pillars", "accounts", "telemetryStores", "workspaces", "assets", "cloud", "island", "group", "label", "shape", "instances", "types", "pattern", "roles", "serviceTag", "tenantNameTag",
        "telemetryRole", "queries", "links", "url", "nameLike", "tag", "key", "value", "code", "serviceCode", "telemetry", "minCalls", "query", "window", "discoverLinks", "regions", "tag", "names", "skew", "state", "running", "minDays", "keepFor", "firstRead", "interval", "ignoreHosts", "rules", "host", "path", "target", "gateway", "domains", "services", "internal", "match", "traffic", "shareWindow", "logs", "section", "resources",
    ];

    // Last resort when defaults.yaml is missing or silent about a role.
    private static readonly RoleDefaultsFile BuiltIn = new()
    {
        SlaP99Ms = 1000,
        Errors = new ErrorThresholdsFile { Amber = 0.01, Red = 0.05 },
        Resources = new ErrorThresholdsFile { Amber = 0.80, Red = 0.95 },
        Throttle = new ErrorThresholdsFile { Amber = 0.001, Red = 0.02 },
        Backlog = new ErrorThresholdsFile { Amber = 60, Red = 300 },
        MinCalls = 1,
    };

    /// <summary>
    /// Strict load: any problem in any file fails the whole load, with every problem listed. This is what CI and the validator use.
    /// <paramref name="kinds"/> are the source kinds of the loaded adapter modules, which read and check their sources' own settings; without them only the
    /// core's kinds are known, and the settings of any other kind are kept unread.
    /// </summary>
    public static Registry Load(string folder, ISourceKindCatalog? kinds = null) => Build(folder, resilient: false, kinds ?? CoreOnly);

    /// <summary>
    /// Resilient load, for a running app. A pillar file that cannot be read, or has problems of its own, is skipped and its island
    /// is returned empty with a ConfigError, so the rest of the town still renders. Call links that point nowhere are dropped.
    /// Everything worked around is listed in Registry.Notices. The files every pillar depends on (town, defaults, hub, third parties)
    /// still have to be sound: when they are not this throws, and the caller keeps the registry it already has.
    /// </summary>
    public static Registry LoadResilient(string folder, ISourceKindCatalog? kinds = null) => Build(folder, resilient: true, kinds ?? CoreOnly);

    private static readonly AdapterCatalog CoreOnly = new([]);

    private static Registry Build(string folder, bool resilient, ISourceKindCatalog kinds)
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
        if (!TownModes.All.Contains(town.Mode))
            throw new RegistryException($"town.yaml: mode '{town.Mode}' is not known. Use {string.Join(" or ", TownModes.All)}.{DidYouMean.Hint(town.Mode, TownModes.All)}");
        if (double.IsNaN(town.TrafficDensity) || town.TrafficDensity < TownTraffic.Min || town.TrafficDensity > TownTraffic.Max)
            throw new RegistryException($"town.yaml: trafficDensity {town.TrafficDensity.ToString(System.Globalization.CultureInfo.InvariantCulture)} is out of range. Use a number from {TownTraffic.Min.ToString(System.Globalization.CultureInfo.InvariantCulture)} to {TownTraffic.Max.ToString(System.Globalization.CultureInfo.InvariantCulture)} (1 is the usual number of cars).");
        var convention = new MessagingConvention(town.Messaging.TopicTemplate, town.Messaging.HubTopicTemplate);
        if (string.IsNullOrWhiteSpace(town.Labels.InternalVendors))
            throw new RegistryException("town.yaml: labels.internalVendors is empty. Leave it out to use the default, or give it a name");
        var wall = town.Wall;
        if (wall.HoldSeconds is { } hold && (double.IsNaN(hold) || hold < WallSettings.MinHoldSeconds))
            throw new RegistryException($"town.yaml: wall.holdSeconds {hold.ToString(System.Globalization.CultureInfo.InvariantCulture)} is too small. Use {WallSettings.MinHoldSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture)} seconds or more, or leave it out for the default.");
        if (wall.OverviewSeconds is { } overview && (double.IsNaN(overview) || overview < 0))
            throw new RegistryException($"town.yaml: wall.overviewSeconds {overview.ToString(System.Globalization.CultureInfo.InvariantCulture)} is not allowed. Use 0 for no overview, or a number of seconds.");
        if (wall.OverviewIslandSeconds is { } island && (double.IsNaN(island) || island < 0))
            throw new RegistryException($"town.yaml: wall.overviewIslandSeconds {island.ToString(System.Globalization.CultureInfo.InvariantCulture)} is not allowed. Use 0 to show only the whole town in the overview, or a number of seconds.");
        if (wall.Light is { } light && !WallSettings.Lights.Contains(light))
            throw new RegistryException($"town.yaml: wall.light '{light}' is not known. Use {string.Join(" or ", WallSettings.Lights)}.{DidYouMean.Hint(light, WallSettings.Lights)}");
        var defaults = File.Exists(Path.Combine(folder, "defaults.yaml"))
            ? Read<DefaultsFile>(Path.Combine(folder, "defaults.yaml"))
            : new DefaultsFile();
        CheckRoleKeys(defaults, "defaults.yaml", errors);
        var hub = Read<HubFile>(Path.Combine(folder, "hub.yaml"));
        var engines = CheckEngines(town, errors);
        if (File.Exists(Path.Combine(folder, "layout.yaml")))
            throw new RegistryException("town.yaml: this file is no longer read. Move its 'islands' and 'ringCapacity' keys into town.yaml and delete layout.yaml");

        var thirdPartiesPath = Path.Combine(folder, "third-parties.yaml");
        var thirdParties = File.Exists(thirdPartiesPath) ? Read<ThirdPartiesFile>(thirdPartiesPath) : new ThirdPartiesFile();

        // vendors in _discovered/third-parties.yaml (added from the Unknown hosts panel, or by hand) join the file's, unless third-parties.yaml already has that id (the file wins)
        var fileIds = thirdParties.Vendors.Select(v => v.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var v in AddedHosts.ReadFile(folder).Vendors.Where(v => !fileIds.Contains(v.Id)))
            thirdParties.Vendors.Add(v);

        var ids = new HashSet<string>();
        var aliases = new Dictionary<string, string>(); // old id to current id

        var hubNodes = hub.Resources
            .Select(r => ToNode(r, "hub", "hub.yaml", "hub", defaults, new DefaultsFile(), false, new Dictionary<string, string>(), ids, aliases, errors, engines))
            .OfType<RegistryNode>()
            .ToList();
        var hubGroup = new RegistryGroup("hub", hub.DisplayName, hub.Color, true, hubNodes) { TopicDecls = ToTopicDecls(hub.Messaging) };
        if (hub.Messaging is { Subscriptions.Count: > 0 })
            errors.Add("hub.yaml: the hub has no workers, so it cannot subscribe to topics. Subscriptions belong in the pillar file of the worker that reads them");
        CheckTopics(hubGroup, "hub.yaml", errors);

        var pillars = new List<RegistryGroup>();
        var brokenPillars = new HashSet<string>();
        var brokenTopics = new HashSet<string>(StringComparer.Ordinal); // the topics the skipped pillars would publish
        var groupFolder = GroupFolderOf(folder);
        var pillarDir = Path.Combine(folder, groupFolder);
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
                    group = LoadPillar(file, name, defaults, resilient ? new HashSet<string>(ids) : ids, resilient ? new Dictionary<string, string>(aliases) : aliases, own, engines, out var pillarIds, out var pillarAliases);
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
                brokenTopics.UnionWith(group is null
                    ? TopicNamesOfUnreadFile(file, id, convention)
                    : group.TopicDecls.Select(d => TopicNameOf(d, group, convention)).OfType<string>());
                var shown = group is { DisplayName.Length: > 0 } ? group.DisplayName : stem;
                var detail = own.Count == 1 ? own[0] : $"{own[0]} (and {own.Count - 1} more)";
                pillars.Add(new RegistryGroup(id, shown, group?.Color ?? "#d63a2f", false, [], ConfigError: detail));
                notices.Add($"{name} was skipped: {detail}");
                problems.AddRange(own);
            }
        }

        var groups = new List<RegistryGroup> { hubGroup };
        groups.AddRange(Order(pillars, town, Problem));
        CheckTemplates(groups, convention, groupFolder);
        var ringCapacity = CheckRingCapacity(town, pillars.Count, errors);

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
            // a vendor with services is one island with a building for each; without them it is one building
            List<(string Id, string? Name, List<string> CalledBy, double? Sla, ErrorThresholdsFile? Errors, IReadOnlyList<VendorMatch> Matches, IReadOnlyList<string> Roles, bool Service)> units = v.Services.Count == 0
                ? [(Id: v.Id, Name: v.Name, CalledBy: v.CalledBy, Sla: v.SlaP99Ms, Errors: v.Errors, Matches: (IReadOnlyList<VendorMatch>)[], Roles: (IReadOnlyList<string>)[], Service: false)]
                : v.Services.Select(s => (Id: v.Id + "-" + s.Id, Name: (string?)(s.Name ?? s.Id), CalledBy: s.CalledBy, Sla: s.SlaP99Ms ?? v.SlaP99Ms, Errors: s.Errors ?? v.Errors,
                    Matches: (IReadOnlyList<VendorMatch>)s.Match.Select(m => new VendorMatch(m.Host, m.Path)).ToList(), Roles: (IReadOnlyList<string>)s.Roles.Select(r => r.Trim()).Where(r => r.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList(), Service: true)).ToList();
            if (v.Services.Count > 0 && v.CalledBy.Count > 0) Problem($"third-parties.yaml: '{v.Id}' has services, so calledBy goes on each service, not on the vendor");
            foreach (var s in v.Services)
            {
                if (s.Id.Length == 0) Problem($"third-parties.yaml: a service of '{v.Id}' has no id");
                if (s.Match.Count == 0) Problem($"third-parties.yaml: service '{s.Id}' of '{v.Id}' needs match: the host (and optional path) its calls go to");
                foreach (var m in s.Match)
                {
                    if (m.Host.Trim().Length == 0) Problem($"third-parties.yaml: service '{s.Id}' of '{v.Id}' has a match with no host");
                    if (m.Path is not null) try { _ = new System.Text.RegularExpressions.Regex(m.Path); } catch (ArgumentException e) { Problem($"third-parties.yaml: service '{s.Id}' of '{v.Id}': path '{m.Path}' is not a valid pattern ({e.Message})"); }
                }
            }
            foreach (var u in units)
            {
                var node = ToNode(new SystemFile { Id = u.Id, Name = u.Name, Role = "api", SlaP99Ms = u.Sla, Errors = u.Errors }, RegistryVendor.GroupId,
                    "third-parties.yaml", RegistryVendor.GroupId, defaults, new DefaultsFile(), false, new Dictionary<string, string>(), ids, aliases, errors);
                if (node is null) continue;
                var calledBy = new List<string>();
                foreach (var caller in u.CalledBy)
                {
                    var target = ids.Contains(caller) ? caller : aliases.GetValueOrDefault(caller);
                    if (target is null)
                    {
                        if (resilient && brokenPillars.Contains(caller.Split('.')[0])) continue;
                        Problem($"third-parties.yaml: '{u.Id}' is called by '{caller}', which is not in this town.{DidYouMean.Hint(caller, ids.Concat(aliases.Keys))}");
                    }
                    else if (target.StartsWith(RegistryVendor.GroupId + ".")) Problem($"third-parties.yaml: '{u.Id}' is called by '{target}', which is another third party");
                    else calledBy.Add(target);
                }
                // a service is also found by link discovery; a plain vendor reads its health from the callers the file names
                if (!u.Service && u.CalledBy.Count == 0) Problem($"third-parties.yaml: '{u.Id}' needs calledBy: the systems whose calls show how it is doing");
                vendors.Add(new RegistryVendor(node, calledBy.Distinct().ToList())
                {
                    Domains = v.Domains, Matches = u.Matches, Roles = u.Roles, Internal = v.Internal,
                    IslandId = u.Service ? v.Id : null, IslandName = u.Service ? v.Name ?? v.Id : null,
                });
            }
        }

        var lines = new Dictionary<string, int>(StringComparer.Ordinal);
        var (topics, subscriptions) = ResolveMessaging(groups, brokenPillars, brokenTopics, resilient, Problem, convention, lines);
        var environments = LoadEnvironments(folder, ids, aliases, resilient, Problem, kinds, lines);
        // a system that names the environments it is deployed in must name environments the town has
        if (environments.Count > 0)
        {
            var envIds = environments.Select(e => e.Id).ToList();
            foreach (var node in final0(groups).Where(n => n.Environments.Count > 0))
                foreach (var env in node.Environments.Where(e => !envIds.Contains(e)))
                    errors.Add($"{node.SourceFile}: '{node.Id}' says it is deployed in environment '{env}', which is not in environments/.{DidYouMean.Hint(env, envIds)}");
        }
        // hosts ignored from the panel are platform noise in every environment that finds links
        var ignored = new List<string>();
        foreach (var pattern in AddedHosts.IgnorePatterns(folder))
        {
            try { _ = new System.Text.RegularExpressions.Regex(pattern); ignored.Add(pattern); }
            catch (ArgumentException e) { Problem($"_discovered/third-parties.yaml: ignoreHosts '{pattern}' is not a valid pattern ({e.Message})"); }
        }
        // and the rules added from the panel are tried after the environment's own
        var addedRules = new List<ObservabilityCity.Core.Links.LinkRule>();
        foreach (var r in AddedHosts.RulesIn(folder))
        {
            try
            {
                _ = new System.Text.RegularExpressions.Regex(r.Host);
                if (r.Path is not null) _ = new System.Text.RegularExpressions.Regex(r.Path);
                addedRules.Add(new ObservabilityCity.Core.Links.LinkRule(r.Host, r.Path, r.Target, r.Gateway));
            }
            catch (ArgumentException e) { Problem($"_discovered/third-parties.yaml: a rule for '{r.Target}' has a pattern that is not valid ({e.Message})"); }
        }
        if (ignored.Count > 0 || addedRules.Count > 0)
            environments = environments.Select(e => e.Links is { } links
                ? e with { Links = links with { IgnoreHosts = [.. links.IgnoreHosts, .. ignored.Except(links.IgnoreHosts)], Rules = [.. links.Rules, .. addedRules] } } : e).ToList();

        if (errors.Count == 1) throw new RegistryException(errors[0]);
        if (errors.Count > 1)
            throw new RegistryException($"The registry has {errors.Count} problems:\n" + string.Join("\n", errors.Select(e => "  - " + e)));

        var final = groups.Select(g => g with { Nodes = g.Nodes.Select(n => n with { Calls = resolved[n.Id], GatewayCalls = resolvedGateway[n.Id] }).ToList() }).ToList();
        var registry = new Registry(new TownInfo(town.Id, town.Name, town.GroupLabel, town.Topology, town.Mode, town.TrafficDensity, convention, town.Labels.InternalVendors, wall is { HoldSeconds: null, OverviewSeconds: null, OverviewIslandSeconds: null, Light: null } ? null : new WallSettings(wall.HoldSeconds, wall.OverviewSeconds, wall.OverviewIslandSeconds, wall.Light)), final, callers)
        {
            GroupFolder = groupFolder, Notices = notices, Problems = problems, ProblemLines = lines, Vendors = vendors, RingCapacity = ringCapacity, Topics = topics, Subscriptions = subscriptions, Environments = environments, DatabaseEngines = engines.Values.ToList(),
        };
        return registry with { Warnings = TownLinks.Warnings(registry).ToList() };
    }

    /// <summary>
    /// A topic listed by its service is named by the town's template, so that template must contain {service}. A town that lists every topic by its own
    /// name needs no template, and one without {service} is fine there.
    /// </summary>
    private static void CheckTemplates(List<RegistryGroup> groups, MessagingConvention convention, string groupFolder)
    {
        foreach (var g in groups)
        {
            var template = g.IsHub ? convention.HubTopicTemplate : convention.TopicTemplate;
            if (template.Contains("{service}") || g.TopicDecls.FirstOrDefault(d => d.Name is null) is not { } first) continue;
            var key = g.IsHub ? "messaging.hubTopicTemplate" : "messaging.topicTemplate";
            throw new RegistryException($"town.yaml: {key} must contain {{service}}, which is replaced by the service's name: {(g.IsHub ? "hub.yaml" : $"{groupFolder}/{g.Id}.yaml")} lists topic '{first.Service}' by its service. "
                + $"Add {{service}} to the template, or give the topic its own name: {{ topic: <name>, service: {first.Service} }}");
        }
    }

    /// <summary>Pillars in town.yaml islands order, then any that it does not list in file order. Lost &amp; found is always last.</summary>
    private static IEnumerable<RegistryGroup> Order(List<RegistryGroup> pillars, TownFile town, Action<string> problem)
    {
        var byId = pillars.ToDictionary(p => p.Id, p => p);
        var seen = new HashSet<string>();
        var ordered = new List<RegistryGroup>();
        foreach (var id in town.Islands)
        {
            if (!byId.TryGetValue(id, out var g))
                problem($"town.yaml: island '{id}' has no pillar file.{DidYouMean.Hint(id, byId.Keys)}");
            else if (!seen.Add(id))
                problem($"town.yaml: island '{id}' is listed twice");
            else
                ordered.Add(g);
        }
        ordered.AddRange(pillars.Where(p => !seen.Contains(p.Id)));
        return ordered.Where(p => !p.IsLostFound).Concat(ordered.Where(p => p.IsLostFound));
    }

    /// <summary>
    /// The folder of a town's group files: <c>groups</c>, or <c>pillars</c>, its older name. A town without either has no groups and reads as <c>groups</c>.
    /// A town with both is a mistake, since one of them would be left unread.
    /// </summary>
    public static string GroupFolderOf(string folder)
    {
        var neutral = Directory.Exists(Path.Combine(folder, GroupWords.Folder));
        var older = Directory.Exists(Path.Combine(folder, GroupWords.OlderFolder));
        if (neutral && older)
            throw new RegistryException($"The town folder has both {GroupWords.Folder}/ and {GroupWords.OlderFolder}/, which are one folder ({GroupWords.OlderFolder}/ is the older name of {GroupWords.Folder}/). Keep one of them: move the files of the other into it");
        return older ? GroupWords.OlderFolder : GroupWords.Folder;
    }

    private static T Read<T>(string path, string? displayName = null)
    {
        if (!File.Exists(path))
            throw new RegistryException($"Registry file not found: {path}");
        var name = displayName ?? Path.GetFileName(path);
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
