namespace ObservabilityCity.Core.Registry;

// Shapes of the YAML files, as read from disk. RegistryLoader turns them into the Registry model.

internal sealed class TownFile
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string GroupLabel { get; set; } = "Group";
    public string Topology { get; set; } = "direct";
    /// <summary>"demo" (a town with a fake source and the Break things panel) or "live". A town that does not say is live.</summary>
    public string Mode { get; set; } = "live";
}

internal sealed class ErrorThresholdsFile
{
    public double? Amber { get; set; }
    public double? Red { get; set; }
}

internal sealed class RoleDefaultsFile
{
    public double? SlaP99Ms { get; set; }
    public ErrorThresholdsFile? Errors { get; set; }
    /// <summary>When CPU, memory or a data store's utilisation turns amber and red (0 to 1).</summary>
    public ErrorThresholdsFile? Resources { get; set; }
    /// <summary>The same for the share of throttled requests.</summary>
    public ErrorThresholdsFile? Throttle { get; set; }
    /// <summary>When the oldest waiting message of a consumer turns amber and red, in seconds.</summary>
    public ErrorThresholdsFile? Backlog { get; set; }
    /// <summary>The fewest calls in a source's window that make the error share and latency worth judging. With fewer, the system is quiet.</summary>
    public int? MinCalls { get; set; }
}

/// <summary>defaults.yaml and the "defaults" block of a pillar file: role name to defaults.</summary>
internal sealed class DefaultsFile : Dictionary<string, RoleDefaultsFile>;

internal sealed class SystemFile
{
    public string Id { get; set; } = "";
    public string? Name { get; set; }
    public string? Role { get; set; }
    /// <summary>Systems that share a service name are drawn together as one block.</summary>
    public string? Service { get; set; }
    /// <summary>For a data store that keeps one database per tenant: the database name with {tenant} where the tenant id goes, for example merchant-{tenant}-db.</summary>
    public string? TenantPattern { get; set; }
    public bool? External { get; set; }
    public double? SlaP99Ms { get; set; }
    public ErrorThresholdsFile? Errors { get; set; }
    public ErrorThresholdsFile? Resources { get; set; }
    public ErrorThresholdsFile? Throttle { get; set; }
    public ErrorThresholdsFile? Backlog { get; set; }
    public int? MinCalls { get; set; }
    /// <summary>Signal to source name (or none), overriding the pillar's and the environment's choice for this system.</summary>
    public Dictionary<string, string> Signals { get; set; } = new();
    /// <summary>The name this system's resources carry for its service, matched against the service group of the environment's resource patterns. Without it, the service name.</summary>
    public string? ServiceCode { get; set; }
    /// <summary>What the telemetry says about this system.</summary>
    public TelemetryFile? Telemetry { get; set; }
    /// <summary>Ids of the systems this one calls directly. Cars drive only along declared links.</summary>
    public List<string> Calls { get; set; } = [];
    /// <summary>Ids of systems on other islands this one reaches through the API gateway (the way calls between islands go in a hub-and-spoke town).</summary>
    public List<string> GatewayCalls { get; set; } = [];
    /// <summary>Former ids of this system. Other files may still call it by one of them.</summary>
    public List<string> Aliases { get; set; } = [];
}

internal sealed class PillarFile
{
    public string Pillar { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Color { get; set; } = "#8ab4ff";
    public bool External { get; set; }
    public DefaultsFile Defaults { get; set; } = new();
    /// <summary>Signal to source name (or none) for every system of the pillar, overriding the environment's choice; a system can override it again.</summary>
    public Dictionary<string, string> Signals { get; set; } = new();
    public List<SystemFile> Systems { get; set; } = [];
    public MessagingFile? Messaging { get; set; }
    /// <summary>How the pillar is spelt in the environments' scope rules, when that is not its id.</summary>
    public PillarScopeFile? Scope { get; set; }
}

internal sealed class PillarScopeFile
{
    /// <summary>What {pillar} stands for in the scope rules. Without it, the pillar id.</summary>
    public string? Code { get; set; }
}

internal sealed class TelemetryFile
{
    /// <summary>The name the telemetry gives this system (its role name). Without it, the environment's scope.telemetryRole template, if any.</summary>
    public string? Role { get; set; }
}

/// <summary>The "messaging" block of a pillar file (or hub.yaml): the outboxes it publishes and the topics its workers consume.</summary>
internal sealed class MessagingFile
{
    /// <summary>Pillar files: service names, each published as the topic {pillar}-{service}-outbox. hub.yaml: free names, each published as hub-{name}.</summary>
    public List<string> Topics { get; set; } = [];
    public List<SubscriptionFile> Subscriptions { get; set; } = [];
}

internal sealed class SubscriptionFile
{
    /// <summary>The full topic name, for example frd-screening-outbox.</summary>
    public string Topic { get; set; } = "";
    /// <summary>A worker in this pillar.</summary>
    public string Consumer { get; set; } = "";
    /// <summary>Marks a read of the hub's egress topic by another pillar, the old way. Drawn with an amber pennant.</summary>
    public bool Legacy { get; set; }
}

internal sealed class HubFile
{
    public string DisplayName { get; set; } = "Hub";
    public string Color { get; set; } = "#f5c26b";
    public List<SystemFile> Resources { get; set; } = [];
    public List<ExternalCallerFile> ExternalCallers { get; set; } = [];
    public MessagingFile? Messaging { get; set; }
}

internal sealed class ExternalCallerFile
{
    public string Id { get; set; } = "";
    public string? Name { get; set; }
    public List<string> Calls { get; set; } = [];
}

/// <summary>layout.yaml: the order of the islands round the hub, and how many fit on a ring.</summary>
internal sealed class LayoutFile
{
    public List<string> Islands { get; set; } = [];
    /// <summary>Islands on the first ring. The second ring holds up to one fewer, since the airport takes a place there.</summary>
    public int? RingCapacity { get; set; }
}

/// <summary>third-parties.yaml: the vendors outside the town and which of our systems call each one.</summary>
internal sealed class ThirdPartiesFile
{
    public List<VendorFile> Vendors { get; set; } = [];
}

internal sealed class VendorFile
{
    public string Id { get; set; } = "";
    public string? Name { get; set; }
    /// <summary>Ids of our systems that call this vendor. Its health is read from those calls.</summary>
    public List<string> CalledBy { get; set; } = [];
    public double? SlaP99Ms { get; set; }
    public ErrorThresholdsFile? Errors { get; set; }
}

/// <summary>environments/{id}.yaml: one environment. The pillar and system files are shared by every environment; this file says what differs.</summary>
internal sealed class EnvironmentFile
{
    public string? Name { get; set; }
    /// <summary>Where it stands in the picker, lowest first. Ties go by id.</summary>
    public int? Order { get; set; }
    /// <summary>The environment shown when none is asked for. Without one, the first.</summary>
    public bool Default { get; set; }
    /// <summary>Where this environment's numbers come from, by source name. The names metrics, incidents and messaging are the defaults for those groups of signals; any other kebab-case name is a source a signal can be pointed at.</summary>
    public Dictionary<string, SourceFile> Sources { get; set; } = new();
    /// <summary>How sources sign in to Azure, by name. A source names one with credential; without it, the Azure CLI login is used.</summary>
    public Dictionary<string, CredentialFile> Credentials { get; set; } = new();
    /// <summary>Which source each signal comes from in this environment (a source name, or none). Signals not listed use the source named metrics or messaging.</summary>
    public Dictionary<string, string> Signals { get; set; } = new();
    public List<TenantFile> Tenants { get; set; } = [];
    /// <summary>Ids of systems that are not deployed in this environment. They are left out of its town.</summary>
    public List<string> Exclude { get; set; } = [];
    /// <summary>Settings for the fake source only.</summary>
    public EnvironmentFakeFile? Fake { get; set; }
    /// <summary>How pillars and systems map onto the cloud: subscriptions, workspace, resources and telemetry names.</summary>
    public ScopeFile? Scope { get; set; }
}

internal sealed class ScopeFile
{
    public string? Inventory { get; set; }
    /// <summary>The workspace by name or wildcard pattern (a template). A name is looked up in the inventory; an id or resource id is used as it is.</summary>
    public string? Workspace { get; set; }
    /// <summary>The workspace's id (a GUID or a resource id), a template. When it is set the name is not looked up.</summary>
    public string? WorkspaceId { get; set; }
    public Dictionary<string, string> Variables { get; set; } = new();
    public SubscriptionRuleFile? Subscription { get; set; }
    public Dictionary<string, string> Pillars { get; set; } = new();
    public List<ResourceRuleFile> Resources { get; set; } = [];
    public string? TelemetryRole { get; set; }
    public ScopeQueriesFile? Queries { get; set; }
}

internal sealed class SubscriptionRuleFile
{
    public string? NameLike { get; set; }
    public TagRuleFile? Tag { get; set; }
}

internal sealed class TagRuleFile
{
    public string Key { get; set; } = "";
    public string? Value { get; set; }
}

internal sealed class ResourceRuleFile
{
    public string Name { get; set; } = "";
    public List<string> Types { get; set; } = [];
    public string Pattern { get; set; } = "";
    public List<string> Roles { get; set; } = [];
    public string? ServiceTag { get; set; }
    public string? TenantNameTag { get; set; }
    /// <summary>A query expression that gives, for one resource of this rule, how many instances it runs. Resources of a rule without it carry no count.</summary>
    public string? Instances { get; set; }
}

internal sealed class ScopeQueriesFile
{
    public string? Subscriptions { get; set; }
    public string? Resources { get; set; }
    public string? Workspaces { get; set; }
}

internal sealed class SourceFile
{
    /// <summary>The kind of source: fake, resourcegraph, loganalytics, azuremonitor, servicebus, prometheus or grafana-irm.</summary>
    public string Kind { get; set; } = "";
    /// <summary>How to reach it (a workspace, an endpoint). Not used by the fake source.</summary>
    public string? Connection { get; set; }
    /// <summary>The login to use, by name from credentials. Azure sources only; without it, the Azure CLI login.</summary>
    public string? Credential { get; set; }
    /// <summary>How often the source is asked, in seconds.</summary>
    public double? PollSeconds { get; set; }
    /// <summary>How long one ask may take before it is given up, in seconds.</summary>
    public double? TimeoutSeconds { get; set; }
    /// <summary>Query sources only (loganalytics): the query to send, a template. {window} and {windowSeconds} stand for the window, {roles} for the telemetry names of the systems it is asked about, quoted and separated by commas; scope variables and {environment} work too.</summary>
    public string? Query { get; set; }
    /// <summary>Query sources only: how far back one answer looks, for example 5m. Default 5m.</summary>
    public string? Window { get; set; }
    /// <summary>Platform-metric sources only (azuremonitor): which metric of which resources fills which signal. Everything about the metrics is written here; the program knows none.</summary>
    public List<MetricGroupFile> Metrics { get; set; } = [];
}

/// <summary>The metrics of one kind of resource: <see cref="Resources"/> names a rule of scope.resources, and each signal says where its number comes from.</summary>
internal sealed class MetricGroupFile
{
    /// <summary>The name of a scope.resources rule: the resources it finds for a system are the ones asked.</summary>
    public string Resources { get; set; } = "";
    /// <summary>The metric namespace, for a resource type that has more than one. Usually left out.</summary>
    public string? Namespace { get; set; }
    public MetricSignalFile? Cpu { get; set; }
    public MetricSignalFile? Memory { get; set; }
    public MetricSignalFile? Utilisation { get; set; }
    public MetricSignalFile? Throttled { get; set; }
    /// <summary>The request rate of a store, shown per tenant database.</summary>
    public MetricSignalFile? Requests { get; set; }
}

internal sealed class MetricSignalFile
{
    /// <summary>The metric's name as the cloud spells it.</summary>
    public string Metric { get; set; } = "";
    /// <summary>average, total, count, maximum or minimum: how the points of the window are added up.</summary>
    public string Aggregation { get; set; } = "average";
    /// <summary>A dimension filter, for example <c>StatusCode eq '429'</c>.</summary>
    public string? Filter { get; set; }
    /// <summary>Multiplies the value. The town reads fractions (0.42 is 42%), so a percentage has scale 0.01.</summary>
    public double Scale { get; set; } = 1;
    /// <summary>Divide a total over the window by its seconds, to get a rate.</summary>
    public bool PerSecond { get; set; }
    /// <summary>Another metric the value is divided by (provisioned capacity, all requests), to give a share.</summary>
    public MetricSignalFile? Over { get; set; }
}

internal sealed class CredentialFile
{
    /// <summary>azure-cli, default, managed-identity or service-principal.</summary>
    public string Kind { get; set; } = "";
    /// <summary>The directory (tenant) to sign in to. Without it, the login's own.</summary>
    public string? TenantId { get; set; }
    /// <summary>The app registration's client id (service-principal), or the user-assigned identity's (managed-identity).</summary>
    public string? ClientId { get; set; }
    /// <summary>The name of the environment variable that holds a service principal's secret. The secret itself never goes in a registry file.</summary>
    public string? ClientSecretEnv { get; set; }
}

internal sealed class TenantFile
{
    public string Id { get; set; } = "";
    public string? Name { get; set; }
    /// <summary>customer or test.</summary>
    public string Kind { get; set; } = "customer";
}

internal sealed class EnvironmentFakeFile
{
    /// <summary>Tenants the fake source finds in the data that the tenant list does not name, so the town can show an unknown tenant.</summary>
    public List<string> UndeclaredTenants { get; set; } = [];
}
