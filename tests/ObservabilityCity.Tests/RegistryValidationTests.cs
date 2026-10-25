using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Tests;

public class RegistryValidationTests
{
    /// <summary>A throw-away registry folder: a valid town, hub and the given pillar files, plus any extra files.</summary>
    private sealed class Folder : IDisposable
    {
        public string Path { get; } = Directory.CreateTempSubdirectory().FullName;

        public Folder(IDictionary<string, string> pillars, string hub = "resources: []\n", string? layout = null)
        {
            Directory.CreateDirectory(System.IO.Path.Combine(Path, "pillars"));
            File.WriteAllText(System.IO.Path.Combine(Path, "town.yaml"), "id: t\nname: T\n");
            File.WriteAllText(System.IO.Path.Combine(Path, "hub.yaml"), hub);
            if (layout is not null) File.WriteAllText(System.IO.Path.Combine(Path, "layout.yaml"), layout);
            foreach (var (name, text) in pillars)
                File.WriteAllText(System.IO.Path.Combine(Path, "pillars", name + ".yaml"), text);
        }

        public Registry Load() => RegistryLoader.Load(Path);
        public void Dispose() => Directory.Delete(Path, true);
    }

    private static string Pillar(string code, params string[] systems) =>
        $"pillar: {code}\ndisplayName: {code.ToUpperInvariant()}\nsystems:\n" + string.Join("\n", systems.Select(s => "  - " + s)) + "\n";

    [Fact]
    public void Sample_town_has_fourteen_pillars_and_lost_and_found_last()
    {
        var registry = RegistryLoader.Load(TestPaths.Registry);
        var pillars = registry.Groups.Where(g => !g.IsHub).ToList();

        Assert.Equal(15, pillars.Count);
        Assert.Equal(14, pillars.Count(p => !p.IsLostFound));
        Assert.True(pillars[^1].IsLostFound);
        Assert.Equal("cl", pillars[0].Id); // layout.yaml order, not file-name order
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

        Assert.Contains("layout.yaml", e.Message);
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
        var registry = RegistryLoader.Load(TestPaths.Registry);
        var dir = Path.Combine(TestPaths.Registry, RegistrySchema.FolderName);
        var update = Environment.GetEnvironmentVariable("UPDATE_GOLDEN") == "1";
        if (update) RegistrySchema.Write(registry, TestPaths.Registry);

        foreach (var (name, text) in RegistrySchema.Files(registry))
            Assert.Equal(text.TrimEnd(), File.ReadAllText(Path.Combine(dir, name)).ReplaceLineEndings("\n").TrimEnd());
    }

    [Fact]
    public void Every_sample_yaml_file_points_at_its_schema()
    {
        foreach (var file in Directory.GetFiles(TestPaths.Registry, "*.yaml", SearchOption.AllDirectories).Where(f => Path.GetFileName(f) != "fake.yaml"))
            Assert.StartsWith("# yaml-language-server: $schema=", File.ReadLines(file).First());
    }
}
