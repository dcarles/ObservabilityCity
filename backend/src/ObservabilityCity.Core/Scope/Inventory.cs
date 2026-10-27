namespace ObservabilityCity.Core.Scope;

/// <summary>A subscription as the inventory source found it.</summary>
public sealed record InventorySubscription(string Id, string Name, IReadOnlyDictionary<string, string> Tags);

/// <summary>A resource as the inventory source found it. Instances is how many the rule's expression counted, null when the rule has none or the resource gave no number.</summary>
public sealed record InventoryResource(string Id, string Name, string Type, string SubscriptionId, string? Region, IReadOnlyDictionary<string, string> Tags, int? Instances = null);

/// <summary>A Log Analytics workspace as the inventory source found it: its resource id, its name and its workspace id (the GUID the query API takes; null when the answer gave none).</summary>
public sealed record InventoryWorkspace(string Id, string Name, string? CustomerId);

/// <summary>What one read of the inventory returned. The rules in the environment file turn it into the town's scopes (see <see cref="ScopeResolver"/>).</summary>
/// <remarks><see cref="Workspaces"/> is null when the workspaces were not asked for (no workspace to look up), which is not the same as none being found.</remarks>
public sealed record Inventory(IReadOnlyList<InventorySubscription> Subscriptions, IReadOnlyList<InventoryResource> Resources, IReadOnlyList<InventoryWorkspace>? Workspaces = null);
