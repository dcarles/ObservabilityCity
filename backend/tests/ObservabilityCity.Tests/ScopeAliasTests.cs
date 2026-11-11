using System.Text.Json;
using System.Text.RegularExpressions;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Validate;

namespace ObservabilityCity.Tests;

/// <summary>
/// The scope's keys say account (an Azure subscription, an AWS account, a GCP project) and telemetry store (on Azure, a Log Analytics workspace). They once
/// said subscription and workspace, and a file written that way must load to exactly the same town. Every test and sample town is written both ways here
/// (the neutral fixture <c>neutral-scope-town</c> and <c>messaging-town-b</c> use the neutral names, the others the Azure names) and each pair must give the
/// same rules, the same resolution and the same Config tab; one block that sets both spellings of a key is an error that names both and the line.
/// </summary>
public class ScopeAliasTests
{
    private static string Registries => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries");
    private static string NeutralTown => Path.Combine(Registries, "neutral-scope-town");

    // neutral key to Azure name, as written in an environment file; the order matters only in that a longer key goes before the key it starts with
    private static readonly (string Neutral, string Azure)[] Keys =
    [
        ("telemetryStoreId", "workspaceId"), ("telemetryStores", "workspaces"), ("telemetryStore", "workspace"),
        ("groupAccounts", "pillars"), ("accounts", "subscriptions"), ("account", "subscription"),
    ];

    /// <summary>An environment file with every scope key written the other way. Keys are matched where a key stands: after a line's indent or inside a flow mapping.</summary>
    private static string Spelt(string yaml, bool neutral)
    {
        foreach (var (n, a) in Keys)
        {
            var (from, to) = neutral ? (a, n) : (n, a);
            yaml = Regex.Replace(yaml, $@"(?<=(^|[{{,])[ \t]*){from}:(?=[ \t\r\n])", to + ":", RegexOptions.Multiline);
        }
        return neutral ? yaml.Replace("{subscriptionId}", "{accountId}") : yaml.Replace("{accountId}", "{subscriptionId}");
    }

    /// <summary>Every test and sample town with an environment that has a scope.</summary>
    public static TheoryData<string> Towns()
    {
        var data = new TheoryData<string>();
        foreach (var town in Directory.GetDirectories(Registries).Concat(Directory.GetDirectories(Path.Combine(TestPaths.RepoRoot, "config"))).Order(StringComparer.Ordinal))
            if (Directory.Exists(Path.Combine(town, "environments")) && Directory.GetFiles(Path.Combine(town, "environments"), "*.yaml").Any(f => File.ReadAllText(f).Contains("\nscope:")))
                data.Add(Path.GetRelativePath(TestPaths.RepoRoot, town));
        return data;
    }

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    /// <summary>What a town's scope comes to in each environment: its rules (links aside: their templates may spell the account id either way), the resolution against the town's recorded inventory, and every system's Config tab.</summary>
    private static string Scope(string folder)
    {
        var registry = RegistryLoader.Load(folder);
        var recording = Path.Combine(folder, "inventory.json");
        var inventory = File.Exists(recording) ? ResourceGraphInventory.FromRecording(File.ReadAllText(recording)) : null;
        var parts = new SortedDictionary<string, object?>(StringComparer.Ordinal);
        foreach (var env in registry.Environments)
        {
            var view = registry.ForEnvironment(env.Id);
            var store = new ScopeStore();
            if (inventory is not null) store.Update(inventory, DateTimeOffset.UnixEpoch);
            parts[env.Id] = new
            {
                Rules = env.Scope with { Links = [] },
                Links = env.Scope.Links.Select(l => l with { Url = l.Url.Replace("{subscriptionId}", "{accountId}") }),
                Resolution = ScopeResolver.Resolve(view, inventory),
                Config = view.AllNodes.Select(n => n.Id).Order(StringComparer.Ordinal).ToDictionary(id => id, id => ScopeInfos.Of(view, store, id)),
            };
        }
        return JsonSerializer.Serialize(parts, Json);
    }

    private static RegistryCopy SpeltCopy(string town, bool neutral)
    {
        var copy = new RegistryCopy(town);
        foreach (var file in Directory.GetFiles(Path.Combine(copy.Path, "environments"), "*.yaml"))
            File.WriteAllText(file, Spelt(File.ReadAllText(file), neutral));
        return copy;
    }

    [Theory]
    [MemberData(nameof(Towns))]
    public void A_town_loads_to_the_same_scope_whether_its_keys_are_written_with_the_neutral_or_the_azure_names(string town)
    {
        var folder = Path.Combine(TestPaths.RepoRoot, town);
        using var neutral = SpeltCopy(folder, neutral: true);
        using var azure = SpeltCopy(folder, neutral: false);

        var expected = Scope(folder);
        Assert.Equal(expected, Scope(neutral.Path));
        Assert.Equal(expected, Scope(azure.Path));
    }

    [Fact]
    public void Both_spellings_are_exercised_by_the_test_towns_and_the_other_towns_keep_the_azure_names()
    {
        string Env(string town) => File.ReadAllText(Path.Combine(TestPaths.RepoRoot, town, "environments", "prod.yaml"));
        // written with the neutral names: spelling them the Azure way changes the file
        foreach (var town in new[] { "shared-test-data/registries/neutral-scope-town", "shared-test-data/registries/messaging-town-b" })
        {
            Assert.Equal(Env(town), Spelt(Env(town), neutral: true));
            Assert.NotEqual(Env(town), Spelt(Env(town), neutral: false));
        }
        // the neutral fixture uses every key that has an Azure name, and the link variable, in its two environments
        var fixture = Env("shared-test-data/registries/neutral-scope-town") + File.ReadAllText(Path.Combine(NeutralTown, "environments", "staging.yaml"));
        foreach (var (key, _) in Keys) Assert.Matches($@"(?m)(^|[{{,])[ \t]*{key}:", fixture);
        Assert.Contains("{accountId}", fixture);
        // the other test towns keep the Azure names (the sample towns have no scope)
        foreach (var town in new[] { "shared-test-data/registries/scope-town-a", "shared-test-data/registries/scope-town-b", "shared-test-data/registries/function-town-a" })
            Assert.NotEqual(Env(town), Spelt(Env(town), neutral: true));
    }

    [Fact]
    public void The_neutral_fixture_resolves_every_key_it_names()
    {
        // so the comparison above compares something: each neutral key does its job in the fixture
        var registry = RegistryLoader.Load(NeutralTown).ForEnvironment("prod");
        var r = ScopeResolver.Resolve(registry, ResourceGraphInventory.FromRecording(File.ReadAllText(Path.Combine(NeutralTown, "inventory.json"))));

        Assert.Empty(r.Problems);
        Assert.Equal(("00000000-0000-0000-0000-0000000000a1", "name"), (r.Pillar("aa")!.AccountId, r.Pillar("aa")!.Via)); // account
        Assert.Equal(("00000000-0000-0000-0000-0000000000a2", "explicit"), (r.Pillar("bb")!.AccountId, r.Pillar("bb")!.Via)); // groupAccounts
        Assert.Equal(("logs-prd-*", "00000000-0000-0000-0000-00000000beef", "name"), (r.TelemetryStore, r.TelemetryStoreId, r.TelemetryStoreVia)); // telemetryStore, looked up
        Assert.Equal("gw-gateway", Assert.Single(r.System("hub.gateway")!.Resources).Name); // a resource rule's own account
        Assert.Contains(r.AssetList, a => a.PillarId == AssetRule.HubIsland && a.Name == "logs-prd-main" && a.AccountId == "00000000-0000-0000-0000-0000000000f1"); // an asset rule's own account
        var staging = ScopeResolver.Resolve(RegistryLoader.Load(NeutralTown).ForEnvironment("staging"), null);
        Assert.Equal(("logs-stg-main", "00000000-0000-0000-0000-00000000cafe", "id"), (staging.TelemetryStore, staging.TelemetryStoreId, staging.TelemetryStoreVia)); // telemetryStoreId
        var rules = registry.ActiveEnvironment!.Scope;
        Assert.Equal(("accounts | project id, name, tags", "stores | project id, name, customerId"), (rules.Queries.Accounts, rules.Queries.TelemetryStores));

        var store = new ScopeStore();
        store.Update(ResourceGraphInventory.FromRecording(File.ReadAllText(Path.Combine(NeutralTown, "inventory.json"))), DateTimeOffset.UnixEpoch);
        var info = ScopeInfos.Of(registry, store, "aa.orders-api")!;
        Assert.Equal(("aa-prd-main", "name", "logs-prd-*", "name"), (info.Subscription, info.SubscriptionVia, info.Workspace, info.WorkspaceVia));
        Assert.Contains(info.Resources.SelectMany(x => x.Links ?? []), l => l.Url == "https://console.example.test/accounts/00000000-0000-0000-0000-0000000000a1/resources/orders-api-east?env=prod");
    }

    // ---- both spellings on one block ----

    /// <summary>Where to add the other spelling in the fixture's environment file, the key it adds, the block and the key it clashes with.</summary>
    public static TheoryData<string, string, string, string, string> BothSet() => new()
    {
        { "  telemetryStore: \"logs-{env}-*\"", "  telemetryStore: \"logs-{env}-*\"\n  workspace: \"logs-other\"", "workspace:", "scope", "telemetryStore" },
        { "  telemetryStore: \"logs-{env}-*\"", "  telemetryStore: \"logs-{env}-*\"\n  workspaceId: \"00000000-0000-0000-0000-000000000001\"\n  telemetryStoreId: \"00000000-0000-0000-0000-000000000002\"", "telemetryStoreId:", "scope", "telemetryStoreId" },
        { "  account: { nameLike: \"{pillar}-{env}-*\" }", "  subscription: { nameLike: \"x-*\" }\n  account: { nameLike: \"{pillar}-{env}-*\" }", "  account:", "scope", "account" },
        { "  groupAccounts: {", "  pillars: { aa: x }\n  groupAccounts: {", "  groupAccounts:", "scope", "groupAccounts" },
        { "    accounts: \"accounts | project id, name, tags\"", "    accounts: \"accounts | project id, name, tags\"\n    subscriptions: \"other\"", "subscriptions:", "scope.queries", "accounts" },
        { "    telemetryStores: \"stores | project id, name, customerId\"", "    workspaces: \"other\"\n    telemetryStores: \"stores | project id, name, customerId\"", "telemetryStores:", "scope.queries", "telemetryStores" },
        { "account: { tag: { key: unit, value: platform } } }\n    - { name: apps", "account: { tag: { key: unit, value: platform } }, subscription: { nameLike: \"x\" } }\n    - { name: apps", "name: gateways", "scope.resources 'gateways'", "account" },
        { "island: hub, group: Telemetry, account:", "island: hub, group: Telemetry, subscription: { nameLike: \"x\" }, account:", "name: shared-logs", "scope.assets 'shared-logs'", "account" },
    };

    [Theory]
    [MemberData(nameof(BothSet))]
    public void A_block_that_sets_a_key_and_its_azure_name_is_an_error_that_names_both_and_the_line(string old, string replacement, string lineOf, string block, string neutral)
    {
        using var copy = new RegistryCopy(NeutralTown);
        copy.Replace("environments/prod.yaml", old, replacement);
        var alias = Keys.Single(k => k.Neutral == neutral).Azure;

        var message = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;

        Assert.Contains($"environments/prod.yaml (line {copy.LineOf("environments/prod.yaml", lineOf)}): {block} sets both '{neutral}' and '{alias}', which are one setting ('{alias}' is the older name of '{neutral}'). Keep one of them", message);
    }

    [Fact]
    public void The_validator_reports_both_spellings_on_one_block_at_their_line()
    {
        using var copy = new RegistryCopy(NeutralTown);
        copy.Replace("environments/prod.yaml", "  telemetryStore: \"logs-{env}-*\"", "  telemetryStore: \"logs-{env}-*\"\n  workspace: \"logs-other\"");

        var hit = Assert.Single(RegistryValidator.Validate(copy.Path).Findings, f => f.Message.Contains("sets both"));

        Assert.Equal(Severity.Error, hit.Severity);
        Assert.Equal("environments/prod.yaml", hit.File);
        Assert.Equal(copy.LineOf("environments/prod.yaml", "workspace:"), hit.Line);
        Assert.Contains("'telemetryStore' and 'workspace'", hit.Message);
    }

    [Fact]
    public void The_same_key_twice_and_an_unknown_key_read_as_they_did_before()
    {
        // an unknown key in a block that takes aliases is reported like any other, with the neutral key as the hint
        using (var copy = new RegistryCopy(NeutralTown))
        {
            copy.Replace("environments/prod.yaml", "  account: {", "  acount: {");
            Assert.Contains($"environments/prod.yaml (line {copy.LineOf("environments/prod.yaml", "acount:")}): unknown key 'acount'. Did you mean 'account'?", Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message);
        }
        using (var copy = new RegistryCopy(NeutralTown))
        {
            copy.Replace("environments/prod.yaml", "    accounts: \"", "    acounts: \"");
            Assert.Contains("unknown key 'acounts'", Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message);
        }
        // the old names are suggested too, for a file written with them
        using (var copy = new RegistryCopy(Path.Combine(Registries, "scope-town-a")))
        {
            copy.Replace("environments/prod.yaml", "  workspace:", "  workspce:");
            Assert.Contains("unknown key 'workspce'. Did you mean 'workspace'?", Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message);
        }
    }

    [Fact]
    public void The_problems_the_scope_reports_use_the_neutral_words()
    {
        using var copy = new RegistryCopy(NeutralTown);
        copy.Replace("environments/prod.yaml", "  telemetryStore: \"logs-{env}-*\"", "  telemetryStore: \"nothing-*\"");
        copy.Replace("environments/prod.yaml", "  account: { nameLike: \"{pillar}-{env}-*\" }", "  account: { nameLike: \"none-*\" }");
        var r = ScopeResolver.Resolve(RegistryLoader.Load(copy.Path).ForEnvironment("prod"), ResourceGraphInventory.FromRecording(copy.Read("inventory.json")));

        Assert.Contains("No telemetry store is named 'nothing-*'. Check scope.telemetryStore, or give the store's id under scope.telemetryStoreId.", r.Problems);
        Assert.Contains("Pillar 'aa': no account has name like 'none-*'. Check scope.account, or name the account under scope.groupAccounts.", r.Problems);
        Assert.All(r.Problems, p => Assert.DoesNotMatch("(?i)subscription|workspace", p));
    }

    // ---- schema and docs ----

    /// <summary>What the schema and the docs call an alias: pillarAccounts is the older (pillar) name of groupAccounts (see <see cref="GroupAliasTests"/>), every other alias an Azure name.</summary>
    private static string NameOf(string alias) => alias == GroupWords.OlderGroupAccounts ? "Older name" : "Azure name";

    /// <summary>Every block of the scope that takes aliases, with its aliases. The group file's own alias (pillar for group) is proven by <see cref="GroupAliasTests"/>.</summary>
    private static IEnumerable<(string Type, IReadOnlyDictionary<string, string> Aliases)> Blocks() =>
        typeof(RegistryLoader).Assembly.GetTypes().Where(t => !t.IsAbstract && t.IsSubclassOf(typeof(AliasedBlock)) && t != typeof(PillarFile))
            .Select(t => (t.Name, ((AliasedBlock)Activator.CreateInstance(t, nonPublic: true)!).Aliases));

    [Fact]
    public void The_environment_schema_lists_both_spellings_of_each_key_the_neutral_one_first()
    {
        var scope = System.Text.Json.Nodes.JsonNode.Parse(RegistrySchema.Files(RegistryLoader.Load(TestPaths.Registry))["environment.schema.json"])!["properties"]!["scope"]!;
        var where = new Dictionary<string, System.Text.Json.Nodes.JsonNode>
        {
            ["ScopeFile"] = scope["properties"]!,
            ["ScopeQueriesFile"] = scope["properties"]!["queries"]!["properties"]!,
            ["ResourceRuleFile"] = scope["properties"]!["resources"]!["items"]!["properties"]!,
            ["AssetRuleFile"] = scope["properties"]!["assets"]!["items"]!["properties"]!,
        };
        var blocks = Blocks().ToList();
        Assert.Equal(where.Keys.Order(), blocks.Select(b => b.Type).Order());
        foreach (var (type, aliases) in blocks)
        {
            var keys = where[type].AsObject().Select(p => p.Key).ToList();
            foreach (var (alias, neutral) in aliases)
            {
                Assert.True(keys.IndexOf(neutral) >= 0 && keys.IndexOf(neutral) < keys.IndexOf(alias), $"{type}: '{neutral}' must come before its older name '{alias}' in the schema");
                Assert.Contains($"{NameOf(alias)}: {alias}", (string)where[type][neutral]!["description"]!);
            }
        }
    }

    [Fact]
    public void The_config_reference_gives_each_neutral_key_its_azure_name()
    {
        var doc = File.ReadAllText(Path.Combine(TestPaths.RepoRoot, "docs", "config-reference.md")).ReplaceLineEndings("\n");
        foreach (var (type, aliases) in Blocks())
        {
            var table = Regex.Match(doc, $@"<!-- file: {type} -->\n((?:\|.*\n?)+)").Groups[1].Value;
            foreach (var (alias, neutral) in aliases)
                Assert.Matches($@"(?m)^\| `{neutral}` \|.*{NameOf(alias)}: `{alias}`", table);
        }
    }
}

