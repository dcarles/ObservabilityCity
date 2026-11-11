using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Links;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Validate;

namespace ObservabilityCity.Tests;

/// <summary>
/// The files say group, the neutral word, or pillar, its older name: the folder (groups/ or pillars/), the key of a group file (group: or pillar:), the template
/// variables ({group}, {groupId}, {callerGroup} or {pillar}, {pillarId}, {callerPillar}), the named groups of a pattern ((?&lt;group&gt;) or (?&lt;pillar&gt;),
/// (?&lt;producerGroup&gt;) or (?&lt;producerPillar&gt;)) and the scope key groupAccounts (or pillarAccounts; its Azure name pillars is <see cref="ScopeAliasTests"/>'s).
/// Every test and sample town is written each way here, and once with the spellings mixed, and each must load to the same registry, snapshot, scope, Config tab
/// and findings, apart from the folder its files are in. Droid Shop uses the neutral names and Galactic Credit the older ones. A town with both folders, or a
/// file with both keys, is an error that names both.
/// </summary>
public class GroupAliasTests
{
    private static string Registries => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries");

    public enum Spelling { Neutral, Older, Mixed }

    private static readonly (string Neutral, string Older)[] Variables = [("groupId", "pillarId"), ("callerGroup", "callerPillar"), ("group", "pillar")];

    /// <summary>A template's variables written the one way or the other; a filter (<c>{pillar|lower}</c>) stays.</summary>
    private static string Templates(string yaml, bool neutral)
    {
        foreach (var (n, o) in Variables)
        {
            var (from, to) = neutral ? (o, n) : (n, o);
            yaml = Regex.Replace(yaml, $@"\{{{from}(?=[}}|])", "{" + to);
        }
        return yaml;
    }

    private static string Patterns(string yaml, bool neutral) => neutral
        ? yaml.Replace("(?<pillar>", "(?<group>").Replace("(?<producerPillar>", "(?<producerGroup>")
        : yaml.Replace("(?<group>", "(?<pillar>").Replace("(?<producerGroup>", "(?<producerPillar>");

    /// <summary>The scope key of the groups' accounts written the one way or the other, where a key stands: after a line's indent or inside a flow mapping. Its Azure name stays.</summary>
    private static string Keys(string yaml, bool neutral)
    {
        var (from, to) = neutral ? (GroupWords.OlderGroupAccounts, GroupWords.GroupAccounts) : (GroupWords.GroupAccounts, GroupWords.OlderGroupAccounts);
        return Regex.Replace(yaml, $@"(?<=(^|[{{,])[ \t]*){from}:(?=[ \t\r\n])", to + ":", RegexOptions.Multiline);
    }

    /// <summary>
    /// Writes a copy of a town one way: <see cref="Spelling.Mixed"/> has the neutral folder and templates, and the older key and pattern groups. Templates and
    /// patterns are rewritten in every file but the group files, whose key is what changes.
    /// </summary>
    private static RegistryCopy Spelt(string town, Spelling spelling)
    {
        var copy = new RegistryCopy(town);
        var neutralFolder = spelling != Spelling.Older;
        var (from, to) = neutralFolder ? (GroupWords.OlderFolder, GroupWords.Folder) : (GroupWords.Folder, GroupWords.OlderFolder);
        if (Directory.Exists(copy.FilePath(from))) Directory.Move(copy.FilePath(from), copy.FilePath(to));
        var groupFiles = Directory.Exists(copy.FilePath(to)) ? Directory.GetFiles(copy.FilePath(to), "*.yaml") : [];
        foreach (var file in groupFiles)
        {
            var key = spelling == Spelling.Neutral ? GroupWords.Group : GroupWords.Pillar;
            File.WriteAllText(file, Regex.Replace(File.ReadAllText(file), "^(pillar|group):", key + ":", RegexOptions.Multiline));
        }
        foreach (var file in Directory.GetFiles(copy.Path, "*.yaml", SearchOption.AllDirectories).Except(groupFiles))
        {
            var text = File.ReadAllText(file);
            text = Templates(text, neutral: spelling != Spelling.Older);
            text = Patterns(text, neutral: spelling == Spelling.Neutral);
            text = Keys(text, neutral: spelling == Spelling.Neutral);
            File.WriteAllText(file, text);
        }
        return copy;
    }

    public static TheoryData<string> Towns()
    {
        var data = new TheoryData<string>();
        foreach (var town in Directory.GetDirectories(Registries).Concat(Directory.GetDirectories(Path.Combine(TestPaths.RepoRoot, "config"))).Order(StringComparer.Ordinal))
            if (File.Exists(Path.Combine(town, "town.yaml"))) data.Add(Path.GetRelativePath(TestPaths.RepoRoot, town));
        return data;
    }

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        ReferenceHandler = ReferenceHandler.IgnoreCycles,
    };

    private static readonly AdapterCatalog Adapters = new([new AzureAdapters()]);

    /// <summary>Text with every neutral spelling turned into the older one, so two towns that differ only in spelling read the same.</summary>
    private static string Older(string text) =>
        Patterns(Templates(text, neutral: false), neutral: false).Replace(GroupWords.Folder + "/", GroupWords.OlderFolder + "/");

    /// <summary>What a town comes to: its registry, the snapshot of each environment with the fake source's numbers, its scope and Config tabs, and the validator's findings.</summary>
    private static async Task<string> Town(string folder)
    {
        Registry registry;
        try { registry = RegistryLoader.Load(folder, Adapters); }
        catch (RegistryException e) { return "does not load: " + Older(e.Message); }
        var parts = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["registry"] = new
            {
                registry.Town, Groups = registry.Groups.Select(g => new { g.Id, g.DisplayName, g.Code, g.Color, g.IsHub, g.ConfigError, Nodes = g.Nodes.Select(n => n.Id), g.Schedules }),
                registry.Topics, registry.Subscriptions, registry.Notices, registry.Warnings,
                Environments = registry.Environments.Select(e => new { e.Id, e.Scope, e.Links, e.Logs }),
            },
            ["findings"] = RegistryValidator.Validate(folder, Adapters).Findings,
        };
        var recording = Path.Combine(folder, "inventory.json");
        var inventory = File.Exists(recording) ? ResourceGraphInventory.FromRecording(File.ReadAllText(recording)) : null;
        foreach (var view in registry.Environments.Count == 0 ? [registry] : registry.Environments.Select(e => registry.ForEnvironment(e.Id, null, Adapters)))
        {
            var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 24, 12, 0, 0, TimeSpan.Zero));
            var fake = new FakeSource(FakeProfiles.Load(folder), new FakeOptions(), clock) { Calm = true };
            var state = new LatestState();
            var builder = new SnapshotBuilder(view, state, clock) { DayFraction = () => fake.DayFraction, FixedAssets = FakeAssets.Load(folder) };
            clock.Advance(TimeSpan.FromSeconds(1));
            state.Update(await fake.PollAsync(view, default));
            var store = new ScopeStore();
            if (inventory is not null) store.Update(inventory, DateTimeOffset.UnixEpoch);
            parts[view.ActiveEnvironment?.Id ?? "town"] = new
            {
                Snapshot = builder.Build(),
                Resolution = ScopeResolver.Resolve(view, inventory),
                Details = view.AllNodes.Select(n => n.Id).Order(StringComparer.Ordinal).ToDictionary(id => id, id => SystemDetails.Of(view, id)! with { Scope = ScopeInfos.Of(view, store, id) }),
            };
        }
        return Older(JsonSerializer.Serialize(parts, Json));
    }

    [Theory]
    [MemberData(nameof(Towns))]
    public async Task A_town_loads_to_the_same_registry_and_snapshot_whether_it_says_group_or_pillar(string town)
    {
        var folder = Path.Combine(TestPaths.RepoRoot, town);
        using var neutral = Spelt(folder, Spelling.Neutral);
        using var older = Spelt(folder, Spelling.Older);
        using var mixed = Spelt(folder, Spelling.Mixed);

        var expected = await Town(older.Path);
        Assert.DoesNotContain("does not load", expected[..Math.Min(20, expected.Length)]);
        Assert.Equal(expected, await Town(neutral.Path));
        Assert.Equal(expected, await Town(mixed.Path));
        Assert.Equal(expected, await Town(folder));
    }

    [Fact]
    public void The_comparison_compares_towns_that_use_each_word()
    {
        // so the theory above compares something: the towns between them use the folder, the key, each variable and the pattern group
        var all = Towns().Select(t => Path.Combine(TestPaths.RepoRoot, t.Data)).ToList();
        var text = string.Join("\n", all.SelectMany(t => Directory.GetFiles(t, "*.yaml", SearchOption.AllDirectories)).Select(File.ReadAllText));
        Assert.Contains("{pillar}", text);
        Assert.Contains("{pillarId}", text); // {callerPillar} is used by no town: the link rule tests below show it
        Assert.Contains("(?<pillar>", text);
        Assert.Contains("(?<producerGroup>", text); // (?<producerPillar> is used by no town since routes-town took the new name: the spelt copies show it
        Assert.Contains("\n  groupAccounts:", text);
        Assert.Contains("\n  pillarAccounts:", text);
        Assert.Contains("\n  pillars:", text);
        Assert.Contains(all, t => Directory.Exists(Path.Combine(t, GroupWords.OlderFolder)));
        // Droid Shop uses the neutral names, Galactic Credit the older ones
        Assert.True(Directory.Exists(Path.Combine(TestPaths.DroidShop, GroupWords.Folder)));
        Assert.False(Directory.Exists(Path.Combine(TestPaths.DroidShop, GroupWords.OlderFolder)));
        Assert.All(Directory.GetFiles(Path.Combine(TestPaths.DroidShop, GroupWords.Folder), "*.yaml"), f => Assert.Matches("(?m)^group: ", File.ReadAllText(f)));
        Assert.True(Directory.Exists(Path.Combine(TestPaths.Registry, GroupWords.OlderFolder)));
        Assert.False(Directory.Exists(Path.Combine(TestPaths.Registry, GroupWords.Folder)));
        Assert.All(Directory.GetFiles(Path.Combine(TestPaths.Registry, GroupWords.OlderFolder), "*.yaml"), f => Assert.Matches("(?m)^pillar: ", File.ReadAllText(f)));
        Assert.Contains("{pillar}", File.ReadAllText(Path.Combine(TestPaths.Registry, "town.yaml")));
    }

    [Fact]
    public void Droid_shop_names_its_files_in_the_groups_folder()
    {
        var registry = RegistryLoader.Load(TestPaths.DroidShop);
        var detail = SystemDetails.Of(registry, "web.catalog-api")!;

        Assert.Equal(GroupWords.Folder, registry.GroupFolder);
        Assert.Equal("groups/web.yaml", detail.File);
        Assert.Equal("pillars/ldg.yaml", SystemDetails.Of(RegistryLoader.Load(TestPaths.Registry), "ldg.ledger-api")!.File);
    }

    // ---- both spellings at once ----

    [Fact]
    public void A_town_with_both_folders_is_an_error_that_names_both()
    {
        using var copy = new RegistryCopy(TestPaths.DroidShop);
        Directory.CreateDirectory(copy.FilePath(GroupWords.OlderFolder));
        const string message = "The town folder has both groups/ and pillars/, which are one folder (pillars/ is the older name of groups/). Keep one of them: move the files of the other into it";

        Assert.Equal(message, Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message);
        Assert.Equal(message, Assert.Throws<RegistryException>(() => RegistryLoader.LoadResilient(copy.Path)).Message); // the town is not guessed at, even by the running app
        var hit = Assert.Single(RegistryValidator.Validate(copy.Path).Findings);
        Assert.Equal((Severity.Error, "town.yaml", message), (hit.Severity, hit.File, hit.Message));
    }

    [Theory]
    [InlineData("group: web\n", "group: web\npillar: web\n", "pillar: web")]
    [InlineData("group: web\n", "pillar: web\ngroup: web\n", "group: web")]
    public void A_group_file_that_sets_both_keys_is_an_error_that_names_both_and_the_line(string old, string both, string second)
    {
        using var copy = new RegistryCopy(TestPaths.DroidShop);
        copy.Replace("groups/web.yaml", old, both);
        var line = copy.LineOf("groups/web.yaml", second);
        var expected = $"web.yaml (line {line}): the group file sets both 'group' and 'pillar', which are one setting ('pillar' is the older name of 'group'). Keep one of them";

        Assert.Contains(expected, Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message);
        var hit = Assert.Single(RegistryValidator.Validate(copy.Path).Findings, f => f.Message.Contains("sets both"));
        Assert.Equal((Severity.Error, "groups/web.yaml", line), (hit.Severity, hit.File, hit.Line));
    }

    [Fact]
    public void A_group_file_without_its_id_says_the_key_with_its_older_name()
    {
        using var copy = new RegistryCopy(TestPaths.DroidShop);
        copy.Replace("groups/web.yaml", "group: web\n", "");

        Assert.Contains("web.yaml: group is missing: give the group's id, the file name without .yaml (older name of the key: pillar)", Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message);
    }

    [Fact]
    public void A_group_file_in_the_older_folder_is_found_at_its_path_by_the_validator()
    {
        using var copy = Spelt(TestPaths.DroidShop, Spelling.Older);
        copy.Replace("pillars/web.yaml", "displayName: Web", "displayName: Web\ncolour: red");

        var hit = Assert.Single(RegistryValidator.Validate(copy.Path).Findings, f => f.Message.Contains("colour"));
        Assert.Equal(("pillars/web.yaml", copy.LineOf("pillars/web.yaml", "colour:")), (hit.File, hit.Line));
    }

    [Fact]
    public void Both_spellings_may_stand_in_one_template()
    {
        var convention = new MessagingConvention("{group}.{pillar}.{service}", "{service}");

        Assert.Equal("chk.chk.orders", convention.TopicName("chk", "orders"));
        Assert.True(convention.CouldBeTopicOf("chk", "chk.chk.orders"));
        Assert.Equal("a-b-a-b", ScopeTemplate.Render("{group}-{groupId}-{pillar}-{pillarId}", n => n switch { "pillar" => "a", "pillarId" => "b", _ => null }));
        Assert.Equal("a-a", ScopeTemplate.Render("{group|upper}-{pillar}", n => n == "group" ? "a" : null).ToLowerInvariant());
        Assert.Empty(ScopeTemplate.Check("{group}{pillar}{groupId}{pillarId}", ScopeRules.PillarVariables));
        Assert.Contains("{group}", Assert.Single(ScopeTemplate.Check("{grop}", ScopeRules.PillarVariables)));
    }

    // ---- {group} in each kind of template ----

    [Fact]
    public void The_topic_template_takes_group()
    {
        using var copy = new RegistryCopy(TestPaths.Registry);
        copy.Replace("town.yaml", "topicTemplate: \"{pillar}-{service}-outbox\"", "topicTemplate: \"{group}-{service}-outbox\"");

        var topics = RegistryLoader.Load(copy.Path).Topics.Select(t => (t.Name, t.GroupId)).ToList();

        Assert.Equal(RegistryLoader.Load(TestPaths.Registry).Topics.Select(t => (t.Name, t.GroupId)), topics);
        Assert.Contains(("ldg-ledger-outbox", "ldg"), topics);
    }

    [Fact]
    public void A_scope_rule_resolves_group_and_group_id_like_pillar_and_pillar_id()
    {
        var town = Path.Combine(Registries, "neutral-scope-town");
        using var copy = new RegistryCopy(town);
        var text = copy.Read("environments/prod.yaml");
        Assert.Contains("{pillar}", text);
        copy.Write("environments/prod.yaml", Templates(text, neutral: true));
        Assert.DoesNotContain("{pillar", copy.Read("environments/prod.yaml"));
        var inventory = ResourceGraphInventory.FromRecording(File.ReadAllText(Path.Combine(town, "inventory.json")));

        var before = ScopeResolver.Resolve(RegistryLoader.Load(town).ForEnvironment("prod"), inventory);
        var after = ScopeResolver.Resolve(RegistryLoader.Load(copy.Path).ForEnvironment("prod"), inventory);

        Assert.Empty(after.Problems);
        Assert.Equal(before.Pillar("aa")!.AccountId, after.Pillar("aa")!.AccountId);
        Assert.Equal(JsonSerializer.Serialize(before, Json), JsonSerializer.Serialize(after, Json));
    }

    [Theory]
    [InlineData(@"^(?<service>[a-z0-9]+)\.(?<group>[a-z]+)\.example\.test$", "{group}.{service}-api")]
    [InlineData(@"^(?<service>[a-z0-9]+)\.(?<pillar>[a-z]+)\.example\.test$", "{group}.{service}-api")]
    [InlineData(@"^(?<service>[a-z0-9]+)\.(?<group>[a-z]+)\.example\.test$", "{pillar}.{service}-api")]
    public void A_link_rule_reads_the_group_under_either_name_also_to_find_a_service_by_its_code(string host, string target)
    {
        string[] systems = ["aa.orders-api", "bb.ledger-api", "bb.orders-api"];
        ServiceCodeEntry[] codes = [new("aa", "orders", "ord"), new("bb", "ledger", "led"), new("bb", "orders", "led2")];
        var rules = new LinkDiscovery("logs", "q", TimeSpan.FromHours(1), TimeSpan.FromDays(7), 2, TimeSpan.FromDays(30), [], [new LinkRule(host, null, target, false)], new Dictionary<string, string>());
        Classified Classify(string address) => new LinkClassifier(rules, [], systems, codes).Classify(new DependencyRow("x", address, null, [new DateOnly(2026, 10, 29)], 10), "aa");

        Assert.Equal(new Classified(LinkOutcome.Found, "bb.orders-api", false), Classify("led2.bb.example.test")); // the code is read in the group the address names
        Assert.Equal(new Classified(LinkOutcome.Found, "bb.ledger-api", false), Classify("ledger.bb.example.test"));
        Assert.Equal(LinkOutcome.Unresolved, Classify("led.aa.example.test").Outcome);
    }

    [Theory]
    [InlineData("{callerGroup}.{service}-api")]
    [InlineData("{callerPillar}.{service}-api")]
    public void A_link_rule_names_the_callers_group_under_either_name(string target)
    {
        var rules = new LinkDiscovery("logs", "q", TimeSpan.FromHours(1), TimeSpan.FromDays(7), 2, TimeSpan.FromDays(30), [], [new LinkRule(@"^(?<service>[a-z]+)\.svc\.example\.test$", null, target, false)], new Dictionary<string, string>());

        var found = new LinkClassifier(rules, [], ["aa.orders-api", "bb.orders-api"]).Classify(new DependencyRow("x", "orders.svc.example.test", null, [new DateOnly(2026, 10, 29)], 10), "bb");

        Assert.Equal(new Classified(LinkOutcome.Found, "bb.orders-api", false), found);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task A_broker_source_reads_its_patterns_and_dead_letter_links_with_group_as_with_pillar(string town)
    {
        // the queues, their owners and the link to their dead letters come from the recorded broker, through (?<group>...) and {group}
        static async Task<string> Queues(string folder)
        {
            var registry = RegistryLoader.Load(folder, TestAdapters.Azure).ForEnvironment("prod");
            var set = Adapters.Build(registry.ActiveEnvironment!, folder);
            Assert.Empty(set.Problems);
            var state = new LatestState();
            foreach (var source in set.Sources) state.Update(source.Name, await source.PollAsync(registry, CancellationToken.None));
            var snapshot = new SnapshotBuilder(registry, state, new FakeTimeProvider(DateTimeOffset.Parse("2026-01-01T00:00:00Z"))) { Environment = "prod" }.Build();
            // the recorded sources stamp their readings with the time they were read
            return Regex.Replace(JsonSerializer.Serialize(snapshot, Json), @"\d{4}-\d\d-\d\dT[0-9:.]+\+00:00", "<time>");
        }
        var folder = Path.Combine(Registries, $"messaging-town-{town}");
        using var neutral = Spelt(folder, Spelling.Neutral);
        Assert.Contains("(?<group>", neutral.Read("environments/prod.yaml"));

        var expected = await Queues(folder);
        Assert.Contains("\"queues\": [", expected);
        Assert.Equal(expected, await Queues(neutral.Path));
    }

    [Fact]
    public void A_variable_may_not_take_the_name_of_the_group()
    {
        using var copy = new RegistryCopy(Path.Combine(Registries, "neutral-scope-town"));
        copy.Replace("environments/prod.yaml", "variables: { env: prd }", "variables: { env: prd, group: x }");

        Assert.Contains("scope.variables: 'group' is a word of the group itself ({group}, older name {pillar}) and cannot be redefined. Give the variable another name", Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message);
    }

    // ---- groupAccounts and producerGroup ----

    private static string NeutralScopeTown => Path.Combine(Registries, "neutral-scope-town");

    [Theory]
    [InlineData("groupAccounts")]
    [InlineData("pillarAccounts")]
    [InlineData("pillars")]
    public void The_groups_accounts_read_the_same_under_each_of_their_three_names(string key)
    {
        // groupAccounts, its older name pillarAccounts and its Azure name pillars
        using var copy = new RegistryCopy(NeutralScopeTown);
        copy.Replace("environments/prod.yaml", "  groupAccounts: {", $"  {key}: {{");
        var inventory = ResourceGraphInventory.FromRecording(copy.Read("inventory.json"));

        var expected = ScopeResolver.Resolve(RegistryLoader.Load(NeutralScopeTown).ForEnvironment("prod"), inventory);
        var actual = ScopeResolver.Resolve(RegistryLoader.Load(copy.Path).ForEnvironment("prod"), inventory);

        Assert.Equal(("00000000-0000-0000-0000-0000000000a2", "explicit"), (actual.Pillar("bb")!.AccountId, actual.Pillar("bb")!.Via));
        Assert.Equal(JsonSerializer.Serialize(expected, Json), JsonSerializer.Serialize(actual, Json));
        Assert.Equal(RegistryLoader.Load(NeutralScopeTown).Environments.Single(e => e.Id == "prod").Scope.PillarAccounts, RegistryLoader.Load(copy.Path).Environments.Single(e => e.Id == "prod").Scope.PillarAccounts);
    }

    [Theory]
    [InlineData("pillarAccounts", "groupAccounts", "'groupAccounts' and 'pillarAccounts', which are one setting ('pillarAccounts' is the older name of 'groupAccounts')")]
    [InlineData("pillars", "groupAccounts", "'groupAccounts' and 'pillars', which are one setting ('pillars' is the older name of 'groupAccounts')")]
    [InlineData("pillars", "pillarAccounts", "'pillars' and 'pillarAccounts', which are one setting (both are older names of 'groupAccounts')")]
    public void A_scope_that_sets_two_names_of_the_groups_accounts_is_an_error_that_names_both_and_the_line(string first, string second, string says)
    {
        using var copy = new RegistryCopy(NeutralScopeTown);
        copy.Replace("environments/prod.yaml", "  groupAccounts: {", $"  {first}: {{ aa: x }}\n  {second}: {{");
        var line = copy.LineOf("environments/prod.yaml", $"  {second}:");

        Assert.Contains($"environments/prod.yaml (line {line}): scope sets both {says}. Keep one of them", Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message);
        var hit = Assert.Single(RegistryValidator.Validate(copy.Path).Findings, f => f.Message.Contains("sets both"));
        Assert.Equal((Severity.Error, "environments/prod.yaml", line), (hit.Severity, hit.File, hit.Line));
    }

    [Fact]
    public void A_problem_with_the_groups_accounts_names_the_neutral_key_whichever_was_written()
    {
        using var copy = new RegistryCopy(NeutralScopeTown);
        copy.Replace("environments/prod.yaml", "  groupAccounts: { bb:", "  pillarAccounts: { Bad_Id: x, bb:");

        Assert.Contains("scope.groupAccounts: 'Bad_Id' must be a group id (lowercase kebab-case)", Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message);
    }

    [Fact]
    public void The_environment_schema_lists_the_three_names_of_the_groups_accounts_the_neutral_one_first_and_refuses_any_two()
    {
        var scope = System.Text.Json.Nodes.JsonNode.Parse(RegistrySchema.Files(RegistryLoader.Load(TestPaths.Registry))["environment.schema.json"])!["properties"]!["scope"]!;
        var keys = scope["properties"]!.AsObject().Select(p => p.Key).ToList();
        var pairs = scope["allOf"]!.AsArray().Select(n => string.Join(",", n!["not"]!["required"]!.AsArray().Select(k => (string)k!))).ToList();

        Assert.True(keys.IndexOf("groupAccounts") >= 0 && keys.IndexOf("groupAccounts") < keys.IndexOf("pillarAccounts") && keys.IndexOf("pillarAccounts") < keys.IndexOf("pillars"));
        Assert.Contains("Older name: pillarAccounts. Azure name: pillars.", (string)scope["properties"]!["groupAccounts"]!["description"]!);
        Assert.Contains("groupAccounts,pillarAccounts", pairs);
        Assert.Contains("groupAccounts,pillars", pairs);
        Assert.Contains("pillarAccounts,pillars", pairs);
        var adapter = RegistrySchema.Files(RegistryLoader.Load(TestPaths.Registry), Adapters)["environment.schema.json"];
        Assert.Contains("producerGroup, older name producerPillar", adapter);
    }

    [Theory]
    [InlineData("producerGroup")]
    [InlineData("producerPillar")]
    public async Task A_broker_route_names_its_publishers_group_under_either_name(string name)
    {
        // routes-town's queues say who publishes them: bus.<publisher group>.<publisher service>.<reader service>.out
        static async Task<(string Json, Snapshot Snapshot)> Routes(string folder)
        {
            var registry = RegistryLoader.Load(folder, TestAdapters.Azure).ForEnvironment("prod");
            var set = Adapters.Build(registry.ActiveEnvironment!, folder);
            Assert.Empty(set.Problems);
            var state = new LatestState();
            foreach (var source in set.Sources) state.Update(source.Name, await source.PollAsync(registry, CancellationToken.None));
            var snapshot = new SnapshotBuilder(registry, state, new FakeTimeProvider(DateTimeOffset.Parse("2026-01-01T00:00:00Z"))) { Environment = "prod" }.Build();
            return (Regex.Replace(JsonSerializer.Serialize(snapshot, Json), @"\d{4}-\d\d-\d\dT[0-9:.]+\+00:00", "<time>"), snapshot);
        }
        var folder = Path.Combine(Registries, "routes-town");
        using var copy = new RegistryCopy(folder);
        copy.Replace("environments/prod.yaml", "(?<producerGroup>", $"(?<{name}>");

        var (expected, _) = await Routes(folder);
        var (actual, snapshot) = await Routes(copy.Path);

        Assert.Equal(expected, actual);
        Assert.Contains(snapshot.Groups.Single(g => g.Id == "bb").Messaging!.Subscriptions, s => s.Topic == "bus.aa.orders.ledger.out" && s.Publisher == "aa" && s.Consumer == "bb.ledger-worker");
    }

    [Theory]
    [InlineData("producerGroup")]
    [InlineData("producerPillar")]
    public void A_broker_route_without_its_publishers_service_is_an_error_under_either_name(string name)
    {
        using var copy = new RegistryCopy(Path.Combine(Registries, "routes-town"));
        copy.Replace("environments/prod.yaml", "(?<producerGroup>[a-z]+)\\.(?<producer>[a-z]+)", $"(?<{name}>[a-z]+)\\.[a-z]+");

        var hit = Assert.Single(RegistryValidator.Validate(copy.Path, Adapters).Findings, f => f.Message.Contains("a route needs both groups"));
        Assert.EndsWith($"a route needs both groups, (?<producerGroup>...) (older name producerPillar) and (?<producer>...); this match has only {name}", hit.Message);
    }
}
