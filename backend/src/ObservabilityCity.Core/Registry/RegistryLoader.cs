using System.Text.RegularExpressions;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Sources;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ObservabilityCity.Core.Registry;

/// <summary>
/// Loads a registry folder: town.yaml, defaults.yaml, hub.yaml, an optional layout.yaml and pillars/*.yaml.
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

    private static readonly string[] Roles = ["api", "worker", "db", "cache", "cron", "gateway", "broker", "egress"];

    // Every key a registry file may use, for suggesting the right one when a key is misspelt.
    private static readonly string[] KnownKeys =
    [
        "id", "name", "groupLabel", "topology", "pillar", "displayName", "color", "external", "defaults", "systems", "resources",
        "externalCallers", "islands", "role", "service", "slaP99Ms", "errors", "resources", "throttle", "backlog", "calls", "aliases",
        "amber", "red", "vendors", "calledBy", "gatewayCalls", "messaging", "topics", "subscriptions", "topic", "consumer", "legacy",
        "tenantPattern", "order", "default", "sources", "kind", "connection", "tenants", "exclude", "fake", "undeclaredTenants",
        "signals", "credentials", "credential", "pollSeconds", "timeoutSeconds", "tenantId", "clientId", "clientSecretEnv",
        "scope", "inventory", "workspace", "variables", "subscription", "pillars", "types", "pattern", "roles", "serviceTag", "tenantNameTag",
        "telemetryRole", "queries", "nameLike", "tag", "key", "value", "code", "serviceCode", "telemetry", "minCalls", "query", "window",
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
        if (!TownModes.All.Contains(town.Mode))
            throw new RegistryException($"town.yaml: mode '{town.Mode}' is not known. Use {string.Join(" or ", TownModes.All)}.{DidYouMean.Hint(town.Mode, TownModes.All)}");
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
            .Select(r => ToNode(r, "hub", "hub.yaml", "hub", defaults, new DefaultsFile(), false, new Dictionary<string, string>(), ids, aliases, errors))
            .OfType<RegistryNode>()
            .ToList();
        var hubGroup = new RegistryGroup("hub", hub.DisplayName, hub.Color, true, hubNodes) { TopicServices = hub.Messaging?.Topics ?? [] };
        if (hub.Messaging is { Subscriptions.Count: > 0 })
            errors.Add("hub.yaml: the hub has no workers, so it cannot subscribe to topics. Subscriptions belong in the pillar file of the worker that reads them");
        foreach (var topic in hubGroup.TopicServices.Where(t => !KebabId.IsMatch(t)))
            errors.Add($"hub.yaml: topic '{topic}' must be lowercase kebab-case");

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
                "third-parties.yaml", RegistryVendor.GroupId, defaults, new DefaultsFile(), false, new Dictionary<string, string>(), ids, aliases, errors);
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

        var (topics, subscriptions) = ResolveMessaging(groups, brokenPillars, resilient, Problem);
        var environments = LoadEnvironments(folder, ids, aliases, resilient, Problem);

        if (errors.Count == 1) throw new RegistryException(errors[0]);
        if (errors.Count > 1)
            throw new RegistryException($"The registry has {errors.Count} problems:\n" + string.Join("\n", errors.Select(e => "  - " + e)));

        var final = groups.Select(g => g with { Nodes = g.Nodes.Select(n => n with { Calls = resolved[n.Id], GatewayCalls = resolvedGateway[n.Id] }).ToList() }).ToList();
        var registry = new Registry(new TownInfo(town.Id, town.Name, town.GroupLabel, town.Topology, town.Mode), final, callers)
        {
            Notices = notices, Problems = problems, Vendors = vendors, RingCapacity = ringCapacity, Topics = topics, Subscriptions = subscriptions, Environments = environments,
        };
        return registry with { Warnings = TownLinks.Warnings(registry).ToList() };
    }

    /// <summary>
    /// Reads environments/*.yaml. The file name is the environment's id. A file with problems is reported (an error in a strict load) and, in a
    /// resilient load, left out, so the other environments still run. A town without the folder has no environments.
    /// </summary>
    private static List<RegistryEnvironment> LoadEnvironments(string folder, HashSet<string> ids, Dictionary<string, string> aliases, bool resilient, Action<string> problem)
    {
        var dir = Path.Combine(folder, "environments");
        var result = new List<RegistryEnvironment>();
        if (!Directory.Exists(dir)) return result;
        var parsed = new List<(RegistryEnvironment Env, int Order)>();
        foreach (var file in Directory.GetFiles(dir, "*.yaml").OrderBy(f => f, StringComparer.Ordinal))
        {
            var stem = Path.GetFileNameWithoutExtension(file);
            var name = $"environments/{Path.GetFileName(file)}";
            var own = new List<string>();
            EnvironmentFile? f = null;
            try { f = Read<EnvironmentFile>(file, name); }
            catch (RegistryException e) { own.Add(e.Message); }
            if (f is not null) CheckEnvironment(f, stem, name, ids, aliases, own);
            if (own.Count > 0)
            {
                foreach (var message in own) problem(message);
                continue;
            }
            var excluded = f!.Exclude.Select(id => ids.Contains(id) ? id : aliases[id]).ToHashSet();
            parsed.Add((new RegistryEnvironment(
                stem, f.Name ?? stem, f.Default,
                f.Sources.Select(kv => new RegistrySource(kv.Key, kv.Value.Kind.ToLowerInvariant(), kv.Value.Connection)
                    { Credential = kv.Value.Credential, PollSeconds = kv.Value.PollSeconds, TimeoutSeconds = kv.Value.TimeoutSeconds, Query = kv.Value.Query, Window = kv.Value.Window }).ToList(),
                f.Tenants.Select(t => new RegistryTenant(t.Id, t.Name ?? t.Id, t.Kind.Equals("test", StringComparison.OrdinalIgnoreCase) ? TenantKind.Test : TenantKind.Customer)).ToList(),
                excluded, f.Fake?.UndeclaredTenants ?? [])
            {
                Credentials = f.Credentials.Select(kv => new RegistryCredential(kv.Key, kv.Value.Kind.ToLowerInvariant(), kv.Value.TenantId, kv.Value.ClientId, kv.Value.ClientSecretEnv)).ToList(),
                Signals = f.Signals,
                Scope = ToScope(f.Scope),
            }, f.Order ?? 100));
        }
        var ordered = parsed.OrderBy(p => p.Order).ThenBy(p => p.Env.Id, StringComparer.Ordinal).Select(p => p.Env).ToList();
        if (ordered.Count(e => e.IsDefault) > 1)
            problem($"environments: {string.Join(" and ", ordered.Where(e => e.IsDefault).Select(e => $"'{e.Id}'"))} are all marked default: only one environment can be");
        return ordered;
    }

    private static void CheckEnvironment(EnvironmentFile f, string stem, string name, HashSet<string> ids, Dictionary<string, string> aliases, List<string> errors)
    {
        if (!KebabId.IsMatch(stem)) errors.Add($"{name}: the file name '{stem}' is the environment's id and must be lowercase kebab-case");
        foreach (var (source, def) in f.Sources)
        {
            if (!KebabId.IsMatch(source))
                errors.Add($"{name}: source name '{source}' must be lowercase kebab-case");
            if (!KebabId.IsMatch(def.Kind.ToLowerInvariant()))
                errors.Add($"{name}: source '{source}' has kind '{def.Kind}', which must be lowercase kebab-case. Which kinds exist depends on the adapters loaded; `validate` checks that");
            if (def.PollSeconds is <= 0) errors.Add($"{name}: source '{source}' has pollSeconds {def.PollSeconds}; it must be above 0");
            if (def.TimeoutSeconds is <= 0) errors.Add($"{name}: source '{source}' has timeoutSeconds {def.TimeoutSeconds}; it must be above 0");
            CheckQuery(f, def, source, name, errors);
            if (def.Credential is not null && !f.Credentials.ContainsKey(def.Credential))
                errors.Add($"{name}: source '{source}' uses credential '{def.Credential}', which this file does not define.{DidYouMean.Hint(def.Credential, f.Credentials.Keys)}");
        }
        foreach (var (credential, def) in f.Credentials)
        {
            if (!KebabId.IsMatch(credential)) errors.Add($"{name}: credential name '{credential}' must be lowercase kebab-case");
            if (!KebabId.IsMatch(def.Kind.ToLowerInvariant())) errors.Add($"{name}: credential '{credential}' has kind '{def.Kind}', which must be lowercase kebab-case");
        }
        foreach (var (signal, source) in f.Signals)
        {
            if (!Signals.All.Contains(signal))
                errors.Add($"{name}: unknown signal '{signal}'. Use {string.Join(", ", Signals.All)}.{DidYouMean.Hint(signal, Signals.All)}");
            if (source != Signals.None && !f.Sources.ContainsKey(source))
                errors.Add($"{name}: signal '{signal}' comes from source '{source}', which this file does not define.{DidYouMean.Hint(source, f.Sources.Keys)}");
        }
        CheckScope(f, name, errors);
        var seen = new HashSet<string>();
        foreach (var t in f.Tenants)
        {
            if (!KebabId.IsMatch(t.Id)) errors.Add($"{name}: tenant id '{t.Id}' must be lowercase kebab-case, because it is part of the tenant's database names");
            else if (!seen.Add(t.Id)) errors.Add($"{name}: tenant '{t.Id}' is listed twice");
            if (!t.Kind.Equals("customer", StringComparison.OrdinalIgnoreCase) && !t.Kind.Equals("test", StringComparison.OrdinalIgnoreCase))
                errors.Add($"{name}: tenant '{t.Id}' has kind '{t.Kind}'. Use customer or test.{DidYouMean.Hint(t.Kind, ["customer", "test"])}");
        }
        foreach (var id in f.Fake?.UndeclaredTenants ?? [])
        {
            if (!KebabId.IsMatch(id)) errors.Add($"{name}: undeclared tenant '{id}' must be lowercase kebab-case");
            else if (seen.Contains(id)) errors.Add($"{name}: '{id}' is both listed under tenants and an undeclared tenant: an undeclared tenant is one the list does not name");
        }
        foreach (var id in f.Exclude)
        {
            if (!ids.Contains(id) && !aliases.ContainsKey(id))
                errors.Add($"{name}: excludes '{id}', which is not in this town.{DidYouMean.Hint(id, ids.Concat(aliases.Keys))}");
            else if ((ids.Contains(id) ? id : aliases[id]).StartsWith("hub."))
                errors.Add($"{name}: excludes '{id}', a resource of the hub. The hub is the same in every environment");
        }
    }

    /// <summary>
    /// Turns the declared topics and subscriptions into the town's topic list and the subscriptions that point at a real topic.
    /// A pillar publishes {pillar}-{service}-outbox for each service it lists. A subscription names the full topic and a worker of its own pillar.
    /// Reading the hub's egress topic is the old way for a pillar to hear from another one, so it must say so with legacy: true.
    /// </summary>
    private static (List<RegistryTopic>, List<RegistrySubscription>) ResolveMessaging(List<RegistryGroup> groups, HashSet<string> brokenPillars, bool resilient, Action<string> problem)
    {
        var topics = new List<RegistryTopic>();
        foreach (var g in groups)
            foreach (var service in g.TopicServices.Distinct())
                topics.Add(new RegistryTopic(g.IsHub ? $"hub-{service}" : $"{g.Id}-{service}-outbox", g.Id, service));

        var byName = topics.ToDictionary(t => t.Name);
        var subscriptions = new List<RegistrySubscription>();
        var seen = new HashSet<(string, string)>();
        foreach (var g in groups.Where(g => !g.IsHub))
        {
            var file = $"{g.Id}.yaml";
            foreach (var (topicName, consumer, legacy) in g.SubscriptionDecls)
            {
                if (!byName.TryGetValue(topicName, out var topic))
                {
                    // a topic of a pillar that was skipped is that pillar's problem
                    if (resilient && brokenPillars.Any(b => topicName.StartsWith(b + "-"))) continue;
                    problem($"{file}: '{consumer}' subscribes to topic '{topicName}', which no pillar publishes.{DidYouMean.Hint(topicName, byName.Keys)}");
                    continue;
                }
                var fromHub = topic.GroupId == "hub";
                if (fromHub && !legacy)
                {
                    problem($"{file}: '{consumer}' reads '{topicName}' from the hub. Pillars subscribe to each other's outboxes directly; if this is the old egress route, say so with legacy: true");
                    continue;
                }
                if (!fromHub && legacy)
                {
                    problem($"{file}: the subscription of '{consumer}' to '{topicName}' is marked legacy, but only the hub's egress topic is");
                    continue;
                }
                if (!seen.Add((topicName, consumer)))
                {
                    problem($"{file}: '{consumer}' subscribes to '{topicName}' twice");
                    continue;
                }
                subscriptions.Add(new RegistrySubscription(topicName, topic.GroupId, consumer, g.Id, legacy));
            }
        }
        return (topics, subscriptions);
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
        CheckSignals(p.Signals, "the pillar", name, errors);
        if (!KebabId.IsMatch(p.Pillar))
            errors.Add($"{name}: pillar '{p.Pillar}' must be lowercase kebab-case");
        else if (Path.GetFileNameWithoutExtension(file) != p.Pillar)
            errors.Add($"{name}: pillar '{p.Pillar}' must match the file name");

        var nodes = p.Systems
            .Select(s => ToNode(s, p.Pillar, name, p.Pillar, defaults, p.Defaults, p.External, p.Signals, ids, aliases, errors))
            .OfType<RegistryNode>()
            .ToList();
        if (p.Scope?.Code is { } scopeCode && scopeCode.Trim().Length == 0)
            errors.Add($"{name}: scope.code is empty; leave it out to use the pillar id");
        var group = new RegistryGroup(p.Pillar, p.DisplayName, p.Color, false, nodes)
        {
            Code = p.Scope?.Code,
            TopicServices = p.Messaging?.Topics ?? [],
            SubscriptionDecls = (p.Messaging?.Subscriptions ?? []).Select(x => (x.Topic, x.Consumer, x.Legacy)).ToList(),
        };
        CheckMessaging(group, p.Systems.Select(x => x.Id).ToHashSet(), name, errors);
        return group;
    }

    /// <summary>The parts of a pillar's messaging block that can be checked from its own file alone.</summary>
    private static void CheckMessaging(RegistryGroup g, HashSet<string> declaredIds, string fileName, List<string> errors)
    {
        var services = g.Nodes.Select(n => n.Service).OfType<string>().Distinct().ToList();
        foreach (var service in g.TopicServices)
        {
            if (!services.Contains(service))
                errors.Add($"{fileName}: topic '{service}' is not a service of this pillar, so there is nothing to publish it.{DidYouMean.Hint(service, services)} Topics are service names; the topic is {g.Id}-{service}-outbox");
        }
        if (g.TopicServices.Count != g.TopicServices.Distinct().Count())
            errors.Add($"{fileName}: a topic is listed twice");
        foreach (var (topic, consumer, _) in g.SubscriptionDecls)
        {
            if (string.IsNullOrWhiteSpace(topic)) errors.Add($"{fileName}: a subscription needs a topic");
            var node = g.Nodes.FirstOrDefault(n => n.Id == consumer);
            if (node is null && declaredIds.Contains(consumer)) continue; // the system itself has a problem, which is already reported
            if (node is null)
                errors.Add($"{fileName}: '{consumer}' subscribes to '{topic}', but is not a system of this pillar.{DidYouMean.Hint(consumer, g.Nodes.Select(n => n.Id))}");
            else if (node.Kind != NodeKind.Worker)
                errors.Add($"{fileName}: '{consumer}' subscribes to '{topic}', but a {node.Kind.ToString().ToLowerInvariant()} cannot consume messages: only workers do");
        }
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
        DefaultsFile appDefaults, DefaultsFile pillarDefaults, bool pillarExternal, Dictionary<string, string> pillarSignals,
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
        if (s.ServiceCode is { } code && code.Trim().Length == 0) errors.Add($"{fileName}: serviceCode of '{s.Id}' is empty; leave it out to use the service name");
        if (s.Telemetry?.Role is { } telemetryRole && telemetryRole.Trim().Length == 0) errors.Add($"{fileName}: telemetry.role of '{s.Id}' is empty; leave it out to derive it from the environment");
        CheckSignals(s.Signals, $"'{s.Id}'", fileName, errors);
        if (s.TenantPattern is not null)
        {
            if (kind != NodeKind.Database)
                errors.Add($"{fileName}: '{s.Id}' has a tenantPattern, but only a database (role: db) keeps one database per tenant");
            else if (s.TenantPattern.Split(RegistryEnvironment.TenantToken).Length != 2)
                errors.Add($"{fileName}: tenantPattern '{s.TenantPattern}' of '{s.Id}' must contain {RegistryEnvironment.TenantToken} exactly once, where the tenant id goes (for example merchant-{{tenant}}-db)");
        }
        var role = kind == NodeKind.Database ? "db" : kind.ToString().ToLowerInvariant(); // the YAML spelling
        appDefaults.TryGetValue(role, out var app);
        pillarDefaults.TryGetValue(role, out var pillar);

        var origins = new Dictionary<string, SettingOrigin>();
        double Resolve(string key, Func<RoleDefaultsFile?, double?> pick, double? own)
        {
            if (own is { } mine) { origins[key] = new SettingOrigin(SettingLayer.System, fileName); return mine; }
            if (pick(pillar) is { } fromPillar) { origins[key] = new SettingOrigin(SettingLayer.Pillar, fileName); return fromPillar; }
            if (pick(app) is { } fromApp) { origins[key] = new SettingOrigin(SettingLayer.App, "defaults.yaml"); return fromApp; }
            origins[key] = new SettingOrigin(SettingLayer.BuiltIn, null);
            return pick(BuiltIn)!.Value;
        }

        origins["role"] = new SettingOrigin(SettingLayer.System, fileName);
        origins["external"] = s.External is not null ? new SettingOrigin(SettingLayer.System, fileName)
            : pillarExternal ? new SettingOrigin(SettingLayer.Pillar, fileName)
            : new SettingOrigin(SettingLayer.BuiltIn, null);

        return new RegistryNode(
            s.Id,
            s.Name ?? s.Id[(dot + 1)..],
            groupId,
            kind,
            s.Service,
            s.External ?? pillarExternal,
            Resolve("slaP99Ms", d => d?.SlaP99Ms, s.SlaP99Ms),
            Resolve("errors.amber", d => d?.Errors?.Amber, s.Errors?.Amber),
            Resolve("errors.red", d => d?.Errors?.Red, s.Errors?.Red),
            Resolve("resources.amber", d => d?.Resources?.Amber, s.Resources?.Amber),
            Resolve("resources.red", d => d?.Resources?.Red, s.Resources?.Red),
            Resolve("throttle.amber", d => d?.Throttle?.Amber, s.Throttle?.Amber),
            Resolve("throttle.red", d => d?.Throttle?.Red, s.Throttle?.Red),
            Resolve("backlog.amber", d => d?.Backlog?.Amber, s.Backlog?.Amber),
            Resolve("backlog.red", d => d?.Backlog?.Red, s.Backlog?.Red),
            s.Calls)
        {
            MinCalls = Math.Max(1, (int)Resolve("minCalls", d => d?.MinCalls, s.MinCalls)),
            GatewayCalls = s.GatewayCalls,
            ServiceCode = s.ServiceCode,
            TelemetryRole = s.Telemetry?.Role,
            TenantPattern = s.TenantPattern,
            Signals = Merge(pillarSignals, s.Signals),
            SourceFile = fileName,
            Origins = origins,
        };
    }

    private static IReadOnlyDictionary<string, string> Merge(Dictionary<string, string> pillar, Dictionary<string, string> system) =>
        pillar.Concat(system).GroupBy(kv => kv.Key).ToDictionary(g => g.Key, g => g.Last().Value);

    /// <summary>A signal override must name a known signal and a kebab-case source, or none. Whether the source exists is for each environment to say, so that is not checked here.</summary>
    private static void CheckSignals(Dictionary<string, string> signals, string owner, string fileName, List<string> errors)
    {
        foreach (var (signal, source) in signals)
        {
            if (!Signals.All.Contains(signal))
                errors.Add($"{fileName}: {owner} has signals.{signal}, which is not a signal. Use {string.Join(", ", Signals.All)}.{DidYouMean.Hint(signal, Signals.All)}");
            if (source != Signals.None && !KebabId.IsMatch(source))
                errors.Add($"{fileName}: {owner} points signals.{signal} at '{source}'; use a source name from the environment files (lowercase kebab-case) or {Signals.None}");
        }
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
