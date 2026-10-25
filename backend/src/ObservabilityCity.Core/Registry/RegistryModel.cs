using ObservabilityCity.Contracts;

namespace ObservabilityCity.Core.Registry;

/// <summary>Everything the registry folder says about one town.</summary>
public sealed record Registry(
    TownInfo Town,
    IReadOnlyList<RegistryGroup> Groups,
    IReadOnlyList<ExternalCaller> ExternalCallers)
{
    public IEnumerable<RegistryNode> AllNodes => Groups.SelectMany(g => g.Nodes);

    /// <summary>How many islands fit on the first ring (layout.yaml ringCapacity). The town holds up to <see cref="MaxPillars"/> pillars on two rings.</summary>
    public int RingCapacity { get; init; } = DefaultRingCapacity;

    public const int DefaultRingCapacity = 12;
    public const int MinRingCapacity = 6;
    public const int MaxRingCapacity = 18;

    /// <summary>Two rings of <paramref name="ringCapacity"/>, less the place the airport takes in the second.</summary>
    public static int MaxPillars(int ringCapacity) => ringCapacity * 2 - 1;

    /// <summary>Third parties outside the town. They are not part of any group: they stand on offshore islands.</summary>
    public IReadOnlyList<RegistryVendor> Vendors { get; init; } = [];

    /// <summary>Problems a resilient load worked around (a skipped pillar file, a dropped call link). Always empty after a strict load.</summary>
    public IReadOnlyList<string> Notices { get; init; } = [];

    /// <summary>Every individual problem a resilient load worked around, in full (Notices keeps one line per skipped file). Empty exactly when a strict load would succeed.</summary>
    public IReadOnlyList<string> Problems { get; init; } = [];
}

public sealed record TownInfo(string Id, string Name, string GroupLabel, string Topology);

/// <summary>An island. The hub is a group too, flagged IsHub.</summary>
public sealed record RegistryGroup(
    string Id,
    string DisplayName,
    string Color,
    bool IsHub,
    IReadOnlyList<RegistryNode> Nodes,
    string? ConfigError = null)
{
    /// <summary>The pillar id of the island that collects systems no pillar owns.</summary>
    public const string LostFoundId = "lost-found";

    public bool IsLostFound => Id == LostFoundId;
}

/// <summary>A third party (a credit bureau, a data warehouse). Its Node uses the group id <see cref="GroupId"/>; CalledBy lists our systems that call it.</summary>
public sealed record RegistryVendor(RegistryNode Node, IReadOnlyList<string> CalledBy)
{
    /// <summary>The group id every vendor id starts with (ext.snowflake).</summary>
    public const string GroupId = "ext";
}

/// <summary>Someone outside the town (an app, a partner) and the external systems it calls.</summary>
public sealed record ExternalCaller(string Id, string Name, IReadOnlyList<string> Calls);

/// <summary>A building with its settings already resolved through the defaults cascade.</summary>
public sealed record RegistryNode(
    string Id,
    string Name,
    string GroupId,
    NodeKind Kind,
    string? Service,
    bool External,
    double SlaP99Ms,
    double ErrorAmber,
    double ErrorRed,
    double ResourceAmber,
    double ResourceRed,
    double ThrottleAmber,
    double ThrottleRed,
    double BacklogAmber,
    double BacklogRed,
    IReadOnlyList<string> Calls)
{
    /// <summary>Systems on other islands this one reaches through the API gateway. Only the dependency overlay and the cars' origins use them.</summary>
    public IReadOnlyList<string> GatewayCalls { get; init; } = [];
}

/// <summary>Raised when a registry file is wrong. The message names the file and the id.</summary>
public sealed class RegistryException(string message) : Exception(message);
