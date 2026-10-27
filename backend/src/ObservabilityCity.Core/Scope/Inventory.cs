namespace ObservabilityCity.Core.Scope;

/// <summary>A subscription as the inventory source found it.</summary>
public sealed record InventorySubscription(string Id, string Name, IReadOnlyDictionary<string, string> Tags);

/// <summary>A resource as the inventory source found it. Instances is how many the rule's expression counted, null when the rule has none or the resource gave no number.</summary>
public sealed record InventoryResource(string Id, string Name, string Type, string SubscriptionId, string? Region, IReadOnlyDictionary<string, string> Tags, int? Instances = null);

/// <summary>What one read of the inventory returned. The rules in the environment file turn it into the town's scopes (see <see cref="ScopeResolver"/>).</summary>
public sealed record Inventory(IReadOnlyList<InventorySubscription> Subscriptions, IReadOnlyList<InventoryResource> Resources);
