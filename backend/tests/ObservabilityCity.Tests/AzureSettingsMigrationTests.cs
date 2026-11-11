using System.Text.Json;
using System.Text.RegularExpressions;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Validate;

namespace ObservabilityCity.Tests;

/// <summary>
/// The Azure adapter's source settings (regionQuery, typesQuery, metrics, entities, providers, keepResolvedFor) used to be held and checked by the core. They
/// are the adapter's now. What the core made of them, and what the validator said about a set of mistakes in them, were recorded before the move
/// (<c>shared-test-data/settings-migration</c>); the same files must give the same settings and the same findings after it.
/// </summary>
public class AzureSettingsMigrationTests
{
    private static string Golden => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "settings-migration");
    private static string Registries => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries");

    /// <summary>One mistake in an Azure source, made in a copy of a test town: the text that is replaced once in environments/prod.yaml and what replaces it.</summary>
    internal static readonly (string Name, string Town, string Old, string New)[] Mistakes =
    [
        ("metrics-unknown-rule", "messaging-town-a", "      - resources: plans", "      - resources: planz"),
        ("metrics-aggregation-and-scale", "messaging-town-a", "cpu: { metric: CpuPercentage, aggregation: average, scale: 0.01 }", "cpu: { metric: CpuPercentage, aggregation: avrage, scale: 0 }"),
        ("metrics-no-signal", "function-town-a", "      - resources: plans\n        cpu: { metric: CpuPercentage, aggregation: average, scale: 0.01 }\n        memory: { metric: MemoryPercentage, aggregation: average, scale: 0.01 }", "      - resources: plans"),
        ("metrics-or-else-with-over", "messaging-town-a", "limit: { metric: ProvisionedThroughput, aggregation: maximum }", "limit: { metric: A, aggregation: maximum, orElse: { metric: B, aggregation: maximum, over: { metric: C } } }"),
        ("metrics-when-empty", "messaging-town-a", "requests: { metric: TotalRequests, aggregation: count, perSecond: true }", "requests: { metric: TotalRequests, aggregation: count, perSecond: true, whenEmpty: zero }"),
        ("metrics-interval-and-window", "messaging-town-a", "      - resources: accounts", "      - resources: accounts\n        interval: 7m\n        window: 1m"),
        ("metrics-filter-variable", "messaging-town-a", "filter: \"StatusCode eq '429'\"", "filter: \"StatusCode eq '{code}'\""),
        ("metrics-over-of-over", "messaging-town-a", "over: { metric: ProvisionedThroughput, aggregation: maximum }", "over: { metric: ProvisionedThroughput, aggregation: maximum, scale: 2, over: { metric: X } }"),
        ("metrics-empty-metric", "function-town-a", "cpu: { metric: CpuPercentage, aggregation: average, scale: 0.01 }", "cpu: { aggregation: average }"),
        ("entities-unknown-rule", "messaging-town-a", "      resources: broker", "      resources: brokr"),
        ("entities-pattern-groups", "messaging-town-a", "'^q-[a-z]+-[a-z]+-to-(?<service>[a-z]+)$'", "'^q-(?<producer>[a-z]+)-[a-z]+-to-[a-z]+$'"),
        ("entities-bad-pattern", "messaging-town-a", "'^q-[a-z]+-[a-z]+-to-(?<service>[a-z]+)$'", "'^q-(['"),
        ("entities-dead-letter-link", "messaging-town-a", "url: \"https://support.example.test/queues/{queue}?team={pillar}&service={service}\"", "url: \"support.example.test/{queu}\""),
        ("entities-aggregation-and-interval", "messaging-town-a", "      backlog: { metric: ActiveMessages, aggregation: average }", "      backlog: { metric: ActiveMessages, aggregation: avg }\n      interval: 2m"),
        ("entities-no-metric", "messaging-town-a", "      backlog: { metric: ActiveMessages, aggregation: average }\n      deadLetter: { metric: DeadletteredMessages, aggregation: maximum }\n      throughput: { metric: IncomingMessages, aggregation: total }\n", ""),
        ("entities-flows", "messaging-town-a", "      patterns:\n", "      flows:\n        - { match: '^t-(?<team>[a-z]+)$', direction: out }\n      patterns:\n"),
        ("entities-no-patterns", "messaging-town-a", "      patterns:\n        # q-<pillar code>-<service code>-<in|feed>: read by that service's worker\n        - { match: '^q-(?<pillar>[a-z]+)-(?<service>[a-z]+)-(?:in|feed)$' }\n        # q-<pillar code>-<from>-to-<to>: read by the service it is addressed to, in whichever pillar it is\n        - { match: '^q-[a-z]+-[a-z]+-to-(?<service>[a-z]+)$' }\n", "      patterns: []\n"),
        ("region-query-variable", "function-town-a", "| summarize calls = sum(ItemCount) by role = AppRoleName, region", "| where x == \"{nonsense}\" | summarize calls = sum(ItemCount) by role = AppRoleName, region"),
        ("region-query-empty", "function-town-a", "    regionQuery: |\n      AppRequests\n      | where TimeGenerated > ago({window}) and AppRoleName in ({roles})\n      | summarize calls = sum(ItemCount) by role = AppRoleName, region = tostring(Properties[\"cloud.region\"])\n", "    regionQuery: \" \"\n"),
        ("types-query-variable", "messaging-town-b", "Name == \"messaging.process.duration\"", "Name == \"{nonsense}\""),
        ("provider-spelling", "health-town-a", "providers: [Microsoft.DocumentDB]", "providers: [documentdb]"),
        ("keep-resolved-for", "health-town-a", "providers: [Microsoft.DocumentDB]", "providers: [Microsoft.DocumentDB], keepResolvedFor: soon"),
        ("unknown-key", "function-town-a", "    regionQuery: |", "    regoinQuery: |"),
        ("unknown-key-in-metrics", "function-town-a", "      - resources: plans", "      - resources: plans\n        cpus: { metric: X }"),
        ("wrong-type", "health-town-a", "providers: [Microsoft.DocumentDB]", "providers: { a: Microsoft.DocumentDB }"),
        ("window-core", "function-town-a", "    window: 1d", "    window: soon"),
        ("poll-core", "health-town-a", "pollSeconds: 60", "pollSeconds: 0"),
    ];

    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };
    private static readonly AdapterCatalog Azure = new([new AzureAdapters()]);

    /// <summary>Every town with environments: the shared test towns and the sample towns.</summary>
    private static IEnumerable<string> Towns() =>
        Directory.GetDirectories(Registries).Concat(Directory.GetDirectories(Path.Combine(TestPaths.RepoRoot, "config")))
            .Where(t => Directory.Exists(Path.Combine(t, "environments"))).OrderBy(d => d, StringComparer.Ordinal);

    [Fact]
    public void Every_source_in_the_test_and_sample_towns_is_read_into_the_same_settings_as_the_core_read_it()
    {
        // parsed.json is what the core's loader made of every source when it still held the Azure adapter's keys
        var parsed = new SortedDictionary<string, object>(StringComparer.Ordinal);
        foreach (var town in Towns())
            foreach (var env in RegistryLoader.Load(town, Azure).Environments)
                foreach (var s in env.Sources)
                {
                    var azure = Azure.SettingsOf(s.Kind) is null ? AzureSettings.None : (AzureSettings)s.Typed!;
                    if (Azure.SettingsOf(s.Kind) is not null) Assert.Equal(JsonSerializer.Serialize(azure), JsonSerializer.Serialize(AzureSettings.Of(RegistryLoader.Load(town).Environments.Single(e => e.Id == env.Id).Sources.Single(x => x.Name == s.Name)))); // read later by the source, without the loader's help
                    parsed[$"{Path.GetFileName(town)}/{env.Id}/{s.Name}"] = new
                    {
                        s.Kind, s.Connection, s.Credential, s.PollSeconds, s.TimeoutSeconds, s.LateAfterSeconds, s.Query, s.Window,
                        azure.RegionQuery, azure.TypesQuery, azure.Metrics, azure.Entities, azure.Providers, azure.KeepResolvedFor,
                    };
                }

        Assert.Equal(File.ReadAllText(Path.Combine(Golden, "parsed.json")).ReplaceLineEndings("\n"), JsonSerializer.Serialize(parsed, Indented) + "\n");
    }

    private sealed record Seen(string Severity, string File, int Line, string Rule, string Message);

    /// <summary>The words that may follow a message now and did not before: an unknown key's "did you mean", which now comes from the adapter's own keys.</summary>
    private static readonly Regex Hint = new(@" Did you mean '[^']+'\?$");

    /// <summary>The lines of the source block a finding is about: from the source's name to the next key at its depth or above.</summary>
    private static (int From, int To) BlockOf(string[] lines, string source)
    {
        var from = Array.FindIndex(lines, l => l.StartsWith($"  {source}:", StringComparison.Ordinal));
        Assert.True(from >= 0, $"source '{source}' not found");
        var to = Array.FindIndex(lines, from + 1, l => l.Length > 2 && !char.IsWhiteSpace(l[0]) || l.Length > 3 && l.StartsWith("  ", StringComparison.Ordinal) && !char.IsWhiteSpace(l[2]) && l[2] != '#');
        return (from + 1, to < 0 ? lines.Length : to);
    }

    /// <summary>For some mistakes, text the line of the finding must hold: the settings' own checks now point at the key they are about.</summary>
    private static readonly Dictionary<string, string> ExactLines = new()
    {
        ["metrics-unknown-rule"] = "resources: planz",
        ["metrics-aggregation-and-scale"] = "aggregation: avrage, scale: 0",
        ["entities-unknown-rule"] = "resources: brokr",
        ["provider-spelling"] = "providers: [documentdb]",
        ["keep-resolved-for"] = "keepResolvedFor: soon",
        ["region-query-variable"] = "regionQuery:",
        ["types-query-variable"] = "typesQuery:",
        ["entities-flows"] = "direction: out",
    };

    [Fact]
    public void A_mistake_in_an_azure_source_gets_the_same_findings_as_before_now_on_the_line_of_its_key()
    {
        // findings.json is what the validator said about each mistake when the core still checked the Azure adapter's keys
        var before = JsonSerializer.Deserialize<Dictionary<string, List<Seen>>>(File.ReadAllText(Path.Combine(Golden, "findings.json")))!;
        Assert.Equal(Mistakes.Select(m => m.Name).Order(StringComparer.Ordinal), before.Keys.Order(StringComparer.Ordinal));
        foreach (var (name, town, old, @new) in Mistakes)
        {
            using var copy = new RegistryCopy(Path.Combine(Registries, town));
            copy.Replace("environments/prod.yaml", old, @new);
            var lines = copy.Read("environments/prod.yaml").Split('\n');
            var now = RegistryValidator.Validate(copy.Path, Azure).Findings.Select(f => new Seen(f.Severity.ToString(), f.File, f.Line, f.Rule, f.Message)).ToList();

            static string Key(Seen f) => $"{f.File} {f.Severity} {f.Rule} {Hint.Replace(f.Message, "")}";
            var was = before[name].OrderBy(Key, StringComparer.Ordinal).ToList();
            var @is = now.OrderBy(Key, StringComparer.Ordinal).ToList();
            Assert.True(was.Count == @is.Count, $"{name}: {string.Join(" | ", @is.Select(f => f.Message))}");
            for (var i = 0; i < was.Count; i++)
            {
                var (a, b) = (was[i], @is[i]);
                Assert.Equal((a.Severity, a.File, a.Rule), (b.Severity, b.File, b.Rule));
                Assert.True(a.Message == b.Message || !Hint.IsMatch(a.Message) && Hint.Replace(b.Message, "") == a.Message, $"{name}: was '{a.Message}', is '{b.Message}'");
                if (a.Line == b.Line) continue;
                // only an adapter's own check moved: it is now on a line of its source's block, where it used to be on a line found by guessing
                var source = Regex.Match(b.Message, "source '([^']+)'").Groups[1].Value;
                var (from, to) = BlockOf(lines, source);
                Assert.True(b.Line > from && b.Line <= to, $"{name}: line {b.Line} is outside source '{source}' ({from + 1} to {to})");
            }
            if (ExactLines.TryGetValue(name, out var text))
                Assert.All(@is.Where(f => f.File == "environments/prod.yaml"), f => Assert.Contains(text, lines[f.Line - 1]));
        }
    }
}
