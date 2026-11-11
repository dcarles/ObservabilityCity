using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Tests;

public class RegistryValidationTests
{
    /// <summary>A throw-away registry folder: a valid town, hub and the given pillar files, plus any extra files.</summary>
    private sealed class Folder : IDisposable
    {
        public string Path { get; } = Directory.CreateTempSubdirectory().FullName;

        public Folder(IDictionary<string, string> pillars, string hub = "resources: []\n", string layout = "")
        {
            Directory.CreateDirectory(System.IO.Path.Combine(Path, "pillars"));
            File.WriteAllText(System.IO.Path.Combine(Path, "town.yaml"), "id: t\nname: T\n" + layout);
            File.WriteAllText(System.IO.Path.Combine(Path, "hub.yaml"), hub);
            foreach (var (name, text) in pillars)
                File.WriteAllText(System.IO.Path.Combine(Path, "pillars", name + ".yaml"), text);
        }

        public Registry Load() => RegistryLoader.Load(Path);
        public void Dispose() => Directory.Delete(Path, true);
    }

    private static string Pillar(string code, params string[] systems) =>
        $"pillar: {code}\ndisplayName: {code.ToUpperInvariant()}\nsystems:\n" + string.Join("\n", systems.Select(s => "  - " + s)) + "\n";

    [Fact]
    public void Sample_town_has_sixteen_pillars_and_lost_and_found_last()
    {
        var registry = RegistryLoader.Load(TestPaths.Registry);
        var pillars = registry.Groups.Where(g => !g.IsHub).ToList();

        Assert.Equal(17, pillars.Count);
        Assert.Equal(16, pillars.Count(p => !p.IsLostFound));
        Assert.True(pillars[^1].IsLostFound);
        Assert.Equal("cl", pillars[0].Id); // town.yaml islands order, not file-name order
        Assert.True(registry.AllNodes.Count() >= 100);
    }

    [Fact]
    public void Every_system_in_the_sample_has_a_declared_caller_or_is_an_entry_point()
    {
        var registry = RegistryLoader.Load(TestPaths.Registry);
        var called = registry.AllNodes.SelectMany(n => n.Calls).ToHashSet();
        var external = registry.ExternalCallers.SelectMany(c => c.Calls).ToHashSet();
        var orphans = registry.AllNodes
            .Where(n => !n.Id.StartsWith("hub.") && !n.Id.StartsWith("lost-found.") && n.Kind is NodeKind.Api or NodeKind.Cache or NodeKind.Database
                        && !called.Contains(n.Id) && !external.Contains(n.Id) && !n.External)
            .Select(n => n.Id).ToList();
        Assert.Empty(orphans);
    }

    [Fact]
    public void Unlisted_pillars_follow_the_layout_and_lost_and_found_stays_last()
    {
        using var f = new Folder(
            new Dictionary<string, string>
            {
                ["aa"] = Pillar("aa", "{ id: aa.x, role: api }"),
                ["bb"] = Pillar("bb", "{ id: bb.x, role: api }"),
                ["cc"] = Pillar("cc", "{ id: cc.x, role: api }"),
                ["lost-found"] = Pillar("lost-found", "{ id: lost-found.x, role: api }"),
            },
            layout: "islands: [cc]\n");

        Assert.Equal(["hub", "cc", "aa", "bb", "lost-found"], f.Load().Groups.Select(g => g.Id));
    }

    [Fact]
    public void A_misspelt_island_in_the_layout_suggests_the_real_one()
    {
        using var f = new Folder(new Dictionary<string, string> { ["billing"] = Pillar("billing", "{ id: billing.x, role: api }") }, layout: "islands: [biling]\n");
        var e = Assert.Throws<RegistryException>(f.Load);

        Assert.Contains("town.yaml", e.Message);
        Assert.Contains("Did you mean 'billing'?", e.Message);
    }

    [Fact]
    public void A_misspelt_call_suggests_the_real_system()
    {
        using var f = new Folder(new Dictionary<string, string>
        {
            ["aa"] = Pillar("aa", "{ id: aa.ledger-api, role: api, calls: [aa.ledger-dbb] }", "{ id: aa.ledger-db, role: db }"),
        });
        var e = Assert.Throws<RegistryException>(f.Load);

        Assert.Contains("Did you mean 'aa.ledger-db'?", e.Message);
    }

    [Fact]
    public void A_misspelt_role_suggests_the_real_one()
    {
        using var f = new Folder(new Dictionary<string, string> { ["aa"] = Pillar("aa", "{ id: aa.x, role: apii }") });
        var e = Assert.Throws<RegistryException>(f.Load);

        Assert.Contains("Did you mean 'api'?", e.Message);
    }

    [Fact]
    public void A_misspelt_key_is_an_error_with_a_suggestion()
    {
        using var f = new Folder(new Dictionary<string, string> { ["aa"] = Pillar("aa", "{ id: aa.x, role: api, cals: [] }") });
        var e = Assert.Throws<RegistryException>(f.Load);

        Assert.Contains("aa.yaml", e.Message);
        Assert.Contains("unknown key 'cals'", e.Message);
        Assert.Contains("Did you mean 'calls'?", e.Message);
    }

    [Fact]
    public void Ids_must_be_kebab_case_and_unique()
    {
        using var f = new Folder(new Dictionary<string, string>
        {
            ["aa"] = Pillar("aa", "{ id: aa.Bad_Name, role: api }", "{ id: aa.twice, role: api }", "{ id: aa.twice, role: db }"),
        });
        var e = Assert.Throws<RegistryException>(f.Load);

        Assert.Contains("'aa.Bad_Name' must look like", e.Message);
        Assert.Contains("'aa.twice' is used twice", e.Message);
    }

    [Fact]
    public void All_problems_are_reported_together()
    {
        using var f = new Folder(new Dictionary<string, string>
        {
            ["aa"] = Pillar("aa", "{ id: aa.x, role: castle }", "{ id: aa.y, role: api, calls: [aa.nowhere] }"),
        });
        var e = Assert.Throws<RegistryException>(f.Load);

        Assert.Contains("2 problems", e.Message);
        Assert.Contains("castle", e.Message);
        Assert.Contains("aa.nowhere", e.Message);
    }

    [Fact]
    public void An_old_id_keeps_working_as_an_alias_and_resolves_to_the_new_one()
    {
        using var f = new Folder(new Dictionary<string, string>
        {
            ["aa"] = Pillar("aa", "{ id: aa.new-name, role: db, aliases: [aa.old-name] }", "{ id: aa.api, role: api, calls: [aa.old-name] }"),
        });
        var registry = f.Load();

        Assert.Equal(["aa.new-name"], registry.AllNodes.Single(n => n.Id == "aa.api").Calls);
    }

    [Fact]
    public void An_alias_cannot_be_taken_twice()
    {
        using var f = new Folder(new Dictionary<string, string>
        {
            ["aa"] = Pillar("aa", "{ id: aa.one, role: api, aliases: [aa.old] }", "{ id: aa.two, role: api, aliases: [aa.old] }"),
        });
        var e = Assert.Throws<RegistryException>(f.Load);

        Assert.Contains("alias 'aa.old'", e.Message);
    }

    [Fact]
    public void External_callers_may_only_call_external_systems()
    {
        using var f = new Folder(
            new Dictionary<string, string> { ["aa"] = Pillar("aa", "{ id: aa.open, role: api, external: true }", "{ id: aa.closed, role: api }") },
            hub: "resources: []\nexternalCallers:\n  - { id: app, calls: [aa.open, aa.closed] }\n");
        var e = Assert.Throws<RegistryException>(f.Load);

        Assert.Contains("'aa.closed', which is not marked external", e.Message);
    }

    [Fact]
    public void Schemas_on_disk_match_what_the_app_generates()
    {
        // the schemas in a town's folder are written with the adapter modules this repository builds, so the Azure adapter's keys complete in an editor too
        var adapters = new AdapterCatalog([new AzureAdapters()]);
        foreach (var town in new[] { TestPaths.Registry, TestPaths.DroidShop })
        {
            var registry = RegistryLoader.Load(town, adapters);
            var dir = Path.Combine(town, RegistrySchema.FolderName);
            if (Environment.GetEnvironmentVariable("UPDATE_GOLDEN") == "1") RegistrySchema.Write(registry, town, adapters);

            foreach (var (name, text) in RegistrySchema.Files(registry, adapters))
                Assert.Equal(text.TrimEnd(), File.ReadAllText(Path.Combine(dir, name)).ReplaceLineEndings("\n").TrimEnd());
        }
    }

    [Fact]
    public void The_generated_environment_schema_holds_the_core_keys_of_a_source_and_each_modules_own_for_its_kinds()
    {
        var schema = System.Text.Json.Nodes.JsonNode.Parse(RegistrySchema.Files(RegistryLoader.Load(TestPaths.Registry), new AdapterCatalog([new AzureAdapters()]))["environment.schema.json"])!;
        var source = schema["properties"]!["sources"]!["additionalProperties"]!;
        Assert.Equal(RegistryLoader.SourceKeys.Order(), source["properties"]!.AsObject().Select(p => p.Key).Order());
        Assert.Null(source["additionalProperties"]); // any other key is the kind's: the branches below say which

        var branches = source["allOf"]!.AsArray().ToDictionary(b => string.Join(",", b!["if"]!["properties"]!["kind"]!["enum"]!.AsArray().Select(k => (string)k!)), b => b!["then"]!);
        var azure = branches["resourcegraph,loganalytics,azuremonitor,servicebus,functionjobs,resourcehealth"];
        Assert.False((bool)azure["additionalProperties"]!);
        foreach (var key in new[] { "regionQuery", "typesQuery", "metrics", "entities", "providers", "keepResolvedFor", "kind", "pollSeconds" })
            Assert.NotNull(azure["properties"]![key]);
        Assert.NotNull(schema["$defs"]!["metricSignal"]);
        var core = branches["fake,prometheus,grafana-irm"]; // the kinds that take no settings: only the core's keys
        Assert.Equal(RegistryLoader.SourceKeys.Order(), core["properties"]!.AsObject().Select(p => p.Key).Order());

        // without the module, nothing is said about its kinds, and the core schema has no Azure word in a source
        var bare = RegistrySchema.Files(RegistryLoader.Load(TestPaths.Registry))["environment.schema.json"];
        Assert.DoesNotContain("regionQuery", bare);
        Assert.DoesNotContain("metricSignal", bare);
    }

    [Fact]
    public void The_azure_adapters_schema_names_every_key_its_settings_a_metrics_entry_and_its_signals_can_have()
    {
        // the schema is written by hand; without this an editor flags a valid key as a mistake as soon as the loader learns it
        static IEnumerable<string> Keys(string type) => typeof(AzureSourceSettings).Assembly.GetType($"ObservabilityCity.Adapters.Azure.{type}")!
            .GetProperties().Select(p => char.ToLowerInvariant(p.Name[0]) + p.Name[1..]);
        var schema = System.Text.Json.Nodes.JsonNode.Parse(AzureSourceSettings.Reader.Schema)!;
        var entry = schema["properties"]!["metrics"]!["items"]!["properties"]!.AsObject().Select(p => p.Key);
        var signal = schema["$defs"]!["metricSignal"]!["properties"]!.AsObject().Select(p => p.Key);
        var keys = schema["properties"]!.AsObject().Select(p => p.Key).Where(k => k != "window"); // the Azure adapter says more about the core's window for its kinds
        var entities = schema["properties"]!["entities"]!["properties"]!.AsObject().Select(p => p.Key);

        Assert.Equal(Keys("MetricGroupFile").Order(), entry.Order());
        Assert.Equal(Keys("MetricSignalFile").Order(), signal.Order());
        Assert.Equal(Keys("AzureSourceFile").Order(), keys.Order());
        Assert.Equal(Keys("EntitiesFile").Order(), entities.Order());
    }

    [Fact]
    public void Every_sample_yaml_file_points_at_its_schema()
    {
        foreach (var file in Directory.GetFiles(TestPaths.Registry, "*.yaml", SearchOption.AllDirectories).Where(f => Path.GetFileName(f) is not ("fake.yaml" or "fake-assets.yaml")))
            Assert.StartsWith("# yaml-language-server: $schema=", File.ReadLines(file).First());
    }

    // ── ring capacity ───────────────────────────────────────────────────────

    private static Dictionary<string, string> Pillars(int n) =>
        Enumerable.Range(1, n).ToDictionary(i => $"p{i:00}", i => Pillar($"p{i:00}", $"{{ id: p{i:00}.api, name: API, role: api }}"));

    [Fact]
    public void The_ring_capacity_defaults_to_twelve()
    {
        using var f = new Folder(Pillars(3));

        Assert.Equal(12, f.Load().RingCapacity);
    }

    [Theory]
    [InlineData(12, 23, true)]
    [InlineData(12, 24, false)]
    [InlineData(18, 35, true)]
    [InlineData(18, 36, false)]
    [InlineData(6, 11, true)]
    [InlineData(6, 12, false)]
    public void A_town_holds_up_to_twice_the_ring_capacity_less_one_pillars(int capacity, int pillars, bool fits)
    {
        using var f = new Folder(Pillars(pillars), layout: $"ringCapacity: {capacity}\n");

        if (fits)
            Assert.Equal(capacity, f.Load().RingCapacity);
        else
        {
            var e = Assert.Throws<RegistryException>(f.Load);
            Assert.Contains($"{pillars} pillars do not fit on two rings of {capacity}: at most {capacity * 2 - 1}", e.Message);
            Assert.Contains("town.yaml", e.Message);
        }
    }

    [Fact]
    public void The_error_says_which_capacity_would_fit_and_when_none_does()
    {
        using var small = new Folder(Pillars(24));
        Assert.Contains("set ringCapacity to 13 or more", Assert.Throws<RegistryException>(small.Load).Message);

        using var big = new Folder(Pillars(36), layout: "ringCapacity: 18\n");
        Assert.Contains("35 is the most a town can hold", Assert.Throws<RegistryException>(big.Load).Message);
    }

    [Theory]
    [InlineData(5)]
    [InlineData(19)]
    [InlineData(0)]
    public void A_ring_capacity_outside_six_to_eighteen_is_refused(int capacity)
    {
        using var f = new Folder(Pillars(3), layout: $"ringCapacity: {capacity}\n");

        var e = Assert.Throws<RegistryException>(f.Load);

        Assert.Contains($"town.yaml: ringCapacity must be between 6 and 18, not {capacity}", e.Message);
    }

    [Fact]
    public void A_town_that_does_not_fit_fails_even_a_resilient_load()
    {
        using var f = new Folder(Pillars(24));

        Assert.Throws<RegistryException>(() => RegistryLoader.LoadResilient(f.Path));
    }

    [Fact]
    public void The_config_reference_lists_every_key_the_loader_reads()
    {
        // each section of docs/config-reference.md is tagged with the file type it describes; its table must name exactly that type's keys
        var doc = File.ReadAllText(Path.Combine(TestPaths.RepoRoot, "docs", "config-reference.md")).ReplaceLineEndings("\n");
        var sections = System.Text.RegularExpressions.Regex.Matches(doc, @"<!-- file: (\w+) -->\n((?:\|.*\n?)+)");
        var documented = sections.ToDictionary(m => m.Groups[1].Value, m => System.Text.RegularExpressions.Regex.Matches(m.Groups[2].Value, @"^\| `(\w+)` \|", System.Text.RegularExpressions.RegexOptions.Multiline).Select(k => k.Groups[1].Value).Order().ToList());
        // the core's files, and the settings an adapter reads from a source block: the Azure adapter's are documented as its own section
        var types = typeof(RegistryLoader).Assembly.GetTypes()
            .Where(t => t.Namespace == "ObservabilityCity.Core.Registry" && t.Name.EndsWith("File", StringComparison.Ordinal) && t.IsClass)
            .Where(t => t.Name != "DefaultsFile")
            .Concat(typeof(AzureSourceSettings).Assembly.GetTypes().Where(t => t.Namespace == "ObservabilityCity.Adapters.Azure" && t.Name.EndsWith("File", StringComparison.Ordinal) && t.IsClass))
            .ToList();
        Assert.Contains(types, t => t.Name == "AzureSourceFile");

        foreach (var type in types)
        {
            Assert.True(documented.ContainsKey(type.Name), $"docs/config-reference.md has no section tagged <!-- file: {type.Name} -->");
            var keys = type.GetProperties().Select(p => char.ToLowerInvariant(p.Name[0]) + p.Name[1..]).Order().ToList();
            Assert.Equal(keys, documented[type.Name]);
        }
    }
}
