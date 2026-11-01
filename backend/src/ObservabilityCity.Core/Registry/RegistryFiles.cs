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
    /// <summary>How many cars appear, as a multiple of the usual number. 1 is the usual look.</summary>
    public double TrafficDensity { get; set; } = 1;
    /// <summary>Warnings the validator should expect in this registry (a test registry that shows a rule on purpose). Read by the validator only.</summary>
    public List<ExpectedWarningFile> ExpectedWarnings { get; set; } = [];
}

internal sealed class ExpectedWarningFile
{
    public string Rule { get; set; } = "";
    public string? File { get; set; }
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
    /// <summary>Whether link discovery looks for the calls systems of this role make (an api or a worker). Default yes.</summary>
    public bool? DiscoverLinks { get; set; }
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
    /// <summary>Whether link discovery looks for the calls this system makes. Without it, the pillar's or the defaults' choice.</summary>
    public bool? DiscoverLinks { get; set; }
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
    /// <summary>Host names (and everything under them) that belong to this vendor, so a call to one is recognised as a vendor call by link discovery.</summary>
    public List<string> Domains { get; set; } = [];
    /// <summary>The vendor is a group of services behind one island (several buildings), each recognised by the address its calls go to. Without services the vendor is one building.</summary>
    public List<VendorServiceFile> Services { get; set; } = [];
    /// <summary>Marks a vendor that is the company's own: services that are not part of the monitored platform. Shown with an "internal" label.</summary>
    public bool Internal { get; set; }
}

/// <summary>One building on a vendor's island, and the addresses that mean a call to it.</summary>
internal sealed class VendorServiceFile
{
    /// <summary>Short id; the building's id is the vendor id, a dash and this.</summary>
    public string Id { get; set; } = "";
    public string? Name { get; set; }
    /// <summary>Which calls go to this service: a host (and everything under it) with an optional path pattern. A call matching any entry is a call to it; the first service that matches wins.</summary>
    public List<VendorMatchFile> Match { get; set; } = [];
    /// <summary>Our systems that call this service, besides the ones link discovery finds.</summary>
    public List<string> CalledBy { get; set; } = [];
    /// <summary>Overrides the vendor's own value.</summary>
    public double? SlaP99Ms { get; set; }
    public ErrorThresholdsFile? Errors { get; set; }
}

internal sealed class VendorMatchFile
{
    /// <summary>A host name; the host itself and everything under it match.</summary>
    public string Host { get; set; } = "";
    /// <summary>A regular expression the call's path must match. Without it every path on the host matches.</summary>
    public string? Path { get; set; }
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
    /// <summary>How the calls the systems make are found in the telemetry. Without it the environment has only the declared links.</summary>
    public LinksFile? Links { get; set; }
    /// <summary>Where the Logs tab of a system reads from: a query run only when the tab is opened. Without it the tab says logs are not set up.</summary>
    public LogsFile? Logs { get; set; }
}

/// <summary>The <c>logs:</c> block of an environment file.</summary>
internal sealed class LogsFile
{
    /// <summary>The name of a loganalytics source of this file. Its connection and login are used.</summary>
    public string Source { get; set; } = "";
    /// <summary>The query to send, a template ({roles}, {from}, {to}, {window}, {windowSeconds}, {slaMs}, {kind}, scope variables, {environment}). One row for each kind of entry: section, at, text; count, level, operationId, durationMs and result optional.</summary>
    public string Query { get; set; } = "";
    /// <summary>How far back it looks. Default 4h.</summary>
    public string? Window { get; set; }
    /// <summary>Links in the header of a section that open the telemetry store's own search, already filtered to the system, 0 to n.</summary>
    public List<LogLinkFile> Links { get; set; } = [];
}

/// <summary>One entry of <c>logs.links</c>.</summary>
internal sealed class LogLinkFile
{
    /// <summary>The words on the link. When the rule finds more than one resource, the resource's name is added to it.</summary>
    public string Name { get; set; } = "";
    /// <summary>The section whose header carries it: failed, slow, logs or exceptions.</summary>
    public string Section { get; set; } = "";
    /// <summary>The name of a scope.assets rule. Each resource it finds gets its own link.</summary>
    public string Resources { get; set; } = "";
    /// <summary>A template that starts with https:// (or http://) written out. Variables {resourceId}, {resourceIdTwice}, {resourceName}, {role}, {from}, {to}, {windowMs}, scope variables and {environment}.</summary>
    public string Url { get; set; } = "";
}

/// <summary>The <c>links:</c> block of an environment file.</summary>
internal sealed class LinksFile
{
    /// <summary>The name of a loganalytics source of this file. Its connection and login are used.</summary>
    public string Source { get; set; } = "";
    /// <summary>The query to send, a template ({roles}, {from}, {to}, scope variables, {environment}). One row for each caller and address: caller, host, days; path and calls optional.</summary>
    public string Query { get; set; } = "";
    /// <summary>How often it reads, for example 1h. Default 1h.</summary>
    public string? Interval { get; set; }
    /// <summary>How far back the first read looks, and the longest gap a later read covers. Default 7d.</summary>
    public string? FirstRead { get; set; }
    /// <summary>The fewest different days a call must be seen on to be drawn. Default 2.</summary>
    public int? MinDays { get; set; }
    /// <summary>How long a link stays after it was last seen. Default 30d.</summary>
    public string? KeepFor { get; set; }
    /// <summary>Regular expressions for addresses that are platform noise, not calls between systems.</summary>
    public List<string> IgnoreHosts { get; set; } = [];
    /// <summary>The ways an address becomes a system, tried in order.</summary>
    public List<LinkRuleFile> Rules { get; set; } = [];
    /// <summary>Words the address uses that the registry spells differently, applied to every captured group.</summary>
    public Dictionary<string, string> Aliases { get; set; } = new();
    /// <summary>How much each caller sends, so the traffic nobody in the town explains can be told from the rest. Without it that split is not measured.</summary>
    public TrafficFile? Traffic { get; set; }
}

/// <summary>The <c>links.traffic</c> block of an environment file.</summary>
internal sealed class TrafficFile
{
    /// <summary>The query, a template like links.query. One row for each caller and address over the window: caller, host, calls; path for a gateway.</summary>
    public string Query { get; set; } = "";
    /// <summary>How far back each read looks, which smooths the shares. Default 1h.</summary>
    public string? ShareWindow { get; set; }
    /// <summary>Below this many observed calls to an API the share is too noisy: the last good one stands, marked estimated. Default 20.</summary>
    public int? MinCalls { get; set; }
    /// <summary>How often it reads. Default 5m.</summary>
    public string? Interval { get; set; }
}

internal sealed class LinkRuleFile
{
    /// <summary>A regular expression over the host, with named groups.</summary>
    public string Host { get; set; } = "";
    /// <summary>A regular expression over the path, with named groups, for a gateway that names the destination in the path.</summary>
    public string? Path { get; set; }
    /// <summary>The system id, with {group} holes for the named groups and {callerPillar}.</summary>
    public string Target { get; set; } = "";
    /// <summary>The call goes through the API gateway.</summary>
    public bool Gateway { get; set; }
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
    /// <summary>Resources that are not systems but stand as basic buildings without health (a key vault, a storage account).</summary>
    public List<AssetRuleFile> Assets { get; set; } = [];
    /// <summary>What the cloud is called in the town's words, for a missing app ("not found in Azure").</summary>
    public string? Cloud { get; set; }
    public string? TelemetryRole { get; set; }
    public ScopeQueriesFile? Queries { get; set; }
    /// <summary>Addresses that open a resource in a portal or console. A template over the resource's words; without any, no link is shown.</summary>
    public List<ResourceLinkFile> Links { get; set; } = [];
    /// <summary>How a service's region is read and labelled, and where the per-region view is off.</summary>
    public RegionsFile? Regions { get; set; }
}

internal sealed class AssetRuleFile
{
    public string Name { get; set; } = "";
    public string Label { get; set; } = "";
    public string Shape { get; set; } = "box";
    public List<string> Types { get; set; } = [];
    public string Pattern { get; set; } = "";
    /// <summary>"hub": the building stands on the hub island instead of a pillar's island. Leave out for a pillar's own resource.</summary>
    public string? Island { get; set; }
    /// <summary>For a hub building: the cluster it stands in, named on a sign (for example Monitoring).</summary>
    public string? Group { get; set; }
    /// <summary>For a hub building: which subscriptions to look in. Without it, the pillars' subscriptions.</summary>
    public SubscriptionRuleFile? Subscription { get; set; }
}

internal sealed class RegionsFile
{
    public string? Tag { get; set; }
    public Dictionary<string, string> Names { get; set; } = new();
    /// <summary>The share of a service's requests one region may take, while another region runs instances, before the town flags it. Default 0.9.</summary>
    public double? Skew { get; set; }
}

internal sealed class ResourceLinkFile
{
    public string Name { get; set; } = "";
    public string Url { get; set; } = "";
    public List<string> Types { get; set; } = [];
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
    /// <summary>A query expression that reads, for one resource of this rule, its app state as text (for example a web app's state). Resources of a rule without it carry no state.</summary>
    public string? State { get; set; }
    /// <summary>The values of state that mean the app runs. Required with state; any other value means stopped.</summary>
    public List<string> Running { get; set; } = [];
    /// <summary>Which subscriptions this rule looks in, instead of the system's pillar's: by name pattern or tag (templates over your variables and {environment}). For a resource that lives apart from its pillar, such as a hub system's.</summary>
    public SubscriptionRuleFile? Subscription { get; set; }
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
    /// <summary>Request sources only (loganalytics): the query that says how a service's requests divide between regions, a template like query. Returns one row per telemetry name and region with the columns role, region and calls (sampling-corrected counts do: only the proportions are used).</summary>
    public string? RegionQuery { get; set; }
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
    /// <summary>The time grain the metrics are asked at, for example 5m. Some metrics do not support a minute. Default: one minute.</summary>
    public string? Interval { get; set; }
    /// <summary>How far back this entry looks, for example 1h: the worst or total of that long. Without it the source's <c>window</c> applies. It must hold at least two points of the entry's interval.</summary>
    public string? Window { get; set; }
    public MetricSignalFile? Cpu { get; set; }
    public MetricSignalFile? Memory { get; set; }
    public MetricSignalFile? Utilisation { get; set; }
    public MetricSignalFile? Throttled { get; set; }
    /// <summary>The request rate of a store, shown per tenant database.</summary>
    public MetricSignalFile? Requests { get; set; }
    /// <summary>The provisioned capacity as a plain number (for Cosmos, the ProvisionedThroughput metric with maximum), shown beside each tenant database. Not a health signal.</summary>
    public MetricSignalFile? Limit { get; set; }
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
    /// <summary>Another metric to read in place of this one when it gives no number or 0 (for example the autoscale ceiling, then the fixed throughput of an account that has none). It cannot have an <c>over</c> or an <c>orElse</c> of its own.</summary>
    public MetricSignalFile? OrElse { get; set; }
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
