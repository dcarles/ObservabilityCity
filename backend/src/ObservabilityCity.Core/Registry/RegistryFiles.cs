using ObservabilityCity.Core.Sources;
using YamlDotNet.Core;
using YamlDotNet.Core.Events;
using YamlDotNet.Serialization;

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
    /// <summary>Pillar codes in the order the islands stand round the hub. Pillars not listed follow in file order.</summary>
    public List<string> Islands { get; set; } = [];
    /// <summary>Islands on the first ring. The second ring holds up to one fewer, since the airport takes a place there.</summary>
    public int? RingCapacity { get; set; }
    /// <summary>Warnings the validator should expect in this registry (a test registry that shows a rule on purpose). Read by the validator only.</summary>
    public List<ExpectedWarningFile> ExpectedWarnings { get; set; } = [];
    /// <summary>The database engines this company uses, by id. A database says <c>engine: &lt;id&gt;</c> and takes the name and the type from here.</summary>
    public Dictionary<string, DatabaseEngineFile> DatabaseEngines { get; set; } = new();
    /// <summary>How the town names its message topics. Without it: topics are named after the service.</summary>
    public TownMessagingFile Messaging { get; set; } = new();
    /// <summary>The words the town uses for things the app has no fixed name for.</summary>
    public LabelsFile Labels { get; set; } = new();
    /// <summary>The town's defaults for wall mode. Each is optional: an address parameter wins, and without either the app's own default applies.</summary>
    public WallFile Wall { get; set; } = new();
}

internal sealed class WallFile
{
    /// <summary>Seconds the tour stays at each stop.</summary>
    public double? HoldSeconds { get; set; }
    /// <summary>Seconds the overview of the whole town lasts; 0 for no overview.</summary>
    public double? OverviewSeconds { get; set; }
    /// <summary>Seconds the overview stays at each pillar island, seen from its front; 0 for the whole town only.</summary>
    public double? OverviewIslandSeconds { get; set; }
    /// <summary>"dusk" or "day".</summary>
    public string? Light { get; set; }
}

internal sealed class TownMessagingFile
{
    /// <summary>The name of the topic a pillar's service publishes, for a topic listed by its service: <c>{pillar}</c> and <c>{service}</c> are replaced. Not used by a topic listed by its own name.</summary>
    public string TopicTemplate { get; set; } = MessagingConvention.Default.TopicTemplate;
    /// <summary>The name of a topic of the hub listed by a short name: <c>{service}</c> is replaced by that name. Not used by a topic listed by its own name.</summary>
    public string HubTopicTemplate { get; set; } = MessagingConvention.Default.HubTopicTemplate;
}

internal sealed class LabelsFile
{
    /// <summary>What the town's own services outside the monitored platform are called (a section of the dashboard, a note in the panels).</summary>
    public string InternalVendors { get; set; } = TownLabels.DefaultInternalVendors;
}

internal sealed class DatabaseEngineFile
{
    /// <summary>The name shown, for example Cosmos DB.</summary>
    public string Name { get; set; } = "";
    /// <summary>One of the fixed database types (see <see cref="DatabaseTypes"/>).</summary>
    public string Type { get; set; } = "";
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
    /// <summary>When the number of messages waiting for a consumer turns amber and red, for a broker that reports counts and not ages. Off unless set.</summary>
    public ErrorThresholdsFile? BacklogCount { get; set; }
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
    /// <summary>For a database: which engine it runs on, an id from town.yaml databaseEngines.</summary>
    public string? Engine { get; set; }
    public bool? External { get; set; }
    public double? SlaP99Ms { get; set; }
    public ErrorThresholdsFile? Errors { get; set; }
    public ErrorThresholdsFile? Resources { get; set; }
    public ErrorThresholdsFile? Throttle { get; set; }
    public ErrorThresholdsFile? Backlog { get; set; }
    public ErrorThresholdsFile? BacklogCount { get; set; }
    public int? MinCalls { get; set; }
    /// <summary>Whether link discovery looks for the calls this system makes. Without it, the pillar's or the defaults' choice.</summary>
    public bool? DiscoverLinks { get; set; }
    /// <summary>Signal to source name (or none), overriding the pillar's and the environment's choice for this system.</summary>
    public Dictionary<string, string> Signals { get; set; } = new();
    /// <summary>The name this system's resources carry for its service, matched against the service group of the environment's resource patterns. Without it, the service name.</summary>
    public string? ServiceCode { get; set; }
    /// <summary>The environments (ids of the files in environments/) this system is deployed in. Without it, every environment.</summary>
    public List<string> Environments { get; set; } = [];
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
    /// <summary>Which services each scheduled job of a function in this pillar starts work for. A job that is not listed sends no boats.</summary>
    public List<SchedulerFile> Scheduler { get; set; } = [];
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

/// <summary>The "messaging" block of a pillar file (or hub.yaml): the topics it publishes and the topics its workers consume.</summary>
internal sealed class MessagingFile
{
    /// <summary>
    /// The topics it publishes. Each entry is a service name, whose topic messaging.topicTemplate names (in hub.yaml: a name for messaging.hubTopicTemplate),
    /// or a topic by its own name, with the service that publishes it if one does: <c>{ topic: orders.created, service: orders }</c>.
    /// </summary>
    public List<TopicFile> Topics { get; set; } = [];
    public List<SubscriptionFile> Subscriptions { get; set; } = [];
}

/// <summary>
/// One entry of a <c>topics:</c> list. A plain name is a service (the short form), whose topic the town's template names; a block names the topic itself
/// and, optionally, the service that publishes it. A topic with no service belongs to its island as a whole.
/// </summary>
internal sealed class TopicFile : IYamlConvertible
{
    /// <summary>The topic's full name, as the broker knows it. Without it the entry is the short form, and the template names the topic.</summary>
    public string? Topic { get; set; }
    /// <summary>The service of this island that publishes the topic. Optional with <c>topic</c>.</summary>
    public string? Service { get; set; }

    /// <summary>The entry was a plain name: a service, named by the template.</summary>
    internal bool ByService { get; private set; }

    /// <summary>The line of the entry in its file, 1-based.</summary>
    internal int Line { get; private set; }

    private sealed class Named
    {
        public string? Topic { get; set; }
        public string? Service { get; set; }
    }

    void IYamlConvertible.Read(IParser parser, Type expectedType, ObjectDeserializer nestedObjectDeserializer)
    {
        Line = (int)parser.Current!.Start.Line;
        if (parser.TryConsume<Scalar>(out var scalar))
        {
            Service = scalar.Value;
            ByService = true;
            return;
        }
        var named = (Named?)nestedObjectDeserializer(typeof(Named)) ?? new Named();
        Topic = named.Topic ?? "";
        Service = named.Service;
    }

    void IYamlConvertible.Write(IEmitter emitter, ObjectSerializer nestedObjectSerializer) => throw new NotSupportedException("registry files are only read");
}

/// <summary>One entry of a pillar's <c>scheduler:</c> list: a function and, for each of its jobs, the services the job starts work for.</summary>
internal sealed class SchedulerFile
{
    /// <summary>The function system, by its id within the pillar.</summary>
    public string System { get; set; } = "";
    /// <summary>Job name (as the logs name it) to the services of this pillar it starts work for.</summary>
    public Dictionary<string, List<string>> Jobs { get; set; } = [];
}

internal sealed class SubscriptionFile : IYamlConvertible
{
    /// <summary>The full topic name, for example orders-events.</summary>
    public string Topic { get; set; } = "";
    /// <summary>A worker in this pillar.</summary>
    public string Consumer { get; set; } = "";

    /// <summary>The line of the entry in its file, 1-based, so a problem with it can point there.</summary>
    internal int Line { get; private set; }

    private sealed class Plain
    {
        public string Topic { get; set; } = "";
        public string Consumer { get; set; } = "";
    }

    void IYamlConvertible.Read(IParser parser, Type expectedType, ObjectDeserializer nestedObjectDeserializer)
    {
        Line = (int)parser.Current!.Start.Line;
        var plain = (Plain?)nestedObjectDeserializer(typeof(Plain)) ?? new Plain();
        (Topic, Consumer) = (plain.Topic, plain.Consumer);
    }

    void IYamlConvertible.Write(IEmitter emitter, ObjectSerializer nestedObjectSerializer) => throw new NotSupportedException("registry files are only read");
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
    /// <summary>The telemetry names this service's own calls are recorded under (its telemetry role, for example AppRoleName in Azure). Link discovery reads their calls like those of a town system, so a service that calls town systems through the gateway is drawn calling them.</summary>
    public List<string> Roles { get; set; } = [];
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
    /// <summary>How sources sign in, by name. A source names one with credential; without it, the adapter's usual login is used.</summary>
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
    /// <summary>The name of a source of this file whose kind can read logs (on Azure, loganalytics). Its connection and login are used.</summary>
    public string Source { get; set; } = "";
    /// <summary>The query to send, a template ({roles}, {from}, {to}, {window}, {windowSeconds}, {slaMs}, {kind}, scope variables, {environment}). One row for each kind of entry: section, at, text; count, level, durationMs and result optional.</summary>
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
    /// <summary>The name of a source of this file whose kind can read dependencies (on Azure, loganalytics). Its connection and login are used.</summary>
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

/// <summary>
/// A block some of whose keys may also be written by an older name: the scope's keys once spoke in one cloud's words (an Azure subscription, a Log Analytics
/// workspace), and a file written that way still reads the same. Each property is read under its own (neutral) name or an alias of it; both on one block are
/// a mistake, since one of them would be ignored. Any other key is unknown, as in every other block.
/// </summary>
internal abstract class AliasedBlock : IYamlConvertible
{
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<Type, Dictionary<string, System.Reflection.PropertyInfo>> Keys = new();

    /// <summary>Alias to the key it stands for, for example subscription to account.</summary>
    internal abstract IReadOnlyDictionary<string, string> Aliases { get; }

    /// <summary>What the block is called in a message, for example scope.</summary>
    protected abstract string Block { get; }

    void IYamlConvertible.Read(IParser parser, Type expectedType, ObjectDeserializer nestedObjectDeserializer)
    {
        var properties = Keys.GetOrAdd(GetType(), t => t.GetProperties().Where(p => p.CanWrite && p.SetMethod!.IsPublic)
            .ToDictionary(p => char.ToLowerInvariant(p.Name[0]) + p.Name[1..], StringComparer.Ordinal));
        parser.Consume<MappingStart>();
        var written = new Dictionary<string, string>(StringComparer.Ordinal); // the key a value is for, to the spelling it was written in
        while (!parser.TryConsume<MappingEnd>(out _))
        {
            var key = parser.Consume<Scalar>();
            var name = Aliases.GetValueOrDefault(key.Value, key.Value);
            // the reader's own words for an unknown key, so the loader reports it as it reports any other
            if (!properties.TryGetValue(name, out var property))
                throw new YamlException(key.Start, key.End, $"Property '{key.Value}' not found on type '{GetType().FullName}'.");
            if (written.TryGetValue(name, out var first) && first != key.Value)
            {
                var (current, alias) = first == name ? (first, key.Value) : (key.Value, first);
                throw new YamlException(key.Start, key.End, $"{Block} sets both '{current}' and '{alias}', which are one setting ('{alias}' is the older name of '{current}'). Keep one of them");
            }
            written[name] = key.Value;
            property.SetValue(this, nestedObjectDeserializer(property.PropertyType));
        }
    }

    void IYamlConvertible.Write(IEmitter emitter, ObjectSerializer nestedObjectSerializer) => throw new NotSupportedException("registry files are only read");
}

/// <summary>An environment's <c>scope:</c> block. The account and telemetry store keys also read under their Azure names (see <see cref="Aliases"/>).</summary>
internal sealed class ScopeFile : AliasedBlock
{
    /// <summary>The older (Azure) name of each key that has one.</summary>
    internal static readonly IReadOnlyDictionary<string, string> Names = new Dictionary<string, string>
    {
        ["subscription"] = "account",
        ["pillars"] = "pillarAccounts",
        ["workspace"] = "telemetryStore",
        ["workspaceId"] = "telemetryStoreId",
    };

    internal override IReadOnlyDictionary<string, string> Aliases => Names;
    protected override string Block => "scope";

    public string? Inventory { get; set; }
    /// <summary>The telemetry store by name or wildcard pattern (a template). A name is looked up in the inventory; an id or resource id is used as it is. Alias: workspace.</summary>
    public string? TelemetryStore { get; set; }
    /// <summary>The telemetry store's id (a GUID or a resource id), a template. When it is set the name is not looked up. Alias: workspaceId.</summary>
    public string? TelemetryStoreId { get; set; }
    public Dictionary<string, string> Variables { get; set; } = new();
    /// <summary>How a pillar finds its account. Alias: subscription.</summary>
    public AccountRuleFile? Account { get; set; }
    /// <summary>Pillar id to account id, for the pillars named instead of found. Alias: pillars.</summary>
    public Dictionary<string, string> PillarAccounts { get; set; } = new();
    public List<ResourceRuleFile> Resources { get; set; } = [];
    /// <summary>Resources that are not systems but stand as basic buildings without health (a key vault, a storage account).</summary>
    public List<AssetRuleFile> Assets { get; set; } = [];
    /// <summary>What the cloud is called in the town's words, for a missing app ("not found in" and this name).</summary>
    public string? Cloud { get; set; }
    public string? TelemetryRole { get; set; }
    public ScopeQueriesFile? Queries { get; set; }
    /// <summary>Addresses that open a resource in a portal or console. A template over the resource's words; without any, no link is shown.</summary>
    public List<ResourceLinkFile> Links { get; set; } = [];
    /// <summary>How a service's region is read and labelled, and where the per-region view is off.</summary>
    public RegionsFile? Regions { get; set; }
}

internal sealed class AssetRuleFile : AliasedBlock
{
    internal override IReadOnlyDictionary<string, string> Aliases => RuleAliases.Names;
    protected override string Block => Name.Length > 0 ? $"scope.assets '{Name}'" : "a scope.assets rule";

    public string Name { get; set; } = "";
    public string Label { get; set; } = "";
    public string Shape { get; set; } = "box";
    public List<string> Types { get; set; } = [];
    public string Pattern { get; set; } = "";
    /// <summary>"hub": the building stands on the hub island instead of a pillar's island. Leave out for a pillar's own resource.</summary>
    public string? Island { get; set; }
    /// <summary>For a hub building: the cluster it stands in, named on a sign (for example Monitoring).</summary>
    public string? Group { get; set; }
    /// <summary>For a hub building: which accounts to look in. Without it, the pillars' accounts. Alias: subscription.</summary>
    public AccountRuleFile? Account { get; set; }
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

/// <summary>The older (Azure) name of a resource or asset rule's account key.</summary>
internal static class RuleAliases
{
    internal static readonly IReadOnlyDictionary<string, string> Names = new Dictionary<string, string> { ["subscription"] = "account" };
}

/// <summary>Finds accounts (an Azure subscription, an AWS account, a GCP project) by name pattern or by tag.</summary>
internal sealed class AccountRuleFile
{
    public string? NameLike { get; set; }
    public TagRuleFile? Tag { get; set; }
}

internal sealed class TagRuleFile
{
    public string Key { get; set; } = "";
    public string? Value { get; set; }
}

internal sealed class ResourceRuleFile : AliasedBlock
{
    internal override IReadOnlyDictionary<string, string> Aliases => RuleAliases.Names;
    protected override string Block => Name.Length > 0 ? $"scope.resources '{Name}'" : "a scope.resources rule";

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
    /// <summary>Which accounts this rule looks in, instead of the system's pillar's: by name pattern or tag (templates over your variables and {environment}). For a resource that lives apart from its pillar, such as a hub system's. Alias: subscription.</summary>
    public AccountRuleFile? Account { get; set; }
}

internal sealed class ScopeQueriesFile : AliasedBlock
{
    private static readonly IReadOnlyDictionary<string, string> Names = new Dictionary<string, string> { ["subscriptions"] = "accounts", ["workspaces"] = "telemetryStores" };
    internal override IReadOnlyDictionary<string, string> Aliases => Names;
    protected override string Block => "scope.queries";

    /// <summary>Alias: subscriptions.</summary>
    public string? Accounts { get; set; }
    public string? Resources { get; set; }
    /// <summary>Alias: workspaces.</summary>
    public string? TelemetryStores { get; set; }
}

internal sealed class SourceFile : IYamlConvertible
{
    /// <summary>The kind of source. Which kinds exist depends on the adapter modules loaded; fake, prometheus and grafana-irm are the core's.</summary>
    public string Kind { get; set; } = "";
    /// <summary>How to reach it (a workspace, an endpoint). Not used by the fake source.</summary>
    public string? Connection { get; set; }
    /// <summary>The login to use, by name from credentials. Sources that sign in only; without it, the adapter's usual login.</summary>
    public string? Credential { get; set; }
    /// <summary>How often the source is asked, in seconds.</summary>
    public double? PollSeconds { get; set; }
    /// <summary>How long one ask may take before it is given up, in seconds.</summary>
    public double? TimeoutSeconds { get; set; }
    /// <summary>Job sources only: how long after its schedule says it should run a job may stay without a newer run before it counts as late, in seconds.</summary>
    public double? LateAfterSeconds { get; set; }
    /// <summary>Sources that send a query: the query to send, a template. {window} and {windowSeconds} stand for the window, {roles} for the telemetry names of the systems it is asked about, quoted and separated by commas; scope variables and {environment} work too.</summary>
    public string? Query { get; set; }
    /// <summary>How far back one answer looks, for example 5m. Default 5m.</summary>
    public string? Window { get; set; }

    /// <summary>Every other key of the block, which the module of the source's kind reads and checks. Not a key of its own: the properties above are the core's keys.</summary>
    internal SourceSettings Settings { get; private set; } = SourceSettings.None;

    private static readonly Dictionary<string, System.Reflection.PropertyInfo> CoreKeys = typeof(SourceFile).GetProperties()
        .ToDictionary(p => char.ToLowerInvariant(p.Name[0]) + p.Name[1..], StringComparer.Ordinal);

    /// <summary>The core's keys, in the order they are documented.</summary>
    internal static IReadOnlyCollection<string> KeyNames => CoreKeys.Keys;

    // The core reads its own keys as it reads any file and keeps the rest, with their lines, for the module of the source's kind.
    void IYamlConvertible.Read(IParser parser, Type expectedType, ObjectDeserializer nestedObjectDeserializer)
    {
        var start = parser.Consume<MappingStart>();
        var rest = new List<(SettingsNode, SettingsNode)>();
        MappingEnd end;
        while (!parser.TryConsume(out end!))
        {
            if (parser.Current is Scalar key && CoreKeys.TryGetValue(key.Value, out var property))
            {
                parser.MoveNext();
                property.SetValue(this, nestedObjectDeserializer(property.PropertyType));
            }
            else rest.Add((SettingsNode.Read(parser), SettingsNode.Read(parser)));
        }
        Settings = new SourceSettings(rest, start.Start, end.End); // with no keys of its own it still knows its line, for a key the kind needs and lacks
    }

    void IYamlConvertible.Write(IEmitter emitter, ObjectSerializer nestedObjectSerializer) => throw new NotSupportedException("registry files are only read");
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
