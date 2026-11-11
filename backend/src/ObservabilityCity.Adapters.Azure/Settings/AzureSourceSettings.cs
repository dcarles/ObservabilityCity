using System.Text.RegularExpressions;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>
/// How the Azure adapter reads and checks the settings of its sources: the keys of a source block beyond the core's (regionQuery, typesQuery, metrics,
/// entities, providers, keepResolvedFor). Every Azure kind takes the same keys, as before the core handed them over, so a file that loaded then loads now.
/// The loader and the validator run these checks for every Azure source; the source reads the <see cref="AzureSettings"/> they make.
/// </summary>
public sealed partial class AzureSourceSettings : SourceSettingsReader<AzureSourceFile, AzureSettings>
{
    public static AzureSourceSettings Reader { get; } = new();

    private static readonly Lazy<string> Fragment = new(() =>
    {
        using var stream = typeof(AzureSourceSettings).Assembly.GetManifestResourceStream("ObservabilityCity.Adapters.Azure.Settings.azure-source.schema.json")!;
        return new StreamReader(stream).ReadToEnd();
    });

    /// <summary>The keys an editor may complete for an Azure source, merged into the environment schema by <c>--write-schema</c>.</summary>
    public override string Schema => Fragment.Value;

    protected override AzureSettings Convert(AzureSourceFile f) => new()
    {
        RegionQuery = f.RegionQuery,
        TypesQuery = f.TypesQuery,
        Metrics = ToMetrics(f.Metrics),
        Entities = ToEntities(f.Entities),
        Providers = f.Providers.Select(p => p.Trim()).ToList(),
        KeepResolvedFor = f.KeepResolvedFor,
    };

    protected override void Check(AzureSourceFile def, SourceSettingsContext context, SettingsReport report)
    {
        var source = context.SourceName;
        var known = context.Scope.Variables.Keys.Append(ScopeRules.EnvironmentVariable).Concat(SourceQuery.Variables).ToList();
        if (def.RegionQuery is { } regionQuery)
        {
            if (regionQuery.Trim().Length == 0) report.Add($"source '{source}' has an empty regionQuery; give the query that returns role, region and calls, or leave it out", "regionQuery");
            foreach (var problem in ScopeTemplate.Check(regionQuery, known)) report.Add($"source '{source}' regionQuery: {problem}", "regionQuery");
        }
        if (def.TypesQuery is { } typesQuery)
        {
            if (typesQuery.Trim().Length == 0) report.Add($"source '{source}' has an empty typesQuery; give the query that returns queue, type and calls, or leave it out", "typesQuery");
            foreach (var problem in ScopeTemplate.Check(typesQuery, known)) report.Add($"source '{source}' typesQuery: {problem}", "typesQuery");
        }
        CheckMetrics(def, context, report);
        CheckEntities(def, context, report);
        for (var i = 0; i < def.Providers.Count; i++)
            if (!Regex.IsMatch(def.Providers[i].Trim(), @"^[A-Za-z0-9]+(\.[A-Za-z0-9]+)+$"))
                report.Add($"source '{source}' has the provider '{def.Providers[i]}'. Write a resource provider the way the cloud names it, for example Namespace.Service", "providers", i);
        if (def.KeepResolvedFor is { } keep && !SourceQuery.TryParseWindow(keep, out _))
            report.Add($"source '{source}' has keepResolvedFor '{keep}', which is not a number and a unit like 4h or 90m", "keepResolvedFor");
    }

    private static MetricSignal? ToSignal(MetricSignalFile? f) =>
        f is null ? null : new MetricSignal(f.Metric.Trim(), f.Aggregation.Trim().ToLowerInvariant(), string.IsNullOrWhiteSpace(f.Filter) ? null : f.Filter.Trim(), f.Scale, f.PerSecond, ToSignal(f.Over), ToSignal(f.OrElse), string.Equals(f.WhenEmpty?.Trim(), "idle", StringComparison.OrdinalIgnoreCase));

    internal static List<MetricGroup> ToMetrics(List<MetricGroupFile> files) =>
        files.Select(g => new MetricGroup(g.Resources, string.IsNullOrWhiteSpace(g.Namespace) ? null : g.Namespace.Trim(),
            new[] { ("cpu", g.Cpu), ("memory", g.Memory), ("utilisation", g.Utilisation), ("throttled", g.Throttled), ("requests", g.Requests), ("limit", g.Limit) }
                .Where(x => x.Item2 is not null).ToDictionary(x => x.Item1, x => ToSignal(x.Item2)!),
            string.IsNullOrWhiteSpace(g.Interval) ? null : SourceQuery.TryParseWindow(g.Interval, out var interval) ? interval : null,
            string.IsNullOrWhiteSpace(g.Window) ? null : SourceQuery.TryParseWindow(g.Window, out var window) ? window : null)).ToList();

    internal static EntitiesConfig? ToEntities(EntitiesFile? f) =>
        f is null ? null : new EntitiesConfig(f.Resources, string.IsNullOrWhiteSpace(f.Dimension) ? EntitiesConfig.DefaultDimension : f.Dimension.Trim(),
            ToEntityMetric(f.Backlog), ToEntityMetric(f.DeadLetter),
            f.Patterns.Select(p => new EntityPattern(p.Match, string.IsNullOrWhiteSpace(p.Consumer) ? "worker" : p.Consumer.Trim().ToLowerInvariant())).ToList(),
            string.IsNullOrWhiteSpace(f.Interval) ? null : SourceQuery.TryParseWindow(f.Interval, out var interval) ? interval : null,
            f.DeadLetterLink is { } l ? new EntityLink(l.Name.Trim(), l.Url.Trim()) : null,
            ToEntityMetric(f.Throughput),
            f.DeadLetterLinks.Count == 0 ? null : f.DeadLetterLinks.Select(l => new EntityRegionLink((l.Region ?? "").Trim(), new EntityLink(l.Name.Trim(), l.Url.Trim()))).ToList(),
            f.Flows.Count == 0 ? null : f.Flows.Select(x => new EntityFlow(x.Match, (x.Direction ?? "").Trim().ToLowerInvariant())).ToList());

    private static EntityMetric? ToEntityMetric(EntityMetricFile? f) => f is null ? null : new EntityMetric(f.Metric.Trim(), f.Aggregation.Trim().ToLowerInvariant());

    /// <summary>A broker source's entities: the rule must exist, the metrics must be named, and each pattern must be a regular expression with the group service (and group or its older name pillar, producerPillar and producer when the name says them).</summary>
    private static void CheckEntities(AzureSourceFile def, SourceSettingsContext context, SettingsReport report)
    {
        var errors = new Placed(report);
        var at = $"source '{context.SourceName}' entities";
        if (def.Entities is not { } e) return; // a servicebus source without the block is refused when it starts, as an azuremonitor source without metrics is
        var rules = context.Scope.Resources.Select(r => r.Name).ToList();
        if (!rules.Contains(e.Resources))
            errors.Add($"{at}: resources '{e.Resources}' is not a rule of scope.resources.{(rules.Count == 0 ? " This file has no scope.resources." : $" Use {string.Join(", ", rules)}.")}{DidYouMean.Hint(e.Resources, rules)}");
        if (e.Backlog is null && e.DeadLetter is null && e.Throughput is null) errors.Add($"{at}: it asks for no metric. Give backlog, deadLetter, throughput or any of them");
        foreach (var (label, metric) in new[] { ("backlog", e.Backlog), ("deadLetter", e.DeadLetter), ("throughput", e.Throughput) })
        {
            if (metric is null) continue;
            if (string.IsNullOrWhiteSpace(metric.Metric)) errors.Add($"{at}.{label}: metric is empty; give the metric's name");
            var allowed = label == "throughput" ? MetricGroup.Aggregations : MetricGroup.BrokerLevelAggregations; // last reads a level; a throughput is added up
            if (!allowed.Contains(metric.Aggregation.Trim().ToLowerInvariant()))
                errors.Add($"{at}.{label}: aggregation '{metric.Aggregation}'. Use {string.Join(", ", allowed)}.{DidYouMean.Hint(metric.Aggregation, allowed)}");
        }
        if (e.Interval is { } grain && (!SourceQuery.TryParseWindow(grain, out var parsed) || !MetricGroup.IntervalMinutes.Contains((int)Math.Round(parsed.TotalMinutes))))
            errors.Add($"{at}: interval '{grain}' is not a time grain the metrics API offers. Use one of {string.Join(", ", MetricGroup.IntervalMinutes.Select(m => m % 1440 == 0 ? $"{m / 1440}d" : m % 60 == 0 ? $"{m / 60}h" : $"{m}m"))}");
        if (e.DeadLetterLink is { } link)
        {
            if (string.IsNullOrWhiteSpace(link.Name)) errors.Add($"{at}.deadLetterLink: name is empty; give the words the link shows");
            if (!Regex.IsMatch(link.Url ?? "", @"^https?://", RegexOptions.IgnoreCase)) errors.Add($"{at}.deadLetterLink: url must start with http:// or https://");
            foreach (Match m in Regex.Matches(link.Url ?? "", @"\{([^{}]*)\}"))
                if (!EntitiesConfig.LinkVariables.Contains(m.Groups[1].Value))
                    errors.Add($"{at}.deadLetterLink: {{{m.Groups[1].Value}}} is not a variable of the url. Use {string.Join(", ", EntitiesConfig.LinkVariables.Select(v => "{" + v + "}"))}.{DidYouMean.Hint(m.Groups[1].Value, EntitiesConfig.LinkVariables)}");
        }
        var seenRegions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < e.DeadLetterLinks.Count; i++)
        {
            var l = e.DeadLetterLinks[i];
            var where = $"{at}.deadLetterLinks[{i}]";
            if (string.IsNullOrWhiteSpace(l.Region)) errors.Add($"{where}: region is empty; give the region the address is for");
            else if (!seenRegions.Add(l.Region.Trim())) errors.Add($"{where}: region '{l.Region.Trim()}' is given twice");
            if (string.IsNullOrWhiteSpace(l.Name)) errors.Add($"{where}: name is empty; give the words the link shows");
            if (!Regex.IsMatch(l.Url ?? "", @"^https?://", RegexOptions.IgnoreCase)) errors.Add($"{where}: url must start with http:// or https://");
            foreach (Match m in Regex.Matches(l.Url ?? "", @"\{([^{}]*)\}"))
                if (!EntitiesConfig.LinkVariables.Contains(m.Groups[1].Value))
                    errors.Add($"{where}: {{{m.Groups[1].Value}}} is not a variable of the url. Use {string.Join(", ", EntitiesConfig.LinkVariables.Select(v => "{" + v + "}"))}.{DidYouMean.Hint(m.Groups[1].Value, EntitiesConfig.LinkVariables)}");
        }
        for (var i = 0; i < e.Flows.Count; i++)
        {
            var where = $"{at}.flows[{i}]";
            var direction = (e.Flows[i].Direction ?? "").Trim().ToLowerInvariant();
            if (direction is not (EntityFlow.Sent or EntityFlow.Received)) errors.Add($"{where}: direction '{e.Flows[i].Direction}'. Use sent or received.{DidYouMean.Hint(direction, [EntityFlow.Sent, EntityFlow.Received])}");
            try
            {
                if (!GroupWords.HasGroup(new Regex(e.Flows[i].Match, RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)).GetGroupNames(), GroupWords.Group))
                    errors.Add($"{where}: the match has no group named 'group' (older name 'pillar'). Write it as (?<group>...)");
            }
            catch (ArgumentException ex) { errors.Add($"{where}: the match is not a valid regular expression: {ex.Message}"); }
        }
        if (e.Flows.Count > 0 && e.Throughput is null) errors.Add($"{at}: flows need a throughput metric to read the rate from. Give throughput");
        if (e.Patterns.Count == 0) errors.Add($"{at}: patterns is empty. Give at least one pattern: a regular expression with the named group service (and group, older name pillar, when the name says it)");
        for (var i = 0; i < e.Patterns.Count; i++)
        {
            try
            {
                var regex = new Regex(e.Patterns[i].Match, RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
                var names = regex.GetGroupNames();
                if (!names.Contains("service")) errors.Add($"{at}.patterns[{i}]: the match has no group named 'service'. Write it as (?<service>...)");
                // the publisher is named by both groups or by neither
                if (names.Contains("producer") != names.Contains("producerPillar"))
                    errors.Add($"{at}.patterns[{i}]: a route needs both groups, (?<producerPillar>...) and (?<producer>...); this match has only {(names.Contains("producer") ? "producer" : "producerPillar")}");
            }
            catch (ArgumentException ex) { errors.Add($"{at}.patterns[{i}]: the match is not a valid regular expression: {ex.Message}"); }
        }
    }

    private static void CheckMetrics(AzureSourceFile def, SourceSettingsContext context, SettingsReport report)
    {
        if (def.Metrics.Count == 0) return;
        var errors = new Placed(report);
        var rules = context.Scope.Resources.Select(r => r.Name).ToList();
        var known = context.Scope.Variables.Keys.Append(ScopeRules.EnvironmentVariable).ToList();
        for (var i = 0; i < def.Metrics.Count; i++)
        {
            var group = def.Metrics[i];
            var at = $"source '{context.SourceName}' metrics[{i}]";
            if (!rules.Contains(group.Resources))
                errors.Add($"{at}: resources '{group.Resources}' is not a rule of scope.resources.{(rules.Count == 0 ? " This file has no scope.resources." : $" Use {string.Join(", ", rules)}.")}{DidYouMean.Hint(group.Resources, rules)}");
            if (group.Interval is { } grain && (!SourceQuery.TryParseWindow(grain, out var parsed) || !MetricGroup.IntervalMinutes.Contains((int)Math.Round(parsed.TotalMinutes)) || Math.Abs(parsed.TotalMinutes - Math.Round(parsed.TotalMinutes)) > 1e-9))
                errors.Add($"{at}: interval '{grain}' is not a time grain the metrics API offers. Use one of {string.Join(", ", MetricGroup.IntervalMinutes.Select(m => m % 1440 == 0 ? $"{m / 1440}d" : m % 60 == 0 ? $"{m / 60}h" : $"{m}m"))}");
            if (group.Window is { } look)
            {
                var grainOf = group.Interval is { } g && SourceQuery.TryParseWindow(g, out var gp) ? gp : TimeSpan.FromMinutes(1);
                if (!SourceQuery.TryParseWindow(look, out var lookSpan)) errors.Add($"{at}: window '{look}' is not a number and a unit like 15m or 1h");
                else if (lookSpan < grainOf * 2) errors.Add($"{at}: window '{look}' holds fewer than two points of its {(group.Interval ?? "1m")} interval; make it at least {Math.Ceiling((grainOf * 2).TotalMinutes)}m");
            }
            var signals = new[] { ("cpu", group.Cpu), ("memory", group.Memory), ("utilisation", group.Utilisation), ("throttled", group.Throttled), ("requests", group.Requests), ("limit", group.Limit) }.Where(x => x.Item2 is not null).ToList();
            if (signals.All(s => s.Item1 == "limit")) errors.Add($"{at}: it asks for no signal. Give at least one of {string.Join(", ", MetricGroup.SignalNames)}");
            foreach (var (signal, spec) in signals)
            {
                CheckSignal(spec!, $"{at}.{signal}", false);
            }
        }

        void CheckSignal(MetricSignalFile spec, string at, bool isOver)
        {
            if (string.IsNullOrWhiteSpace(spec.Metric)) errors.Add($"{at}: metric is empty; give the metric's name");
            if (!MetricGroup.Aggregations.Contains(spec.Aggregation.Trim().ToLowerInvariant()))
                errors.Add($"{at}: aggregation '{spec.Aggregation}'. Use {string.Join(", ", MetricGroup.Aggregations)}.{DidYouMean.Hint(spec.Aggregation, MetricGroup.Aggregations)}");
            if (!double.IsFinite(spec.Scale) || spec.Scale <= 0) errors.Add($"{at}: scale must be above 0 (0.01 turns a percentage into a fraction)");
            if (spec.WhenEmpty is { } whenEmpty)
            {
                if (!MetricGroup.WhenEmptyValues.Contains(whenEmpty.Trim().ToLowerInvariant()))
                    errors.Add($"{at}.whenEmpty: '{whenEmpty}'. Use {string.Join(", ", MetricGroup.WhenEmptyValues)}.{DidYouMean.Hint(whenEmpty, MetricGroup.WhenEmptyValues)}");
                else if (isOver) errors.Add($"{at}.whenEmpty: it belongs on the signal itself, not on its over or orElse");
            }
            if (spec.Filter is { } filter)
                foreach (var problem in ScopeTemplate.Check(filter, known)) errors.Add($"{at}.filter: {problem}");
            if (spec.OrElse is { } alt)
            {
                if (alt.Over is not null || alt.OrElse is not null) errors.Add($"{at}.orElse: it is only another metric to read in place; it cannot have an over or an orElse of its own");
                else CheckSignal(alt, $"{at}.orElse", true);
            }
            if (spec.Over is { } over)
            {
                if (isOver) errors.Add($"{at}: over cannot have an over of its own");
                else CheckSignal(over, $"{at}.over", true);
                if (over.PerSecond || over.Scale != 1) errors.Add($"{at}.over: the divisor is used as it is; put scale and perSecond on the metric itself");
            }
        }
    }

    /// <summary>
    /// Places a mistake on the line of the key its text names: <c>source 'x' metrics[0].cpu: aggregation 'avrage'</c> is about metrics, item 0, cpu, aggregation.
    /// It keeps the checks' words as they were, and the line follows from them.
    /// </summary>
    private sealed partial class Placed(SettingsReport report)
    {
        [GeneratedRegex(@"^source '[^']*' (?<path>[A-Za-z]+(?:\[\d+\]|\.[A-Za-z]+)*)(?:: (?<key>[A-Za-z]+) '|[: ])")]
        private static partial Regex Path();

        [GeneratedRegex(@"[A-Za-z]+|\d+")]
        private static partial Regex Part();

        public void Add(string message)
        {
            var m = Path().Match(message);
            var path = new List<object>();
            if (m.Success)
            {
                foreach (Match p in Part().Matches(m.Groups["path"].Value)) path.Add(int.TryParse(p.Value, out var n) ? n : p.Value);
                if (m.Groups["key"].Success) path.Add(m.Groups["key"].Value);
            }
            report.Add(message, [.. path]);
        }
    }
}

// The shapes of an Azure source's settings, as read from the environment file.

/// <summary>The keys of an Azure source beyond the core's.</summary>
public sealed class AzureSourceFile
{
    /// <summary>Request sources only (loganalytics): the query that says how a service's requests divide between regions, a template like query. Returns one row per telemetry name and region with the columns role, region and calls (sampling-corrected counts do: only the proportions are used).</summary>
    public string? RegionQuery { get; set; }
    /// <summary>Broker sources only (servicebus): the query that says which kinds of message each queue handled, a template like query. Returns one row per queue and message type with the columns queue, type and calls (counts over the window). Without it the types are not shown.</summary>
    public string? TypesQuery { get; set; }
    /// <summary>Platform-metric sources only (azuremonitor): which metric of which resources fills which signal. Everything about the metrics is written here; the program knows none.</summary>
    public List<MetricGroupFile> Metrics { get; set; } = [];
    /// <summary>Message-broker sources only (servicebus): which namespaces to read, which metrics fill the backlog and the dead letters, and how an entity's name says whose it is.</summary>
    public EntitiesFile? Entities { get; set; }
    /// <summary>Resource-health sources only (resourcehealth): the resource providers whose health reports are read, for example the data store's. The program lists none; a source without any does not start.</summary>
    public List<string> Providers { get; set; } = [];
    /// <summary>Resource-health sources: how long a resolved report stays listed after the resource recovered, like 4h. Default 4h.</summary>
    public string? KeepResolvedFor { get; set; }
}

/// <summary>How a broker's queues and topics are read: the namespaces come from a scope.resources rule, the metrics are split by the entity's name, and patterns say which system an entity belongs to.</summary>
public sealed class EntitiesFile
{
    /// <summary>The name of a scope.resources rule: the resources it finds (the broker's namespaces) are the ones asked.</summary>
    public string Resources { get; set; } = "";
    /// <summary>The metric dimension that carries the entity's name. Default EntityName.</summary>
    public string? Dimension { get; set; }
    /// <summary>The time grain the metrics are asked at, for example 5m. Default: one minute.</summary>
    public string? Interval { get; set; }
    /// <summary>The messages waiting in an entity, for example a metric of active messages added up by average.</summary>
    public EntityMetricFile? Backlog { get; set; }
    /// <summary>The dead-lettered messages of an entity, for example a metric of dead-lettered messages added up by maximum.</summary>
    public EntityMetricFile? DeadLetter { get; set; }
    /// <summary>An address that opens a consumer's dead letters in your support tool: a name and a URL template over {group} (older name {pillar}), {service}, {system} and {environment}. Without it, no link.</summary>
    public EntityLinkFile? DeadLetterLink { get; set; }
    /// <summary>One support-tool address for each region, when the regions have their own tool: each is a name, a URL template and the region it is for. A queue's dead letters in a region open the entry of that region; a region with no entry uses deadLetterLink.</summary>
    public List<EntityLinkFile> DeadLetterLinks { get; set; } = [];
    /// <summary>The messages that arrive in an entity, for example a metric of incoming messages added up by total. Their rate sets how many boats sail to the consumer.</summary>
    public EntityMetricFile? Throughput { get; set; }
    /// <summary>Entity name patterns, tried in order: the first that matches decides whose the entity is. An entity no pattern matches is left out.</summary>
    public List<EntityPatternFile> Patterns { get; set; } = [];
    /// <summary>Entities that stand for what a whole pillar sends to the others or receives from them (for example the topic the pillar publishes its events to, or the topic its incoming queues hang on). Each is a name pattern with the group pillar and a direction; the rate of its throughput metric is the pillar's rate.</summary>
    public List<EntityFlowFile> Flows { get; set; } = [];
}

/// <summary>One shape of entity name that carries a pillar's traffic: a regular expression with the named group pillar, and whether what arrives in it is sent by that pillar or received by it.</summary>
public sealed class EntityFlowFile
{
    public string Match { get; set; } = "";
    /// <summary>sent (what the pillar sends to other pillars) or received (what other pillars send to it).</summary>
    public string Direction { get; set; } = "";
}

public sealed class EntityLinkFile
{
    public string Name { get; set; } = "";
    public string Url { get; set; } = "";
    /// <summary>Only in deadLetterLinks: the region the address is for, as the town names it (for example the region of the broker's namespace), matched ignoring case.</summary>
    public string? Region { get; set; }
}

public sealed class EntityMetricFile
{
    public string Metric { get; set; } = "";
    public string Aggregation { get; set; } = "average";
}

/// <summary>One shape of entity name: a regular expression with the named groups pillar and service, which pick the system that consumes the entity (the one of the given kind whose pillar and service code they name).</summary>
public sealed class EntityPatternFile
{
    public string Match { get; set; } = "";
    /// <summary>The kind of system that reads the entity: worker (default), api, and so on.</summary>
    public string? Consumer { get; set; }
}

/// <summary>The metrics of one kind of resource: <see cref="Resources"/> names a rule of scope.resources, and each signal says where its number comes from.</summary>
public sealed class MetricGroupFile
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

public sealed class MetricSignalFile
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
    /// <summary>What a read that worked but returned no number means: <c>unknown</c> (the default, the system shows no data) or <c>idle</c> (nothing happened, so the signal is 0). A failed read is always unknown.</summary>
    public string? WhenEmpty { get; set; }
}
