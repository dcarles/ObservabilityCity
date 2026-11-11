namespace ObservabilityCity.Core.Scope;

/// <summary>An account (an Azure subscription, an AWS account, a GCP project) as the inventory source found it.</summary>
public sealed record InventoryAccount(string Id, string Name, IReadOnlyDictionary<string, string> Tags);

/// <summary>A resource as the inventory source found it, in the account <see cref="AccountId"/>. Instances is how many the rule's expression counted, null when the rule has none or the resource gave no number. State is the app state the rule's <c>state</c> expression read (Running, Stopped, ...), null when it has none or gave nothing.</summary>
public sealed record InventoryResource(string Id, string Name, string Type, string AccountId, string? Region, IReadOnlyDictionary<string, string> Tags, int? Instances = null, string? State = null);

/// <summary>A telemetry store (on Azure, a Log Analytics workspace) as the inventory source found it: its resource id, its name and the id it is queried by (on Azure the workspace GUID; null when the answer gave none).</summary>
public sealed record InventoryTelemetryStore(string Id, string Name, string? QueryId);

/// <summary>What one read of the inventory returned. The rules in the environment file turn it into the town's scopes (see <see cref="ScopeResolver"/>).</summary>
/// <remarks><see cref="TelemetryStores"/> is null when the telemetry stores were not asked for (none to look up), which is not the same as none being found.</remarks>
public sealed record Inventory(IReadOnlyList<InventoryAccount> Accounts, IReadOnlyList<InventoryResource> Resources, IReadOnlyList<InventoryTelemetryStore>? TelemetryStores = null);
