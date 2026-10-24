using ObservabilityCity.Contracts;

namespace ObservabilityCity.Core.Registry;

/// <summary>Everything the registry folder says about one town.</summary>
public sealed record Registry(
    TownInfo Town,
    IReadOnlyList<RegistryGroup> Groups)
{
    public IEnumerable<RegistryNode> AllNodes => Groups.SelectMany(g => g.Nodes);
}

public sealed record TownInfo(string Id, string Name, string GroupLabel, string Topology);

/// <summary>An island. The hub is a group too, flagged IsHub.</summary>
public sealed record RegistryGroup(
    string Id,
    string DisplayName,
    string Color,
    bool IsHub,
    IReadOnlyList<RegistryNode> Nodes);

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
    double ErrorRed);

/// <summary>Raised when a registry file is wrong. The message names the file and the id.</summary>
public sealed class RegistryException(string message) : Exception(message);
