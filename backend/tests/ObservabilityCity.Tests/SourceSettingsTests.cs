using System.Text.Json.Nodes;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Validate;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Each adapter owns the settings of its kinds' sources: the core reads its own keys of a source block and hands the rest to the module, which checks them
/// and makes what its source reads. A second module, written here from scratch, has a settings block of its own (<c>queries</c>) that the core has never
/// heard of: its town loads, validates and builds a snapshot, and its mistakes are reported by the module, on the line of the key.
/// </summary>
public class SourceSettingsTests
{
    // ---- a module with settings of its own ----

    /// <summary>The keys of a metricstore source beyond the core's.</summary>
    public sealed class MetricStoreFile
    {
        public QueriesFile? Queries { get; set; }
    }

    public sealed class QueriesFile
    {
        public string? Rate { get; set; }
        public string? Errors { get; set; }
        public string? Latency { get; set; }
    }

    /// <summary>What the source runs with: the query for each signal; null when the file leaves it out.</summary>
    public sealed record MetricStoreQueries(string Rate, string? Errors, string? Latency);

    public sealed class MetricStoreSettings : SourceSettingsReader<MetricStoreFile, MetricStoreQueries>
    {
        public override string Schema => """
            { "$defs": { "promql": { "type": "string", "minLength": 1 } },
              "properties": { "queries": { "type": "object", "required": ["rate"], "additionalProperties": false,
                "properties": { "rate": { "$ref": "#/$defs/promql" }, "errors": { "$ref": "#/$defs/promql" }, "latency": { "$ref": "#/$defs/promql" } } } } }
            """;

        protected override void Check(MetricStoreFile file, SourceSettingsContext context, SettingsReport report)
        {
            if (file.Queries is null) report.Add($"source '{context.SourceName}' needs queries: rate, errors and latency");
            else if (string.IsNullOrWhiteSpace(file.Queries.Rate)) report.Add($"source '{context.SourceName}' queries.rate is empty; give the query for the request rate", "queries", "rate");
        }

        protected override MetricStoreQueries Convert(MetricStoreFile file) => new(file.Queries?.Rate ?? "", file.Queries?.Errors, file.Queries?.Latency);
    }

    /// <summary>Answers a query with a number for each system, as a metrics store would; the source asks it what its settings say.</summary>
    private sealed class MetricStoreSource(string name, MetricStoreQueries queries, Func<string, IReadOnlyDictionary<string, double>> store, TimeProvider time) : IMetricSource
    {
        public string Name => name;
        public TimeSpan PollInterval => TimeSpan.FromSeconds(30);

        public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct)
        {
            var rate = store(queries.Rate);
            var errors = queries.Errors is { } e ? store(e) : new Dictionary<string, double>();
            var latency = queries.Latency is { } l ? store(l) : new Dictionary<string, double>();
            var known = registry.AllNodes.Select(n => n.Id).ToHashSet();
            return Task.FromResult<IReadOnlyDictionary<string, NodeReading>>(rate.Where(r => known.Contains(r.Key)).ToDictionary(r => r.Key, r =>
                new NodeReading(time.GetUtcNow(), true, 1, 1, 0, r.Value, errors.GetValueOrDefault(r.Key), latency.GetValueOrDefault(r.Key))));
        }
    }

    private sealed class MetricStore(Func<string, IReadOnlyDictionary<string, double>> store, TimeProvider time) : IAdapterModule, IMetricSourceFactory
    {
        public static readonly MetricStoreSettings Settings = new();
        public string Name => "metric-store";
        public string Kind => "metricstore";

        public void Register(IAdapterRegistry registry)
        {
            registry.AddSourceKind(new SourceKindInfo(Kind) { Settings = Settings });
            registry.AddSource(this);
        }

        public IMetricSource Create(SourceContext context) => new MetricStoreSource(context.Source.Name, Settings.For(context.Source), store, time);
    }

    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    private static readonly Dictionary<string, IReadOnlyDictionary<string, double>> Answers = new()
    {
        ["sum by (system) (rate(requests_total[5m]))"] = new Dictionary<string, double> { ["aa.orders-api"] = 12, ["bb.ledger-api"] = 4, ["nowhere.else"] = 9 },
        ["sum by (system) (rate(requests_failed[5m]))"] = new Dictionary<string, double> { ["aa.orders-api"] = 0.25 },
        ["max by (system) (latency_p99_ms)"] = new Dictionary<string, double> { ["aa.orders-api"] = 180, ["bb.ledger-api"] = 40 },
    };

    private static AdapterCatalog Catalog(params IAdapterModule[] more) =>
        new([new MetricStore(q => Answers.TryGetValue(q, out var a) ? a : throw new InvalidOperationException($"no answer for {q}"), new FakeTimeProvider(T0)), .. more]);

    private const string Environment = """
        name: Production
        sources:
          telemetry:
            kind: metricstore
            connection: "https://prom.example.test"
            pollSeconds: 15
            queries:
              rate: "sum by (system) (rate(requests_total[5m]))"
              errors: "sum by (system) (rate(requests_failed[5m]))"
              latency: "max by (system) (latency_p99_ms)"
        signals: { requests: telemetry, errors: telemetry, latency: telemetry }

        """;

    private static RegistryCopy Town(string? environment = null)
    {
        var copy = new RegistryCopy(TestPaths.LiveTown);
        Directory.CreateDirectory(copy.FilePath("environments"));
        copy.Write("environments/prod.yaml", environment ?? Environment);
        return copy;
    }

    [Fact]
    public void A_town_on_the_second_module_loads_and_validates_and_its_source_gets_the_settings_the_module_made()
    {
        using var town = Town();

        var source = RegistryLoader.Load(town.Path, Catalog()).Environments.Single().Sources.Single();
        var result = RegistryValidator.Validate(town.Path, Catalog());

        Assert.Equal(0, result.Errors);
        Assert.Equal(new MetricStoreQueries("sum by (system) (rate(requests_total[5m]))", "sum by (system) (rate(requests_failed[5m]))", "max by (system) (latency_p99_ms)"), source.Typed);
        Assert.Equal(["queries"], source.Settings.Keys);
        Assert.Equal(15, source.PollSeconds); // the core's keys stay the core's
        Assert.Equal(source.Typed, MetricStore.Settings.For(RegistryLoader.Load(town.Path).Environments.Single().Sources.Single())); // a town loaded without the module: read when the source starts
    }

    [Fact]
    public async Task A_town_on_the_second_module_builds_a_snapshot_from_what_its_settings_ask()
    {
        using var town = Town();
        var catalog = Catalog();
        var registry = RegistryLoader.Load(town.Path, catalog).ForEnvironment("prod");
        var set = catalog.Build(registry.ActiveEnvironment!, town.Path);
        Assert.Empty(set.Problems);
        var state = new LatestState();
        foreach (var s in set.Sources) state.Update(s.Name, await s.PollAsync(registry, CancellationToken.None));

        var snapshot = new SnapshotBuilder(registry, state, new FakeTimeProvider(T0)) { Environment = "prod" }.Build();

        var api = snapshot.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == "aa.orders-api");
        Assert.Equal((12, 0.25, 180), (api.RequestsPerSecond, api.ErrorRate, api.P99Ms));
        Assert.Equal(4, snapshot.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == "bb.ledger-api").RequestsPerSecond);
    }

    // ---- its mistakes, reported by the module with the file and the line ----

    public static TheoryData<string, string, string, string> Mistakes => new()
    {
        // an unknown key in its block: the module's own keys give the "did you mean"
        { "      rate:", "      rat:", "      rat:", "environments/prod.yaml (line 8): unknown key 'rat'. Did you mean 'rate'?" },
        // a key of the source the module does not have
        { "    queries:", "    quries:", "    quries:", "environments/prod.yaml (line 7): unknown key 'quries'. Did you mean 'queries'?" },
        // a value of the wrong shape: the YAML reader's words, as for the core's own files
        { "    queries:\n      rate: \"sum by (system) (rate(requests_total[5m]))\"\n      errors: \"sum by (system) (rate(requests_failed[5m]))\"\n      latency: \"max by (system) (latency_p99_ms)\"\n", "    queries: [rate]\n", "    queries: [rate]", "environments/prod.yaml (line 7): No node deserializer was able to deserialize the node into type" },
        // something required missing: the module's own check, on the line of the key it is about
        { "      rate: \"sum by (system) (rate(requests_total[5m]))\"\n", "      rate: \" \"\n", "      rate:", "environments/prod.yaml: source 'telemetry' queries.rate is empty; give the query for the request rate" },
        { "    queries:\n      rate: \"sum by (system) (rate(requests_total[5m]))\"\n      errors: \"sum by (system) (rate(requests_failed[5m]))\"\n      latency: \"max by (system) (latency_p99_ms)\"\n", "", "    kind: metricstore", "environments/prod.yaml: source 'telemetry' needs queries: rate, errors and latency" },
    };

    [Theory]
    [MemberData(nameof(Mistakes))]
    public void A_mistake_in_the_second_modules_settings_is_reported_by_it_on_the_line_of_the_key(string old, string @new, string onLine, string message)
    {
        using var town = Town();
        town.Replace("environments/prod.yaml", old, @new);

        var finding = Assert.Single(RegistryValidator.Validate(town.Path, Catalog()).Findings, f => f.Severity == Severity.Error);
        var strict = Assert.Throws<RegistryException>(() => RegistryLoader.Load(town.Path, Catalog()));

        Assert.Equal("environments/prod.yaml", finding.File);
        Assert.StartsWith(message, finding.Message);
        Assert.StartsWith(onLine, town.Read("environments/prod.yaml").Split('\n')[finding.Line - 1]);
        Assert.Contains(message, strict.Message);
    }

    [Fact]
    public void Without_its_module_the_kind_is_named_unknown_once_and_nothing_is_guessed_about_its_settings()
    {
        using var town = Town(Environment.Replace("      rate:", "      rat:")); // a mistake only the module could see

        foreach (var catalog in new[] { new AdapterCatalog([]), TestAdapters.Azure })
        {
            var findings = RegistryValidator.Validate(town.Path, catalog).Findings.Where(f => f.Severity == Severity.Error).ToList();

            var finding = Assert.Single(findings);
            Assert.Contains("source 'telemetry' has kind 'metricstore', which is not a kind of source this build knows", finding.Message);
        }
        Assert.Equal(["queries"], RegistryLoader.Load(town.Path).Environments.Single().Sources.Single().Settings.Keys); // kept, unread
    }

    [Fact]
    public void A_core_key_is_checked_by_the_core_whatever_the_kind()
    {
        using var town = Town(Environment.Replace("pollSeconds: 15", "pollSeconds: 0"));

        var finding = Assert.Single(RegistryValidator.Validate(town.Path, Catalog()).Findings, f => f.Severity == Severity.Error);

        Assert.Equal("environments/prod.yaml: source 'telemetry' has pollSeconds 0; it must be above 0", finding.Message);
    }

    [Fact]
    public void A_kind_that_declares_no_settings_takes_no_key_beyond_the_cores()
    {
        using var town = Town("name: Production\nsources:\n  metrics: { kind: prometheus, connection: \"https://prom.example.test\", queries: { rate: x } }\n");

        var finding = Assert.Single(RegistryValidator.Validate(town.Path, Catalog()).Findings, f => f.Severity == Severity.Error);

        Assert.Equal("environments/prod.yaml (line 3): unknown key 'queries'.", finding.Message);
        Assert.Equal(3, finding.Line);
    }

    [Fact]
    public void A_module_that_throws_while_reading_settings_is_named_and_the_other_sources_are_not_harmed()
    {
        var broken = new BrokenModule();
        using var town = Town(Environment.Replace("signals:", "  other: { kind: broken, x: 1 }\nsignals:"));

        var findings = RegistryValidator.Validate(town.Path, Catalog(broken)).Findings.Where(f => f.Severity == Severity.Error).ToList();

        Assert.Contains(findings, f => f.Message == "environments/prod.yaml: source 'other' has settings its adapter could not read: a bug in the module");
        Assert.DoesNotContain(findings, f => f.Message.Contains("'telemetry'"));
    }

    private sealed class BrokenModule : IAdapterModule, ISourceSettingsReader
    {
        public string Name => "broken";
        public void Register(IAdapterRegistry registry) => registry.AddSourceKind(new SourceKindInfo("broken") { Settings = this });
        public SourceSettingsResult Read(SourceSettingsContext context) => throw new InvalidOperationException("a bug in the module");
    }

    // ---- the editor schema ----

    [Fact]
    public void The_editor_schema_completes_the_second_modules_keys_for_its_kind_beside_the_azure_ones()
    {
        var registry = RegistryLoader.Load(TestPaths.LiveTown);
        var schema = JsonNode.Parse(RegistrySchema.Files(registry, Catalog(new AzureAdapters()))["environment.schema.json"])!;

        var branches = schema["properties"]!["sources"]!["additionalProperties"]!["allOf"]!.AsArray();
        var store = branches.Single(b => b!["if"]!["properties"]!["kind"]!["enum"]!.AsArray().Select(k => (string)k!).SequenceEqual(["metricstore"]))!["then"]!;
        Assert.Equal(["rate"], store["properties"]!["queries"]!["required"]!.AsArray().Select(k => (string)k!));
        Assert.NotNull(store["properties"]!["pollSeconds"]);
        Assert.Null(store["properties"]!["metrics"]); // the Azure keys are for the Azure kinds only
        Assert.NotNull(schema["$defs"]!["promql"]);
        Assert.NotNull(schema["$defs"]!["metricSignal"]);
        AdapterContract.AssertModule(new MetricStore(_ => new Dictionary<string, double>(), TimeProvider.System)); // and its fragment passes the kit's check
    }
}
