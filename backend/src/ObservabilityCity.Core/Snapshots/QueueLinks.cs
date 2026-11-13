using System.Text.RegularExpressions;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>Where a queue's own page opens in the cloud portal, one address for each namespace that holds the queue, from the template the environment names (in the settings of its broker source, see <see cref="IQueueLinkSettings"/>).</summary>
public static class QueueLinks
{
    /// <summary>The variables a queue link's URL may use, besides the environment's own <c>scope.variables</c>. {namespaceResourceId} is the id the cloud gives the namespace that holds the queue.</summary>
    public static readonly string[] Variables = [GroupWords.Group, GroupWords.Pillar, "service", "system", "environment", "queue", "region", "namespaceResourceId"];

    /// <summary>
    /// The links of a queue, or null: the environment names no template, the queue has no known namespace, or the address needs a word that is not known. Every word is escaped (a
    /// resource id keeps its slashes), so a queue name can never change the shape of the address. When a queue is in several namespaces each link carries its region as its label.
    /// </summary>
    public static IReadOnlyList<QueueLinkSnapshot>? For(Registry.Registry registry, RegistryNode node, string queue, IReadOnlyList<QueueNamespaceReading>? namespaces, Func<string, string> label)
    {
        var env = registry.ActiveEnvironment;
        var link = env?.Sources.Select(s => s.Typed).OfType<IQueueLinkSettings>().Select(s => s.QueueLink).FirstOrDefault(l => l is not null);
        if (env is null || link is null || namespaces is null || namespaces.Count == 0) return null;
        var group = registry.Groups.FirstOrDefault(g => g.Id == node.GroupId);
        var result = new List<QueueLinkSnapshot>();
        foreach (var ns in namespaces.OrderBy(n => n.Region, StringComparer.OrdinalIgnoreCase).ThenBy(n => n.ResourceId, StringComparer.OrdinalIgnoreCase))
        {
            var words = env.Scope.Variables.ToDictionary(kv => kv.Key, kv => (string?)kv.Value);
            foreach (var (key, word) in new Dictionary<string, string?>
            {
                [GroupWords.Group] = group?.Code ?? group?.Id,
                [GroupWords.Pillar] = group?.Code ?? group?.Id,
                ["service"] = node.ServiceCode ?? node.Service,
                ["system"] = node.Id,
                ["environment"] = env.Id,
                ["queue"] = queue,
                ["region"] = ns.Region,
                ["namespaceResourceId"] = ns.ResourceId,
            }) words[key] = word; // the built-in words win over a variable of the same name
            var missing = false;
            var url = Regex.Replace(link.Url, @"\{([^{}]*)\}", m =>
            {
                var name = m.Groups[1].Value;
                if (words.TryGetValue(name, out var word) && !string.IsNullOrEmpty(word))
                    return name == "namespaceResourceId" ? string.Join("/", word.Split('/').Select(Uri.EscapeDataString)) : Uri.EscapeDataString(word);
                missing = true;
                return "";
            });
            if (missing || !Uri.TryCreate(url, UriKind.Absolute, out var parsed) || (parsed.Scheme != Uri.UriSchemeHttps && parsed.Scheme != Uri.UriSchemeHttp)) continue;
            result.Add(new QueueLinkSnapshot(link.Name, url, namespaces.Count > 1 && !string.IsNullOrWhiteSpace(ns.Region) ? label(ns.Region!) : null));
        }
        return result.Count == 0 ? null : result;
    }
}
