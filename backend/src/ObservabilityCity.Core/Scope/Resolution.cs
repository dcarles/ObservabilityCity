namespace ObservabilityCity.Core.Scope;

/// <summary>Where a pillar lives. <see cref="Via"/> says how it was found: explicit, name or tag; empty when it is not (yet) known.</summary>
public sealed record PillarScope(string PillarId, string Code, string? SubscriptionId, string? SubscriptionName, string Via);

/// <summary>A resource that belongs to a system, and the rule that said so. Tenant is the tenant id without dashes, lowercase; null when the rule has none.</summary>
public sealed record ResolvedResource(string Id, string Name, string Type, string? Region, string? Tenant, string Rule);

/// <summary>Everything the sources need to know about one system: where it is, what its telemetry calls it and which resources are its.</summary>
public sealed record SystemScope(
    string SystemId,
    string? ServiceCode,
    string? TelemetryRole,
    string? TelemetryRoleVia,
    string? SubscriptionId,
    string? Workspace,
    IReadOnlyList<ResolvedResource> Resources);

/// <summary>A tenant's friendly name, read from a tag on its resources. Id is lowercase without dashes (see <see cref="ScopeResolver.TenantKey"/>).</summary>
public sealed record TenantName(string Id, string Name);

/// <summary>
/// The scope of every pillar and system of one environment. <see cref="InventoryRead"/> is false until the inventory has been read; the parts that need
/// it (found subscriptions, resources, tenant names) are then missing, which is not a problem. <see cref="Problems"/> are things the rules could not
/// settle: a pillar no subscription matches, two systems with the same telemetry role.
/// </summary>
public sealed record Resolution(
    IReadOnlyList<PillarScope> Pillars,
    IReadOnlyList<SystemScope> Systems,
    IReadOnlyList<TenantName> TenantNames,
    IReadOnlyList<string> Problems,
    bool InventoryRead,
    string? Workspace)
{
    public static Resolution Empty { get; } = new([], [], [], [], false, null);
    public SystemScope? System(string id) => Systems.FirstOrDefault(s => s.SystemId == id);
    public PillarScope? Pillar(string id) => Pillars.FirstOrDefault(p => p.PillarId == id);
}
