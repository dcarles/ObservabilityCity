using ObservabilityCity.Contracts;

namespace ObservabilityCity.Core.Registry;

/// <summary>Everything the registry folder says about one town.</summary>
public sealed partial record Registry(
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

    /// <summary>Every topic in the town: the outboxes the pillars publish and the hub's own.</summary>
    public IReadOnlyList<RegistryTopic> Topics { get; init; } = [];

    /// <summary>Every worker's subscription to a topic. A worker consumes only what it subscribes to.</summary>
    public IReadOnlyList<RegistrySubscription> Subscriptions { get; init; } = [];

    /// <summary>Things worth fixing that do not stop the town, such as an island nothing connects to. A strict load keeps them too; they are not errors.</summary>
    public IReadOnlyList<string> Warnings { get; init; } = [];

    /// <summary>The workers that consume at least one topic. Only these have a queue and a dead-letter queue.</summary>
    public IReadOnlySet<string> ConsumerIds => Subscriptions.Select(s => s.ConsumerId).ToHashSet();

    /// <summary>
    /// The environments of this town (environments/*.yaml). Empty when the folder has none: the town then has one environment, "demo", without tenants.
    /// </summary>
    public IReadOnlyList<RegistryEnvironment> Environments { get; init; } = [];

    /// <summary>The environment this registry is the view of (see <see cref="ForEnvironment"/>), or null for the whole town.</summary>
    public RegistryEnvironment? ActiveEnvironment { get; init; }

    /// <summary>The environment shown when none is asked for: the one marked default, else the first, else "demo".</summary>
    public string DefaultEnvironmentId => (Environments.FirstOrDefault(e => e.IsDefault) ?? Environments.FirstOrDefault())?.Id ?? DemoEnvironmentId;

    /// <summary>The environment of a town that has no environments folder.</summary>
    public const string DemoEnvironmentId = "demo";

    /// <summary>Problems a resilient load worked around (a skipped pillar file, a dropped call link). Always empty after a strict load.</summary>
    public IReadOnlyList<string> Notices { get; init; } = [];

    /// <summary>Every individual problem a resilient load worked around, in full (Notices keeps one line per skipped file). Empty exactly when a strict load would succeed.</summary>
    public IReadOnlyList<string> Problems { get; init; } = [];
}

/// <summary>A Service Bus topic. Name is {pillar}-{service}-outbox for a pillar and hub-{name} for the hub; Service is the service (or hub name) that publishes it.</summary>
public sealed record RegistryTopic(string Name, string GroupId, string Service);

/// <summary>A worker reading a topic. PublisherGroupId is the island that owns the topic. Legacy marks a read of the hub's egress topic by a pillar.</summary>
public sealed record RegistrySubscription(string Topic, string PublisherGroupId, string ConsumerId, string ConsumerGroupId, bool Legacy);

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
    /// <summary>The service names this island publishes outboxes for, as written in its file. The loader turns them into topics.</summary>
    internal IReadOnlyList<string> TopicServices { get; init; } = [];

    /// <summary>The subscriptions as written in its file, before they are checked against the rest of the town.</summary>
    internal IReadOnlyList<(string Topic, string Consumer, bool Legacy)> SubscriptionDecls { get; init; } = [];

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
    /// <summary>For a data store with one database per tenant: its name with {tenant} where the tenant id goes. Null for everything else.</summary>
    public string? TenantPattern { get; init; }

    /// <summary>Systems on other islands this one reaches through the API gateway. Only the dependency overlay and the cars' origins use them.</summary>
    public IReadOnlyList<string> GatewayCalls { get; init; } = [];

    /// <summary>The registry file the system is declared in (cl.yaml, hub.yaml, third-parties.yaml).</summary>
    public string SourceFile { get; init; } = "";

    /// <summary>For each setting (slaP99Ms, errors.amber, ...) which layer its value came from. Empty for a node made in code.</summary>
    public IReadOnlyDictionary<string, SettingOrigin> Origins { get; init; } = new Dictionary<string, SettingOrigin>();
}

/// <summary>The layer of the defaults cascade a setting's value was taken from, and the file that layer is in (null for the built-in defaults).</summary>
public sealed record SettingOrigin(SettingLayer Layer, string? File);

/// <summary>Raised when a registry file is wrong. The message names the file and the id.</summary>
public sealed class RegistryException(string message) : Exception(message);

/// <summary>A customer or a test tenant of an environment.</summary>
public sealed record RegistryTenant(string Id, string Name, TenantKind Kind);

/// <summary>Where one signal of an environment comes from.</summary>
public sealed record RegistrySource(string Name, string Kind, string? Connection);

/// <summary>
/// One environment: dev, staging, prod. Pillars and systems are shared; the environment brings its own sources and tenants and leaves out
/// the systems that are not deployed there. UndeclaredTenants are for the fake source only.
/// </summary>
public sealed record RegistryEnvironment(
    string Id,
    string Name,
    bool IsDefault,
    IReadOnlyList<RegistrySource> Sources,
    IReadOnlyList<RegistryTenant> Tenants,
    IReadOnlySet<string> Excluded,
    IReadOnlyList<string> UndeclaredTenants)
{
    /// <summary>The database a tenant has in a store with this pattern.</summary>
    public static string DatabaseName(string pattern, string tenantId) => pattern.Replace(TenantToken, tenantId);

    public const string TenantToken = "{tenant}";
}
