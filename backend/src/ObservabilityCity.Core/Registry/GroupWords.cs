using System.Text.RegularExpressions;

namespace ObservabilityCity.Core.Registry;

/// <summary>
/// "group" is the neutral word for an island's group of systems; older files say "pillar", and both read the same. The town's <c>groupLabel</c> is what the
/// interface calls a group; these are only the words of the files: the folder (<c>groups/</c> or <c>pillars/</c>), the key of a group file (<c>group:</c> or
/// <c>pillar:</c>), the template variables (<c>{group}</c> or <c>{pillar}</c>, <c>{groupId}</c> or <c>{pillarId}</c>, <c>{callerGroup}</c> or
/// <c>{callerPillar}</c>), the named groups of a pattern (<c>(?&lt;group&gt;...)</c> or <c>(?&lt;pillar&gt;...)</c>, <c>(?&lt;producerGroup&gt;...)</c> or
/// <c>(?&lt;producerPillar&gt;...)</c>) and the scope key that names a group's account (<c>groupAccounts</c>, or <c>pillarAccounts</c> and its Azure name <c>pillars</c>).
/// </summary>
public static class GroupWords
{
    /// <summary>The folder of the group files.</summary>
    public const string Folder = "groups";

    /// <summary>The older name of <see cref="Folder"/>.</summary>
    public const string OlderFolder = "pillars";

    /// <summary>The key of a group file that names the group, and the template variable and pattern group of its code.</summary>
    public const string Group = "group";

    /// <summary>The older name of <see cref="Group"/>.</summary>
    public const string Pillar = "pillar";

    /// <summary>Each neutral template variable or pattern group to its older name.</summary>
    public static readonly IReadOnlyDictionary<string, string> OlderNames = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [Group] = Pillar,
        ["groupId"] = "pillarId",
        ["callerGroup"] = "callerPillar",
    };

    /// <summary>The named group of a broker entity pattern that says the group of the entity's publisher.</summary>
    public const string ProducerGroup = "producerGroup";

    /// <summary>The older name of <see cref="ProducerGroup"/>. It is a pattern group only, never a template variable, so it is not in <see cref="OlderNames"/>.</summary>
    public const string OlderProducerGroup = "producerPillar";

    /// <summary>The scope key that names a group's account outright.</summary>
    public const string GroupAccounts = "groupAccounts";

    /// <summary>The older name of <see cref="GroupAccounts"/>. Its Azure name, <c>pillars</c>, reads too.</summary>
    public const string OlderGroupAccounts = "pillarAccounts";

    private static readonly KeyValuePair<string, string>[] Pairs = [.. OlderNames, KeyValuePair.Create(ProducerGroup, OlderProducerGroup)];

    private static readonly Dictionary<string, string> Twins = Pairs.Concat(Pairs.Select(kv => KeyValuePair.Create(kv.Value, kv.Key))).ToDictionary(StringComparer.Ordinal);

    /// <summary>The other spelling of a variable or pattern group (group for pillar, pillar for group), or null for a name that has none.</summary>
    public static string? Twin(string name) => Twins.GetValueOrDefault(name);

    /// <summary>The names with the other spelling of each that has one, so a template may use either.</summary>
    public static IEnumerable<string> WithTwins(IEnumerable<string> names)
    {
        var list = names.ToList();
        return list.Concat(list.Select(Twin).OfType<string>()).Distinct(StringComparer.Ordinal);
    }

    /// <summary>A named group of a match under either spelling: <paramref name="name"/> when it matched, else its twin.</summary>
    public static System.Text.RegularExpressions.Group Captured(Match match, string name) =>
        match.Groups[name] is { Success: true } || Twin(name) is not { } twin ? match.Groups[name] : match.Groups[twin];

    /// <summary>Whether a pattern has the named group under either spelling.</summary>
    public static bool HasGroup(IEnumerable<string> groupNames, string name) => groupNames.Any(g => g == name || g == Twin(name));
}
