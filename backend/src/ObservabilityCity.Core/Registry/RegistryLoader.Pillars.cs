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
    /// A pillar publishes a topic named by the town's messaging.topicTemplate for each service it lists (the hub's by messaging.hubTopicTemplate).
    /// A subscription names the full topic and a worker of its own pillar.
    /// Reading a topic of an owner the town lists in messaging.legacyFrom is the old route, so it must say so with legacy: true.
    /// </summary>
    private static (List<RegistryTopic>, List<RegistrySubscription>) ResolveMessaging(List<RegistryGroup> groups, HashSet<string> brokenPillars, bool resilient, Action<string> problem, MessagingConvention convention)
    {
        var topics = new List<RegistryTopic>();
        var byName = new Dictionary<string, RegistryTopic>();
        foreach (var g in groups)
            foreach (var service in g.TopicServices.Distinct())
            {
                var topic = new RegistryTopic(g.IsHub ? convention.HubTopicName(service) : convention.TopicName(g.Id, service), g.Id, service);
                if (byName.TryGetValue(topic.Name, out var first))
                {
                    problem($"{g.Id}.yaml: the topic of '{service}' is called '{topic.Name}', which '{first.GroupId}' already publishes. Add {{pillar}} to messaging.topicTemplate in town.yaml");
                    continue;
                }
                byName.Add(topic.Name, topic);
                topics.Add(topic);
            }

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
                var oldRoute = convention.LegacyFrom.Contains(topic.GroupId);
                if (oldRoute && !legacy)
                {
                    problem($"{file}: '{consumer}' reads '{topicName}' from '{topic.GroupId}', which this town lists in messaging.legacyFrom. If this is the old route, say so with legacy: true");
                    continue;
                }
                if (!oldRoute && legacy)
                {
                    problem($"{file}: the subscription of '{consumer}' to '{topicName}' is marked legacy, but '{topic.GroupId}' is not listed in messaging.legacyFrom in town.yaml");
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
        string file, string name, DefaultsFile defaults, HashSet<string> ids, Dictionary<string, string> aliases, List<string> errors, IReadOnlyDictionary<string, DatabaseEngine> engines,
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
            .Select(s => ToNode(s, p.Pillar, name, p.Pillar, defaults, p.Defaults, p.External, p.Signals, ids, aliases, errors, engines))
            .OfType<RegistryNode>()
            .ToList();
        if (p.Scope?.Code is { } scopeCode && scopeCode.Trim().Length == 0)
            errors.Add($"{name}: scope.code is empty; leave it out to use the pillar id");
        var group = new RegistryGroup(p.Pillar, p.DisplayName, p.Color, false, nodes)
        {
            Code = p.Scope?.Code,
            TopicServices = p.Messaging?.Topics ?? [],
            SubscriptionDecls = (p.Messaging?.Subscriptions ?? []).Select(x => (x.Topic, x.Consumer, x.Legacy)).ToList(),
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
        var services = g.Nodes.Select(n => n.Service).OfType<string>().Distinct().ToList();
        foreach (var service in g.TopicServices)
        {
            if (!services.Contains(service))
                errors.Add($"{fileName}: topic '{service}' is not a service of this pillar, so there is nothing to publish it.{DidYouMean.Hint(service, services)} Topics are named after services; the name comes from messaging.topicTemplate in town.yaml");
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
}
