using ObservabilityCity.Contracts;

namespace ObservabilityCity.Core.Scope;

/// <summary>Where a pillar lives. <see cref="Via"/> says how it was found: explicit, name or tag; empty when it is not (yet) known.</summary>
public sealed record PillarScope(string PillarId, string Code, string? SubscriptionId, string? SubscriptionName, string Via);

/// <summary>A resource that belongs to a system, and the rule that said so. Tenant is the tenant id without dashes, lowercase; null when the rule has none.</summary>
public sealed record ResolvedResource(string Id, string Name, string Type, string? Region, string? Tenant, string Rule, int? Instances = null, bool? Running = null);

/// <summary>A resource that stands in the town as a basic building (see <see cref="AssetRule"/>). Id is the pillar and the resource's name in lowercase. Service is the registry's service name it belongs to, null for the pillar as a whole.</summary>
public sealed record ResolvedAsset(string Id, string PillarId, string Name, string Label, string Shape, string Type, string? Service, string? Region, string ResourceId, string Rule, string? SubscriptionId, string? Group = null);

/// <summary>Everything the sources need to know about one system: where it is, what its telemetry calls it and which resources are its.</summary>
public sealed record SystemScope(
    string SystemId,
    string? ServiceCode,
    string? TelemetryRole,
    string? TelemetryRoleVia,
    string? SubscriptionId,
    string? Workspace,
    IReadOnlyList<ResolvedResource> Resources)
{
    /// <summary>How many instances the system runs: the sum over its resources that carry a count. Null when none does, so the number is unknown rather than zero.</summary>
    public int? Instances => Resources.Any(r => r.Instances is not null) ? Resources.Sum(r => r.Instances ?? 0) : null;

    /// <summary>
    /// Whether the cloud runs the system's app, for a system whose rules read an app state: Running when any such resource runs, Stopped when none does, Missing when
    /// the inventory has been read and finds no such resource. Null when no rule reads a state (or the inventory has not been read), which says nothing.
    /// </summary>
    public AppState? AppState { get; init; }
}

/// <summary>A tenant's friendly name, read from a tag on its resources. Id is lowercase without dashes (see <see cref="ScopeResolver.TenantKey"/>).</summary>
public sealed record TenantName(string Id, string Name);

/// <summary>
/// The scope of every pillar and system of one environment. <see cref="InventoryRead"/> is false until the inventory has been read; the parts that need
/// it (found subscriptions, resources, tenant names) are then missing, which is not a problem. <see cref="Problems"/> are things the rules could not
/// settle: a pillar no subscription matches, two systems with the same telemetry role. <see cref="Workspace"/> is the workspace as the environment names
/// it; <see cref="WorkspaceId"/> is the id a query goes to (null while it is not known) and <see cref="WorkspaceVia"/> says how it was settled: "id" (given
/// as an id) or "name" (found in the inventory by its name).
/// </summary>
public sealed record Resolution(
    IReadOnlyList<PillarScope> Pillars,
    IReadOnlyList<SystemScope> Systems,
    IReadOnlyList<TenantName> TenantNames,
    IReadOnlyList<string> Problems,
    bool InventoryRead,
    string? Workspace,
    string? WorkspaceId = null,
    string? WorkspaceVia = null,
    IReadOnlyList<ResolvedAsset>? Assets = null)
{
    public IReadOnlyList<ResolvedAsset> AssetList => Assets ?? [];
    public static Resolution Empty { get; } = new([], [], [], [], false, null);
    public SystemScope? System(string id) => Systems.FirstOrDefault(s => s.SystemId == id);
    public PillarScope? Pillar(string id) => Pillars.FirstOrDefault(p => p.PillarId == id);
}
