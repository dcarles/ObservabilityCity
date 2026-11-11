using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Adapters.Azure;

// What the Azure adapter's sources run with, made from their settings in the environment file (see AzureSourceSettings).

/// <summary>
/// The settings of an Azure source: the keys of its block that are not the core's. Every Azure kind takes the same keys; each reads the ones it uses
/// (<see cref="RegionQuery"/> loganalytics, <see cref="TypesQuery"/> and <see cref="Entities"/> servicebus, <see cref="Metrics"/> azuremonitor,
/// <see cref="Providers"/> and <see cref="KeepResolvedFor"/> resourcehealth).
/// </summary>
public sealed record AzureSettings : IDeadLetterLinkSettings
{
    public static readonly AzureSettings None = new();

    /// <summary>For a request source: the query that gives how the requests divide between regions (columns role, region, calls). Null: the split is not measured.</summary>
    public string? RegionQuery { get; init; }

    /// <summary>For a broker source (servicebus): the query that gives how many messages each queue handled by message type (columns queue, type, calls). Null: the types are not measured.</summary>
    public string? TypesQuery { get; init; }

    /// <summary>For a platform-metric source: which metric of which resources fills which signal. Empty for every other kind of source.</summary>
    public IReadOnlyList<MetricGroup> Metrics { get; init; } = [];

    /// <summary>For a message-broker source: how its entities are read and whose they are. Null for every other kind of source.</summary>
    public EntitiesConfig? Entities { get; init; }

    /// <summary>For a resource-health source (resourcehealth): the resource providers whose health reports it reads, as the cloud names them. Empty for every other kind of source.</summary>
    public IReadOnlyList<string> Providers { get; init; } = [];

    /// <summary>For a resource-health source: how long a resolved report stays listed (green) after the resource recovered, a number and a unit like 4h. Null: 4h.</summary>
    public string? KeepResolvedFor { get; init; }

    EntityLink? IDeadLetterLinkSettings.DeadLetterLink => Entities?.DeadLetterLink;
    IReadOnlyList<EntityRegionLink>? IDeadLetterLinkSettings.DeadLetterLinks => Entities?.DeadLetterLinks;

    /// <summary>The settings of a source as the Azure adapter reads them.</summary>
    public static AzureSettings Of(RegistrySource source) => AzureSourceSettings.Reader.For(source);
}

/// <summary>How a broker's entities are read: the rule that finds its namespaces, the dimension that names an entity, the metrics for the backlog and the dead letters, and the patterns that say whose an entity is.</summary>
public sealed record EntitiesConfig(string Resources, string Dimension, EntityMetric? Backlog, EntityMetric? DeadLetter, IReadOnlyList<EntityPattern> Patterns, TimeSpan? Interval = null, EntityLink? DeadLetterLink = null, EntityMetric? Throughput = null, IReadOnlyList<EntityRegionLink>? DeadLetterLinks = null, IReadOnlyList<EntityFlow>? Flows = null)
{
    /// <summary>The variables a dead-letter link's URL may use.</summary>
    public static readonly string[] LinkVariables = ObservabilityCity.Core.Snapshots.DeadLetterLinks.Variables;

    public const string DefaultDimension = "EntityName";
}

/// <summary>An entity that carries a pillar's traffic: <see cref="Match"/> has the named group <c>pillar</c>; <see cref="Direction"/> is <c>sent</c> or <c>received</c>.</summary>
public sealed record EntityFlow(string Match, string Direction)
{
    public const string Sent = "sent";
    public const string Received = "received";
}

/// <summary>A metric and the way its points are added up.</summary>
public sealed record EntityMetric(string Metric, string Aggregation);

/// <summary>One shape of entity name. <see cref="Match"/> has the named groups <c>pillar</c> and <c>service</c>; <see cref="Consumer"/> is the role of the system that reads the entity.</summary>
public sealed record EntityPattern(string Match, string Consumer);

/// <summary>The metrics of the resources one rule of <c>scope.resources</c> finds, by signal (cpu, memory, utilisation, throttled, requests, and limit, the provisioned size shown as a number). <c>Interval</c> is the time grain they are asked at; none means the adapter's default (one minute). <c>Window</c> is how far back the entry looks; none means the source's own window.</summary>
public sealed record MetricGroup(string Resources, string? Namespace, IReadOnlyDictionary<string, MetricSignal> Signals, TimeSpan? Interval = null, TimeSpan? Window = null)
{
    /// <summary>The grains the metrics API offers. Which of them a metric supports depends on the metric: some allow a minute, some only five or more.</summary>
    public static readonly int[] IntervalMinutes = [1, 5, 15, 30, 60, 360, 720, 1440];

    public static readonly string[] SignalNames = ["cpu", "memory", "utilisation", "throttled", "requests"];
    public static readonly string[] WhenEmptyValues = ["unknown", "idle"];
    public static readonly string[] Aggregations = ["average", "total", "count", "maximum", "minimum"];

    /// <summary>What a message broker's backlog and dead letters may use: those, and <c>last</c>, the newest point of the window (a count of what is there now, not the worst of the last minutes).</summary>
    public static readonly string[] BrokerLevelAggregations = [.. Aggregations, "last"];
}

/// <summary>
/// Where one signal's number comes from: a metric, how its points are added up, an optional dimension filter, and how it becomes the fraction or rate the
/// town reads (divided by <see cref="Over"/>, per second, times <see cref="Scale"/>). <see cref="OrElse"/> is read in its place when the metric gives no number or 0.
/// </summary>
public sealed record MetricSignal(string Metric, string Aggregation, string? Filter, double Scale, bool PerSecond, MetricSignal? Over, MetricSignal? OrElse = null, bool EmptyIsIdle = false);
