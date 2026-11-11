using System.Text.RegularExpressions;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Sources;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ObservabilityCity.Core.Registry;

/// <summary>The pillar files of a registry: loading a pillar, its schedules and messaging. Part of <see cref="RegistryLoader"/>.</summary>
public static partial class RegistryLoader
{
    /// <summary>
    /// Turns the declared topics and subscriptions into the town's topic list and the subscriptions that point at a real topic.
    /// A topic is listed either by its service, and named by the town's messaging.topicTemplate (the hub's by messaging.hubTopicTemplate), or by its own
    /// name, with the service that publishes it or none. Either way the file that lists it is its owner: no owner is read from a name. A name is unique in the town.
    /// A subscription names the full topic and a worker of its own pillar.
    /// In a resilient load, a subscription to a topic of a pillar that was skipped (<paramref name="brokenTopics"/>, or a name the template makes for it) is that pillar's problem.
    /// </summary>
    private static (List<RegistryTopic>, List<RegistrySubscription>) ResolveMessaging(List<RegistryGroup> groups, HashSet<string> brokenPillars, HashSet<string> brokenTopics, bool resilient, Action<string> problem, MessagingConvention convention, Dictionary<string, int> lines)
    {
        var topics = new List<RegistryTopic>();
        var byName = new Dictionary<string, (RegistryTopic Topic, bool ByService)>();
        foreach (var g in groups)
            foreach (var decl in g.TopicDecls)
            {
                if (TopicNameOf(decl, g, convention) is not { } name) continue; // the entry itself is wrong, and that is reported with its file
                var byService = decl.Name is null;
                var topic = new RegistryTopic(name, g.Id, decl.Service);
                if (byName.TryGetValue(name, out var first))
                {
                    if (first.Topic.GroupId == g.Id && first.ByService == byService) continue; // listed twice in one file, which its own check reports
                    if (byService && first.ByService)
                        problem($"{g.Id}.yaml: the topic of '{decl.Service}' is called '{name}', which '{first.Topic.GroupId}' already publishes. Add {{group}} (older name {{pillar}}) to messaging.topicTemplate in town.yaml");
                    else if (byService)
                        problem($"{g.Id}.yaml (line {decl.Line}): the topic of '{decl.Service}' is called '{name}' by the template in town.yaml, but '{first.Topic.GroupId}' lists a topic of that name already. A topic name is unique in the town: rename one of them");
                    else if (first.ByService)
                        problem($"{g.Id}.yaml (line {decl.Line}): topic '{name}' is also the name the template in town.yaml makes for the service '{first.Topic.Service}' of '{first.Topic.GroupId}'. A topic name is unique in the town: rename one of them");
                    else
                        problem($"{g.Id}.yaml (line {decl.Line}): topic '{name}' is listed by '{first.Topic.GroupId}' too. A topic name is unique in the town, and has one owner");
                    continue;
                }
                byName.Add(name, (topic, byService));
                topics.Add(topic);
            }

        var subscriptions = new List<RegistrySubscription>();
        var seen = new HashSet<(string, string)>();
        foreach (var g in groups.Where(g => !g.IsHub))
        {
            var file = $"{g.Id}.yaml";
            foreach (var (topicName, consumer, line) in g.SubscriptionDecls)
            {
                // the message stays as it was; the validator finds the entry's line from here
                void Problem(string message)
                {
                    problem(message);
                    if (line > 0) lines.TryAdd(message, line);
                }
                if (!byName.TryGetValue(topicName, out var owned))
                {
                    // a topic of a pillar that was skipped is that pillar's problem
                    if (resilient && (brokenTopics.Contains(topicName) || brokenPillars.Any(b => convention.CouldBeTopicOf(b, topicName)))) continue;
                    Problem($"{file}: '{consumer}' subscribes to topic '{topicName}', which no pillar publishes.{DidYouMean.Hint(topicName, byName.Keys)}");
                    continue;
                }
                var topic = owned.Topic;
                if (!seen.Add((topicName, consumer)))
                {
                    Problem($"{file}: '{consumer}' subscribes to '{topicName}' twice");
                    continue;
                }
                subscriptions.Add(new RegistrySubscription(topicName, topic.GroupId, consumer, g.Id));
            }
        }
        return (topics, subscriptions);
    }

    /// <summary>
    /// The name of a listed topic: its own name, or the one the town's template makes of its service. Null when there is none to give: a template without
    /// {service} cannot name a service's topic (the town reports that once), and an empty name is the file's problem.
    /// </summary>
    private static string? TopicNameOf(TopicDecl decl, RegistryGroup g, MessagingConvention convention)
    {
        if (decl.Name is not null) return decl.Name.Length == 0 ? null : decl.Name;
        if (string.IsNullOrWhiteSpace(decl.Service)) return null;
        var template = g.IsHub ? convention.HubTopicTemplate : convention.TopicTemplate;
        if (!template.Contains("{service}")) return null;
        return g.IsHub ? convention.HubTopicName(decl.Service) : convention.TopicName(g.Id, decl.Service);
    }

    /// <summary>The entries of a topics: list as the loader keeps them.</summary>
    private static List<TopicDecl> ToTopicDecls(MessagingFile? messaging) =>
        (messaging?.Topics ?? []).Where(t => t is not null).Select(t => t.ByService ? new TopicDecl(null, t.Service, t.Line) : new TopicDecl(t.Topic ?? "", t.Service, t.Line)).ToList();

    /// <summary>
    /// The topic names a pillar file that could not be loaded would publish, read from its raw YAML as far as it goes, so a resilient load can drop the
    /// subscriptions to them quietly. Empty when even that cannot be read.
    /// </summary>
    private static IEnumerable<string> TopicNamesOfUnreadFile(string file, string pillarId, MessagingConvention convention)
    {
        var names = new List<string>();
        try
        {
            var stream = new YamlDotNet.RepresentationModel.YamlStream();
            using (var reader = new StreamReader(file)) stream.Load(reader);
            if (stream.Documents.Count == 0 || stream.Documents[0].RootNode is not YamlDotNet.RepresentationModel.YamlMappingNode root) return names;
            var key = new YamlDotNet.RepresentationModel.YamlScalarNode("messaging");
            if (!root.Children.TryGetValue(key, out var m) || m is not YamlDotNet.RepresentationModel.YamlMappingNode messaging) return names;
            if (!messaging.Children.TryGetValue(new YamlDotNet.RepresentationModel.YamlScalarNode("topics"), out var t) || t is not YamlDotNet.RepresentationModel.YamlSequenceNode list) return names;
            foreach (var entry in list.Children)
            {
                if (entry is YamlDotNet.RepresentationModel.YamlScalarNode { Value: { Length: > 0 } service } && convention.TopicTemplate.Contains("{service}"))
                    names.Add(convention.TopicName(pillarId, service));
                else if (entry is YamlDotNet.RepresentationModel.YamlMappingNode named
                    && named.Children.TryGetValue(new YamlDotNet.RepresentationModel.YamlScalarNode("topic"), out var n) && n is YamlDotNet.RepresentationModel.YamlScalarNode { Value: { Length: > 0 } name })
                    names.Add(name);
            }
        }
        catch (Exception e) when (e is YamlDotNet.Core.YamlException or IOException)
        {
            // nothing more to learn from the file: a name the template makes for the pillar is still recognised
        }
        return names;
    }

    /// <summary>Reads one pillar file. Problems found in it go to <paramref name="errors"/>; the ids and aliases it would add are returned, so a caller can drop them with the file.</summary>
    private static RegistryGroup LoadPillar(
        string file, string name, DefaultsFile defaults, HashSet<string> ids, Dictionary<string, string> aliases, List<string> errors, IReadOnlyDictionary<string, DatabaseEngine> engines,
        out HashSet<string> pillarIds, out Dictionary<string, string> pillarAliases)
    {
        pillarIds = ids;
        pillarAliases = aliases;
        var p = Read<PillarFile>(file);
        CheckRoleKeys(p.Defaults, name, errors);
        CheckSignals(p.Signals, "the pillar", name, errors);
        if (p.Pillar.Length == 0)
            errors.Add($"{name}: group is missing: give the group's id, the file name without .yaml (older name of the key: pillar)");
        else if (!KebabId.IsMatch(p.Pillar))
            errors.Add($"{name}: group '{p.Pillar}' must be lowercase kebab-case");
        else if (Path.GetFileNameWithoutExtension(file) != p.Pillar)
            errors.Add($"{name}: group '{p.Pillar}' must match the file name");

        var nodes = p.Systems
            .Select(s => ToNode(s, p.Pillar, name, p.Pillar, defaults, p.Defaults, p.External, p.Signals, ids, aliases, errors, engines))
            .OfType<RegistryNode>()
            .ToList();
        if (p.Scope?.Code is { } scopeCode && scopeCode.Trim().Length == 0)
            errors.Add($"{name}: scope.code is empty; leave it out to use the pillar id");
        var group = new RegistryGroup(p.Pillar, p.DisplayName, p.Color, false, nodes)
        {
            Code = p.Scope?.Code,
            TopicDecls = ToTopicDecls(p.Messaging),
            SubscriptionDecls = (p.Messaging?.Subscriptions ?? []).Select(x => (x.Topic, x.Consumer, x.Line)).ToList(),
            Schedules = ToSchedules(p, nodes, name, errors),
        };
        CheckMessaging(group, p.Systems.Select(x => x.Id).ToHashSet(), name, errors);
        return group;
    }

    /// <summary>The pillar's <c>scheduler:</c> list: every entry names a function of the pillar, and every job names services of the pillar.</summary>
    private static List<RegistrySchedule> ToSchedules(PillarFile p, List<RegistryNode> nodes, string fileName, List<string> errors)
    {
        var schedules = new List<RegistrySchedule>();
        var services = nodes.Select(n => n.Service).OfType<string>().Distinct().ToList();
        foreach (var entry in p.Scheduler)
        {
            var node = nodes.FirstOrDefault(n => n.Id == $"{p.Pillar}.{entry.System}" || n.Id == entry.System);
            if (node is null)
            {
                errors.Add($"{fileName}: scheduler: '{entry.System}' is not a system of this pillar.{DidYouMean.Hint(entry.System, nodes.Select(n => n.Id))}");
                continue;
            }
            if (node.Kind != NodeKind.Function)
            {
                errors.Add($"{fileName}: scheduler: '{entry.System}' is a {node.Kind.ToString().ToLowerInvariant()}, but only a function has scheduled jobs");
                continue;
            }
            foreach (var (job, targets) in entry.Jobs)
            {
                if (string.IsNullOrWhiteSpace(job)) { errors.Add($"{fileName}: scheduler: a job of '{entry.System}' has no name"); continue; }
                var clean = (targets ?? []).Where(t => !string.IsNullOrWhiteSpace(t)).Select(t => t.Trim()).Distinct().ToList();
                foreach (var t in clean.Where(t => !services.Contains(t)))
                    errors.Add($"{fileName}: scheduler: job '{job}' starts work for '{t}', which is not a service of this pillar.{DidYouMean.Hint(t, services)}");
                schedules.Add(new RegistrySchedule(node.Id, job.Trim(), clean));
            }
        }
        return schedules;
    }

    /// <summary>The parts of a pillar's messaging block that can be checked from its own file alone.</summary>
    private static void CheckMessaging(RegistryGroup g, HashSet<string> declaredIds, string fileName, List<string> errors)
    {
        CheckTopics(g, fileName, errors);
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

    // A topic's own name: anything a broker takes, but not a space or a {variable} left from a template.
    private static readonly Regex TopicNameShape = new(@"^[^\s{}]+$", RegexOptions.Compiled);

    /// <summary>
    /// The topics: list of a pillar file or hub.yaml. A short entry is a service of the island (on the hub, a kebab-case name for the hub's template); a block
    /// names the topic, and its service, if it gives one, is a service of the island.
    /// </summary>
    private static void CheckTopics(RegistryGroup g, string fileName, List<string> errors)
    {
        var services = g.Nodes.Select(n => n.Service).OfType<string>().Distinct().ToList();
        var shortForm = g.TopicDecls.Where(d => d.Name is null).Select(d => d.Service ?? "").ToList();
        foreach (var service in shortForm)
        {
            if (g.IsHub)
            {
                if (!KebabId.IsMatch(service)) errors.Add($"hub.yaml: topic '{service}' must be lowercase kebab-case");
            }
            else if (!services.Contains(service))
                errors.Add($"{fileName}: topic '{service}' is not a service of this pillar, so there is nothing to publish it.{DidYouMean.Hint(service, services)} A plain entry is a service, named by messaging.topicTemplate in town.yaml; to give a topic its own name, write {{ topic: <name>, service: <service> }}");
        }
        if (shortForm.Count != shortForm.Distinct().Count())
            errors.Add($"{fileName}: a topic is listed twice");

        var named = new HashSet<string>(StringComparer.Ordinal);
        foreach (var d in g.TopicDecls.Where(d => d.Name is not null))
        {
            var at = $"{fileName} (line {d.Line})";
            if (d.Name!.Length == 0)
            {
                errors.Add($"{at}: a topic block needs a name: {{ topic: <name> }}, with the service that publishes it if one does");
                continue;
            }
            if (!TopicNameShape.IsMatch(d.Name))
                errors.Add($"{at}: topic '{d.Name}' is not a name a broker takes: no spaces, and no {{variables}} (a template is only for a topic listed by its service)");
            if (!named.Add(d.Name))
                errors.Add($"{at}: topic '{d.Name}' is listed twice");
            if (d.Service is { } service && !services.Contains(service))
                errors.Add($"{at}: topic '{d.Name}' is published by '{service}', which is not a service of this {(g.IsHub ? "hub" : "pillar")}.{DidYouMean.Hint(service, services)} Leave service out for a topic that belongs to the {(g.IsHub ? "hub" : "pillar")} as a whole");
        }
    }
}
