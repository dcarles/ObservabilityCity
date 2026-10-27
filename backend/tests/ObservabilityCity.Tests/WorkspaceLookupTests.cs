using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 2, slice 5: a Log Analytics workspace is given by its name (or a wildcard pattern), which the inventory looks up through Resource Graph, or by its
/// id, which is used as it is. When both are given the id wins and nothing is looked up. The name is the readable way and fits the rest of the files; the id
/// is the way to pin one workspace outright.
/// </summary>
public class WorkspaceLookupTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-b");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
    private const string ProdWorkspace = "00000000-0000-0000-0000-00000000c0de"; // the id the town A recording gives ws-prd-main
    private const string Pinned = "00000000-0000-0000-0000-00000000beef";

    private static TownRegistry Prod(string folder) => RegistryLoader.Load(folder).ForEnvironment("prod");

    /// <summary>The scope of a town after its inventory source has replayed its recording.</summary>
    private static async Task<(Resolution Resolution, ScopeStore Store, TownRegistry Registry)> Resolved(string folder)
    {
        var registry = Prod(folder);
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, folder);
        await set.Sources.Single(s => s.Name == "inventory").PollAsync(registry, CancellationToken.None);
        return (set.Scope!.Resolve(registry), set.Scope, registry);
    }

    [Fact]
    public async Task A_name_is_looked_up_in_the_inventory_and_gives_the_workspace_id()
    {
        var (resolution, _, _) = await Resolved(TownA); // scope.workspace: "ws-{env}-main"

        Assert.Equal("ws-prd-main", resolution.Workspace);
        Assert.Equal(ProdWorkspace, resolution.WorkspaceId);
        Assert.Equal("name", resolution.WorkspaceVia);
        Assert.DoesNotContain(resolution.Problems, p => p.Contains("workspace"));
    }

    [Fact]
    public async Task A_pattern_finds_the_one_workspace_it_matches()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "workspace: \"ws-{env}-main\"", "workspace: \"ws-p*-main\"");

        var (resolution, _, _) = await Resolved(copy.Path);

        Assert.Equal(ProdWorkspace, resolution.WorkspaceId);
        Assert.Equal("name", resolution.WorkspaceVia);
    }

    [Fact]
    public async Task A_pattern_that_matches_two_workspaces_settles_nothing_and_names_them()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "workspace: \"ws-{env}-main\"", "workspace: \"ws-*-main\"");

        var (resolution, _, _) = await Resolved(copy.Path);

        Assert.Null(resolution.WorkspaceId);
        var problem = Assert.Single(resolution.Problems, p => p.Contains("Log Analytics workspaces match"));
        Assert.Contains("2 Log Analytics workspaces match 'ws-*-main' (ws-prd-main, ws-stg-main)", problem);
        Assert.Contains("scope.workspaceId", problem);
    }

    [Fact]
    public async Task A_name_no_workspace_has_settles_nothing_and_says_so()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "workspace: \"ws-{env}-main\"", "workspace: \"ws-{env}-missing\"");

        var (resolution, _, _) = await Resolved(copy.Path);

        Assert.Null(resolution.WorkspaceId);
        Assert.Contains("No Log Analytics workspace is named 'ws-prd-missing'", Assert.Single(resolution.Problems, p => p.Contains("workspace")));
    }

    [Fact]
    public async Task An_explicit_id_wins_over_a_name_that_would_have_found_another_workspace()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "  workspace: \"ws-{env}-main\"", $"  workspace: \"ws-{{env}}-main\"\n  workspaceId: \"{Pinned}\"");

        var (resolution, _, _) = await Resolved(copy.Path);

        Assert.Equal(Pinned, resolution.WorkspaceId);
        Assert.Equal("id", resolution.WorkspaceVia);
        Assert.Equal("ws-prd-main", resolution.Workspace); // the name is still what people read
        Assert.All(resolution.Systems, s => Assert.Equal("ws-prd-main", s.Workspace));
    }

    [Fact]
    public async Task An_id_written_as_the_workspace_is_used_as_it_is()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "workspace: \"ws-{env}-main\"", $"workspace: \"{Pinned}\"");

        var (resolution, _, _) = await Resolved(copy.Path);

        Assert.Equal(Pinned, resolution.WorkspaceId);
        Assert.Equal("id", resolution.WorkspaceVia);
    }

    [Fact]
    public async Task Town_B_gives_an_id_outright_and_has_nothing_to_look_up()
    {
        var (resolution, _, _) = await Resolved(TownB);

        Assert.Equal("law-live-prod", resolution.Workspace);
        Assert.Equal(ProdWorkspace, resolution.WorkspaceId);
        Assert.Equal("id", resolution.WorkspaceVia);
    }

    [Fact]
    public async Task The_inspector_is_told_how_the_workspace_was_settled()
    {
        var (_, storeA, registryA) = await Resolved(TownA);
        var (_, storeB, registryB) = await Resolved(TownB);

        Assert.Equal("name", ScopeInfos.Of(registryA, storeA, "aa.orders-api")!.WorkspaceVia);
        Assert.Equal("id", ScopeInfos.Of(registryB, storeB, "aa.orders-api")!.WorkspaceVia);
    }

    // ---- the query that uses it ----

    [Fact]
    public async Task The_workspace_is_queried_by_the_id_the_name_was_looked_up_to()
    {
        var (_, store, registry) = await Resolved(TownA);
        var env = registry.ActiveEnvironment!;
        var http = CannedHttp.Always(File.ReadAllText(Path.Combine(TownA, "telemetry.json")));
        var definition = env.Sources.Single(s => s.Name == "telemetry") with { Connection = null };
        var source = new LogAnalyticsSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(new SourceContext("prod", definition, null, env.Scope, store, TownA));

        await source.PollAsync(registry, CancellationToken.None);

        Assert.Equal($"https://api.loganalytics.io/v1/workspaces/{ProdWorkspace}/query", Assert.Single(http.Sent).Uri!.ToString());
    }

    [Fact]
    public async Task Before_the_inventory_is_read_the_name_is_a_wait_that_says_so_and_nothing_is_sent()
    {
        var registry = Prod(TownA);
        var env = registry.ActiveEnvironment!;
        var http = CannedHttp.Always("{}");
        var definition = env.Sources.Single(s => s.Name == "telemetry") with { Connection = null };
        var source = new LogAnalyticsSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(new SourceContext("prod", definition, null, env.Scope, new ScopeStore(), TownA));

        var e = await Assert.ThrowsAsync<InvalidOperationException>(() => source.PollAsync(registry, CancellationToken.None));

        Assert.Contains("'ws-prd-main' is a name and has no workspace id yet", e.Message);
        Assert.Contains("has not been read yet", e.Message);
        Assert.Empty(http.Sent);
    }

    [Fact]
    public async Task A_name_no_workspace_has_stops_the_query_with_the_reason()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "workspace: \"ws-{env}-main\"", "workspace: \"ws-{env}-missing\"");
        var (_, store, registry) = await Resolved(copy.Path);
        var env = registry.ActiveEnvironment!;
        var http = CannedHttp.Always("{}");
        var definition = env.Sources.Single(s => s.Name == "telemetry") with { Connection = null };
        var source = new LogAnalyticsSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(new SourceContext("prod", definition, null, env.Scope, store, copy.Path));

        var e = await Assert.ThrowsAsync<InvalidOperationException>(() => source.PollAsync(registry, CancellationToken.None));

        Assert.Contains("No Log Analytics workspace is named 'ws-prd-missing'", e.Message);
        Assert.Empty(http.Sent);
    }

    // ---- the lookup itself ----

    private static (ResourceGraphInventory Reader, List<string> Queries) Reading(ScopeRules rules, Func<string, object> rowsFor)
    {
        var queries = new List<string>();
        var http = new CannedHttp().Respond(r =>
        {
            var query = r.Json.GetProperty("query").GetString()!;
            queries.Add(query);
            return CannedHttp.Reply(JsonSerializer.Serialize(new { data = rowsFor(query) }));
        });
        return (new ResourceGraphInventory(new HttpClient(http), new StaticLogin(), new RegistrySource("inventory", "resourcegraph", null), rules), queries);
    }

    private static object Answer(string query) =>
        query.Contains("operationalinsights")
            ? new object[] { new { id = "/subscriptions/s/resourceGroups/rg/providers/microsoft.operationalinsights/workspaces/ws-prd-main", name = "ws-prd-main", customerId = ProdWorkspace } }
            : query.StartsWith("resourcecontainers") ? new object[] { new { id = "00000000-0000-0000-0000-0000000000a1", name = "acme-eu-prd-al", tags = new { } } } : Array.Empty<object>();

    [Fact]
    public async Task The_inventory_asks_for_workspaces_when_the_workspace_is_a_name_and_reads_their_ids()
    {
        var rules = Prod(TownA).ActiveEnvironment!.Scope;
        var (reader, queries) = Reading(rules, Answer);

        var inventory = await reader.ReadAsync(Prod(TownA), CancellationToken.None);

        Assert.Equal(ResourceGraphInventory.DefaultWorkspacesQuery, queries.Single(q => q.Contains("operationalinsights")));
        var workspace = Assert.Single(inventory.Workspaces!);
        Assert.Equal(("ws-prd-main", ProdWorkspace), (workspace.Name, workspace.CustomerId));
    }

    [Theory]
    [InlineData("id")]
    [InlineData("workspace-is-an-id")]
    public async Task The_inventory_does_not_ask_for_workspaces_when_an_id_is_all_there_is_to_know(string how)
    {
        var rules = Prod(TownA).ActiveEnvironment!.Scope;
        rules = how == "id" ? rules with { WorkspaceId = Pinned } : rules with { Workspace = Pinned };
        var (reader, queries) = Reading(rules, Answer);

        var inventory = await reader.ReadAsync(Prod(TownA), CancellationToken.None);

        Assert.DoesNotContain(queries, q => q.Contains("operationalinsights"));
        Assert.Null(inventory.Workspaces); // not asked is not the same as none found
        Assert.False(ResourceGraphInventory.NeedsWorkspaceLookup(rules));
    }

    [Fact]
    public async Task The_workspaces_query_can_be_replaced_by_the_environment()
    {
        var rules = Prod(TownA).ActiveEnvironment!.Scope with { Queries = new ScopeQueries(null, null, "resources | where type =~ 'x/workspaces' | project id, name, customerId = tostring(properties.workspaceId)") };
        var (reader, queries) = Reading(rules, q => q.Contains("x/workspaces") ? new object[] { new { id = "i", name = "ws-prd-main", customerId = Pinned } } : Answer(q));

        var inventory = await reader.ReadAsync(Prod(TownA), CancellationToken.None);

        Assert.Contains(queries, q => q.Contains("properties.workspaceId"));
        Assert.Equal(Pinned, Assert.Single(inventory.Workspaces!).CustomerId);
    }

    [Fact]
    public async Task A_workspace_the_answer_gives_no_workspace_id_for_is_queried_by_its_resource_id()
    {
        var inventory = new Inventory([], [], [new InventoryWorkspace("/subscriptions/s/resourceGroups/rg/providers/microsoft.operationalinsights/workspaces/ws-prd-main", "ws-prd-main", null)]);
        var (_, store, registry) = await Resolved(TownA);
        store.Update(inventory, T0);

        var resolution = store.Resolve(registry);

        Assert.Equal("/subscriptions/s/resourceGroups/rg/providers/microsoft.operationalinsights/workspaces/ws-prd-main", resolution.WorkspaceId);
    }

    // ---- the files ----

    [Fact]
    public void The_workspace_id_is_a_template_over_the_environments_words_and_may_not_be_empty()
    {
        using var copy = new RegistryCopy(TownA);
        copy.Replace("environments/prod.yaml", "  workspace: \"ws-{env}-main\"", "  workspace: \"ws-{env}-main\"\n  workspaceId: \"{nope}\"");
        var unknown = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;
        copy.Replace("environments/prod.yaml", "workspaceId: \"{nope}\"", "workspaceId: \" \"");
        var empty = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;

        Assert.Contains("scope.workspaceId: {nope} is not a variable here", unknown);
        Assert.Contains("scope.workspaceId is empty", empty);
    }
}
