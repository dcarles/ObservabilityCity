using System.Text.RegularExpressions;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>Where the dead letters of one queue open in the support tool the environment names (in the settings of its broker source, see <see cref="IDeadLetterLinkSettings"/>).</summary>
public static class DeadLetterLinks
{
    /// <summary>The variables a dead-letter link's URL may use.</summary>
    public static readonly string[] Variables = ["pillar", "service", "system", "environment", "queue"];

    /// <summary>
    /// The link for a queue a consumer reads, or null: the environment names no tool, or the address needs a word the system has none of (a pillar or service
    /// code). The words are escaped, so a queue name can never change the shape of the address.
    /// </summary>
    public static ResourceLink? For(Registry.Registry registry, RegistryNode node, string queue, string? region = null)
    {
        var env = registry.ActiveEnvironment;
        var entities = env?.Sources.Select(s => s.Typed).OfType<IDeadLetterLinkSettings>().ToList();
        // the address of the region's own tool, else the one for all regions
        var link = (region is null ? null : entities?.SelectMany(e => e.DeadLetterLinks ?? []).FirstOrDefault(l => l.Region.Equals(region, StringComparison.OrdinalIgnoreCase))?.Link)
            ?? entities?.Select(e => e.DeadLetterLink).FirstOrDefault(l => l is not null);
        if (env is null || link is null) return null;
        var group = registry.Groups.FirstOrDefault(g => g.Id == node.GroupId);
        var words = new Dictionary<string, string?>
        {
            ["pillar"] = group?.Code ?? group?.Id,
            ["service"] = node.ServiceCode ?? node.Service,
            ["system"] = node.Id,
            ["environment"] = env.Id,
            ["queue"] = queue,
        };
        var missing = false;
        var url = Regex.Replace(link.Url, @"\{([^{}]*)\}", m =>
        {
            if (words.TryGetValue(m.Groups[1].Value, out var word) && !string.IsNullOrEmpty(word)) return Uri.EscapeDataString(word);
            missing = true;
            return "";
        });
        return missing ? null : new ResourceLink(link.Name, url);
    }
}
