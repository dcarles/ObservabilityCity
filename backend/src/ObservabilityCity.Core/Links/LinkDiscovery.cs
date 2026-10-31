using System.Text.RegularExpressions;

namespace ObservabilityCity.Core.Links;

/// <summary>
/// How an environment finds the calls its systems really make (<c>links:</c> in the environment file). Every convention is a rule or template: the
/// program knows no host name, path shape or service naming. <see cref="Source"/> names a Log Analytics source of the same file, whose connection and
/// login the discovery query reuses; <see cref="Query"/> is the template it sends (see <see cref="LinkQuery"/>).
/// </summary>
public sealed record LinkDiscovery(
    string Source,
    string Query,
    TimeSpan Interval,
    TimeSpan FirstRead,
    int MinDays,
    TimeSpan KeepFor,
    IReadOnlyList<string> IgnoreHosts,
    IReadOnlyList<LinkRule> Rules,
    IReadOnlyDictionary<string, string> Aliases)
{
    /// <summary>How the share of traffic from town systems is measured; without it nothing says where an API's traffic comes from.</summary>
    public LinkTrafficConfig? Traffic { get; init; }

    public static readonly TimeSpan DefaultInterval = TimeSpan.FromHours(1);
    public static readonly TimeSpan DefaultFirstRead = TimeSpan.FromDays(7);
    public static readonly TimeSpan DefaultKeepFor = TimeSpan.FromDays(30);
    public const int DefaultMinDays = 2;
    public static readonly TimeSpan RegexTimeout = TimeSpan.FromSeconds(1);
}

/// <summary>
/// One way to turn a call's address into a system. <see cref="Host"/> (and <see cref="Path"/>, when the call goes through a gateway that names its
/// destination in the path) are regular expressions with named groups; <see cref="Target"/> is a system id written with {group} holes, and
/// {callerPillar} for the pillar of the system that made the call. <see cref="Gateway"/> says the call goes through the API gateway.
/// </summary>
public sealed record LinkRule(string Host, string? Path, string Target, bool Gateway);

/// <summary>The name of the group a rule's regular expressions capture, apart from the numbered ones.</summary>
public static class LinkRules
{
    public const string CallerPillar = "callerPillar";

    public static IEnumerable<string> GroupNames(string? pattern)
    {
        if (pattern is null) return [];
        return new Regex(pattern, RegexOptions.None, LinkDiscovery.RegexTimeout).GetGroupNames().Where(n => !int.TryParse(n, out _));
    }
}
