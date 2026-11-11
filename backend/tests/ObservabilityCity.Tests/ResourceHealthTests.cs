using System.Net;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 3b: the cloud's own word on a resource's health (Degraded, Unavailable) reaches the town as an incident of the building that owns the resource. The events come from the
/// activity log's resource-health entries, a resource is let go when the cloud resolves it or says it is available again, and the program names no provider, resource or tag:
/// two towns with differently named sources, accounts, tags and look-back read the same recorded events and show the same incidents.
/// </summary>
public class ResourceHealthTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "health-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "health-town-b");
    private static readonly DateTimeOffset T1 = DateTimeOffset.Parse("2026-01-01T01:00:00Z");

    private static string SourceName(string town) => town == "a" ? "health" : "azure-health";
    private static string Folder(string town) => town == "a" ? TownA : TownB;

    private sealed record Rig(SourceSet Set, TownRegistry Registry, IHealthEventSource Health, SnapshotBuilder Builder);

    /// <summary>A town as the host runs it: the inventory read once, then the health source polled, then a builder over both.</summary>
    private static async Task<Rig> Run(string folder, string sourceName, IReadOnlyCollection<IHealthEventSource>? healthSources = null, TownRegistry? registry = null)
    {
        registry ??= RegistryLoader.Load(folder, TestAdapters.Azure).ForEnvironment("prod");
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, folder);
        Assert.Empty(set.Problems);
        foreach (var source in set.Sources.Where(s => s.Name == "inventory" || s.Name == sourceName)) await source.PollAsync(registry, CancellationToken.None);
        var health = healthSources ?? set.Sources.OfType<IHealthEventSource>().ToList();
        var builder = new SnapshotBuilder(registry, new LatestState(), new FakeTimeProvider(T1)) { Environment = "prod", ScopeSource = set.Scope, HealthSources = health.ToList() };
        return new Rig(set, registry, set.Sources.OfType<IHealthEventSource>().Single(), builder);
    }

    // ---- reading the log ----

    private static HealthLogEntry Entry(string resource, string at, string step, string? current, string? previous = "Available", string? cause = "Unknown", string? title = null) =>
        new(resource, DateTimeOffset.Parse(at), $"Microsoft.Resourcehealth/healthevent/{step}/action", current, previous, cause, title);

    [Fact]
    public void An_activation_opens_an_event_with_what_the_cloud_said()
    {
        var open = ResourceHealthLog.Open([Entry("/subscriptions/s/providers/p/accounts/db1", "2026-01-01T00:50:00Z", "Activated", "Degraded", "Available", "Unknown", "Account is degraded")]);

        var e = Assert.Single(open);
        Assert.Equal("Degraded", e.State);
        Assert.Equal("Available", e.Previous);
        Assert.Equal("Unknown", e.Cause);
        Assert.Equal("Account is degraded", e.Summary);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:50:00Z"), e.Since);
        Assert.Equal("db1", e.ResourceName);
    }

    [Fact]
    public void A_resolution_closes_the_event_and_a_later_activation_opens_a_new_one()
    {
        const string db = "/subscriptions/s/providers/p/accounts/db1";
        var resolved = ResourceHealthLog.Open([Entry(db, "2026-01-01T00:10:00Z", "Activated", "Degraded"), Entry(db, "2026-01-01T00:20:00Z", "Resolved", "Available", "Degraded")]);
        Assert.Empty(resolved);

        var again = ResourceHealthLog.Open([Entry(db, "2026-01-01T00:10:00Z", "Activated", "Degraded"), Entry(db, "2026-01-01T00:20:00Z", "Resolved", "Available", "Degraded"), Entry(db, "2026-01-01T00:30:00Z", "Activated", "Unavailable")]);
        var e = Assert.Single(again);
        Assert.Equal("Unavailable", e.State);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:30:00Z"), e.Since); // a new event, not the old one come back
    }

    [Fact]
    public void An_update_keeps_the_event_that_began_at_the_first_activation_and_takes_the_newest_state()
    {
        const string db = "/subscriptions/s/providers/p/accounts/db1";

        var e = Assert.Single(ResourceHealthLog.Open([
            Entry(db, "2026-01-01T00:10:00Z", "Activated", "Degraded", "Available", "Unknown"),
            Entry(db, "2026-01-01T00:45:00Z", "Updated", "Unavailable", "Degraded", "UserInitiated")]));

        Assert.Equal("Unavailable", e.State);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:10:00Z"), e.Since);
        Assert.Equal("Available", e.Previous); // what it was before the trouble began
        Assert.Equal("UserInitiated", e.Cause);
    }

    [Theory]
    [InlineData("Available")]
    [InlineData("Unknown")]
    [InlineData(null)]
    public void A_state_that_is_not_trouble_opens_nothing(string? state)
    {
        Assert.Empty(ResourceHealthLog.Open([Entry("/subscriptions/s/providers/p/accounts/db1", "2026-01-01T00:10:00Z", "Activated", state)]));
    }

    [Fact]
    public void Resource_ids_match_whatever_their_case_and_the_event_keeps_one_id_for_as_long_as_it_lasts()
    {
        var upper = ResourceHealthLog.Open([Entry("/SUBSCRIPTIONS/S/PROVIDERS/P/ACCOUNTS/DB1", "2026-01-01T00:10:00Z", "Activated", "Degraded"), Entry("/subscriptions/s/providers/p/accounts/db1", "2026-01-01T00:40:00Z", "Updated", "Degraded")]);
        var later = ResourceHealthLog.Open([Entry("/SUBSCRIPTIONS/S/PROVIDERS/P/ACCOUNTS/DB1", "2026-01-01T00:10:00Z", "Activated", "Degraded"), Entry("/subscriptions/s/providers/p/accounts/db1", "2026-01-01T00:50:00Z", "Updated", "Degraded")]);

        Assert.Single(upper);
        Assert.Equal(upper[0].Id, later[0].Id);
    }

    [Fact]
    public void Only_resource_health_entries_are_read_and_the_next_page_is_found()
    {
        const string json = """
            { "value": [
                { "category": { "value": "Administrative" }, "eventTimestamp": "2026-01-01T00:10:00Z", "operationName": { "value": "x/write" }, "resourceId": "/subscriptions/s/providers/p/accounts/db1" },
                { "category": { "value": "ResourceHealth" }, "eventTimestamp": "2026-01-01T00:11:00Z", "operationName": { "value": "Microsoft.Resourcehealth/healthevent/Activated/action" },
                  "resourceId": "/subscriptions/s/providers/p/accounts/db2", "properties": { "currentHealthStatus": "Degraded", "previousHealthStatus": "Available", "cause": "Unknown", "title": "Slow" } } ],
              "nextLink": "https://management.azure.com/next?page=2" }
            """;

        var (entries, next) = ResourceHealthLog.Parse(json);

        var entry = Assert.Single(entries);
        Assert.Equal("Degraded", entry.Current);
        Assert.Equal("Slow", entry.Summary);
        Assert.Equal("https://management.azure.com/next?page=2", next);
        Assert.Null(ResourceHealthLog.Parse("""{ "value": [] }""").NextLink);
        Assert.Throws<InvalidOperationException>(() => ResourceHealthLog.Parse("""{ "oops": 1 }"""));
    }

    [Fact]
    public void The_calls_ask_for_one_provider_since_the_start_of_the_window()
    {
        var activity = new Uri(ResourceHealthLog.ActivityUrl("sub-1", "Namespace.Service", DateTimeOffset.Parse("2026-01-01T00:00:00Z")));
        Assert.Equal("/subscriptions/sub-1/providers/microsoft.insights/eventtypes/management/values", activity.AbsolutePath);
        Assert.Contains("api-version=2015-04-01", activity.Query);
        Assert.Contains("eventTimestamp ge '2026-01-01T00:00:00Z' and resourceProvider eq 'Namespace.Service'", Uri.UnescapeDataString(activity.Query));

        var status = new Uri(ResourceHealthLog.StatusUrl("/subscriptions/s/providers/p/accounts/db1/"));
        Assert.Equal("/subscriptions/s/providers/p/accounts/db1/providers/Microsoft.ResourceHealth/availabilityStatuses/current", status.AbsolutePath);
        Assert.Equal("Degraded", ResourceHealthLog.ParseAvailability("""{ "properties": { "availabilityState": "Degraded" } }"""));
        Assert.Null(ResourceHealthLog.ParseAvailability("""{ "properties": {} }"""));
    }

    // ---- the source, from a recording ----

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task The_open_events_are_those_the_cloud_has_not_resolved_and_still_says_are_trouble(string town)
    {
        var rig = await Run(Folder(town), SourceName(town));

        var events = rig.Health.Current().Where(e => e.State != "Resolved").OrderBy(e => e.Since).ToList();
        Assert.Single(rig.Health.Current(), e => e.State == "Resolved"); // Acme's, listed as resolved

        // Acme's was resolved, Cygnus's log says unavailable but the cloud says it is available now, one entry says Unknown, and one entry is not a health entry at all
        Assert.Equal(["Unavailable", "Degraded", "Degraded"], events.Select(e => e.State)); // by when they began: the ledger account (unavailable by its newest entry), the orders account, the one no system owns
        Assert.Equal(3, events.Count);
        Assert.Null(rig.Health.Problem);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task Each_event_belongs_to_the_building_that_owns_the_resource_and_two_differently_shaped_towns_agree(string town)
    {
        var rig = await Run(Folder(town), SourceName(town));

        var snapshot = rig.Builder.Build();

        var events = snapshot.HealthEvents!;
        Assert.Equal(4, events.Count);
        // worst first: the ledger account, unavailable; then the older degraded one (the orders account), then the one no system owns; the resolved one (Acme's, on the orders store too) last
        Assert.Equal(["Unavailable", "Degraded", "Degraded", "Resolved"], events.Select(e => e.State));
        Assert.Equal(["bb.ledger-db", "aa.orders-db", null, "aa.orders-db"], events.Select(e => e.NodeId));
        Assert.Equal(["bb", "aa", null, "aa"], events.Select(e => e.GroupId));
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:40:00Z"), events[3].ResolvedAt);
        var ledger = events[0];
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:10:00Z"), ledger.Since); // started at the first activation, not at the update
        Assert.Equal("Available", ledger.Previous);
        Assert.Equal("UserInitiated", ledger.Cause);
        Assert.Equal("Unknown", events[1].Cause);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:50:15Z").ToUnixTimeSeconds(), events[1].Since.ToUnixTimeSeconds()); // the orders account
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task The_names_come_from_the_inventory_not_from_the_shouting_ids_the_cloud_sends(string town)
    {
        var rig = await Run(Folder(town), SourceName(town));

        var orders = rig.Builder.Build().HealthEvents!.Single(e => e.NodeId == "aa.orders-db" && e.State != "Resolved");

        Assert.Equal(town == "a" ? "22222222222222222222222222222222-al-ord" : "cosmos-orders-borealis", orders.Resource);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task An_event_of_a_store_kept_per_tenant_says_which_tenant_by_its_friendly_name_and_one_no_system_owns_says_none(string town)
    {
        var rig = await Run(Folder(town), SourceName(town));

        var events = rig.Builder.Build().HealthEvents!;

        var orders = events.Single(e => e.NodeId == "aa.orders-db" && e.State != "Resolved");
        Assert.False(string.IsNullOrEmpty(orders.Tenant));
        Assert.DoesNotMatch("^[0-9a-f]{32}$", orders.Tenant!); // the name the scope found on the resource, not the id
        Assert.Null(events.Single(e => e.NodeId is null).Tenant);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task The_events_are_open_incidents_in_the_count_and_the_islands_they_belong_to_are_not_incident_free(string town)
    {
        var rig = await Run(Folder(town), SourceName(town));

        var snapshot = rig.Builder.Build();

        Assert.Equal(3, snapshot.Totals.Incidents);
        Assert.Null(snapshot.IncidentFreeSince);
        Assert.True(snapshot.IncidentsSeen);
        Assert.All(snapshot.Groups, g => Assert.Empty(g.Incidents)); // they are not the incident tool's incidents; the list shows them beside them
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task An_island_filter_keeps_the_events_of_the_islands_on_screen_and_those_no_building_owns(string town)
    {
        var rig = await Run(Folder(town), SourceName(town));

        var snapshot = rig.Builder.Build(["aa"]);

        Assert.Equal(["aa.orders-db", null, "aa.orders-db"], snapshot.HealthEvents!.Select(e => e.NodeId));
        Assert.Equal(2, snapshot.Totals.Incidents);
    }

    [Fact]
    public async Task A_town_with_no_health_source_has_none_and_is_not_changed()
    {
        var registry = RegistryLoader.Load(Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a"), TestAdapters.Azure).ForEnvironment("prod");
        var builder = new SnapshotBuilder(registry, new LatestState(), new FakeTimeProvider(T1)) { Environment = "prod" };

        var snapshot = builder.Build();

        Assert.Null(snapshot.HealthEvents);
        Assert.Equal(0, snapshot.Totals.Incidents);
        await Task.CompletedTask;
    }

    [Fact]
    public async Task A_resolution_in_a_later_answer_removes_the_marker_with_nothing_else_changing()
    {
        using var copy = new TownFiles(TownA);
        var registry = copy.Load("prod");
        var rig = await Run(copy.Path, "health", registry: registry);
        Assert.Contains(rig.Builder.Build().HealthEvents!, e => e.NodeId == "aa.orders-db");

        // the cloud resolves the orders account and reports it available
        var recording = File.ReadAllText(copy.FilePath("health.json"));
        const string borealis = "22222222222222222222222222222222-AL-ORD";
        var entry = """{"category":{"value":"ResourceHealth"},"eventTimestamp":"2026-01-01T00:58:00Z","operationName":{"value":"Microsoft.Resourcehealth/healthevent/Resolved/action"},"resourceId":"/SUBSCRIPTIONS/00000000-0000-0000-0000-0000000000A1/RESOURCEGROUPS/RG/PROVIDERS/MICROSOFT.DOCUMENTDB/DATABASEACCOUNTS/22222222222222222222222222222222-AL-ORD","properties":{"currentHealthStatus":"Available","previousHealthStatus":"Degraded"}},""";
        Assert.Contains(borealis, recording, StringComparison.OrdinalIgnoreCase);
        copy.Write("health.json", recording.Replace("\"value\": [", "\"value\": [" + entry, StringComparison.Ordinal).Replace("\"22222222222222222222222222222222-al-ord\": \"Degraded\"", "\"22222222222222222222222222222222-al-ord\": \"Available\""));
        await rig.Set.Sources.Single(s => s.Name == "health").PollAsync(registry, CancellationToken.None);

        Assert.DoesNotContain(rig.Builder.Build().HealthEvents!, e => e.NodeId == "aa.orders-db" && e.State != "Resolved"); // no marker; the report stays listed as resolved
        Assert.Contains(rig.Builder.Build().HealthEvents!, e => e.NodeId == "bb.ledger-db"); // the others stand
    }

    // ---- the source, over HTTP ----

    private static string Page(params string[] items) => $$"""{ "value": [ {{string.Join(",", items)}} ] }""";

    private static string Row(string resourceId, string at, string step, string current, string previous = "Available") =>
        "{ \"category\": { \"value\": \"ResourceHealth\" }, \"eventTimestamp\": \"" + at + "\", \"operationName\": { \"value\": \"Microsoft.Resourcehealth/healthevent/" + step + "/action\" }, \"resourceId\": \"" + resourceId
        + "\", \"properties\": { \"currentHealthStatus\": \"" + current + "\", \"previousHealthStatus\": \"" + previous + "\", \"cause\": \"Unknown\" } }";

    private const string BorealisOrders = "/subscriptions/00000000-0000-0000-0000-0000000000a1/resourceGroups/rg/providers/microsoft.documentdb/databaseAccounts/22222222222222222222222222222222-al-ord";

    /// <summary>The source over canned HTTP, with the inventory read from the town's recording. It signs in with the login it is given.</summary>
    private static async Task<(ResourceHealthSource Source, TownRegistry Registry, SourceSet Set)> Live(CannedHttp http, StaticLogin? login = null, TownRegistry? registry = null, string? folder = null)
    {
        folder ??= TownA;
        registry ??= RegistryLoader.Load(folder, TestAdapters.Azure).ForEnvironment("prod");
        var env = registry.ActiveEnvironment!;
        var set = new AdapterCatalog([new AzureAdapters()]).Build(env, folder);
        await set.Sources.Single(s => s.Name == "inventory").PollAsync(registry, CancellationToken.None);
        var definition = env.Sources.Single(s => s.Name == "health") with { Connection = null };
        var source = (ResourceHealthSource)new ResourceHealthSourceFactory(new HttpClient(http), new FakeTimeProvider(T1)).Create(new SourceContext("prod", definition, login, env.Scope, set.Scope, folder));
        return (source, registry, set);
    }

    [Fact]
    public async Task It_asks_each_subscription_of_the_town_for_each_listed_provider_signed_in_and_follows_the_pages()
    {
        var http = new CannedHttp().Respond(r =>
        {
            var url = r.Uri!.ToString();
            if (url.Contains("availabilityStatuses")) return CannedHttp.Reply("""{ "properties": { "availabilityState": "Degraded" } }""");
            if (url.Contains("page=2")) return CannedHttp.Reply(Page(Row(BorealisOrders, "2026-01-01T00:55:00Z", "Updated", "Degraded")));
            return CannedHttp.Reply(Page(Row(BorealisOrders, "2026-01-01T00:50:00Z", "Activated", "Degraded")).Replace("] }", "] , \"nextLink\": \"https://management.azure.com/next?page=2\" }"));
        });
        var login = new StaticLogin();
        var (source, registry, _) = await Live(http, login);

        await source.PollAsync(registry, CancellationToken.None);

        var logCalls = http.Sent.Where(s => s.Uri!.AbsolutePath.EndsWith("/eventtypes/management/values")).ToList();
        Assert.Equal(["00000000-0000-0000-0000-0000000000a1", "00000000-0000-0000-0000-0000000000a2"], logCalls.Select(s => s.Uri!.AbsolutePath.Split('/')[2]).Distinct().Order());
        Assert.All(logCalls.Where(s => !s.Uri!.Query.Contains("page=2")), s =>
        {
            var filter = Uri.UnescapeDataString(s.Uri!.Query);
            Assert.Contains("resourceProvider eq 'Microsoft.DocumentDB'", filter);
            Assert.Contains("eventTimestamp ge '2025-12-29T01:00:00Z'", filter); // the default window of three days before T1
        });
        Assert.Contains(http.Sent, s => s.Uri!.Query.Contains("page=2")); // the next page was read
        Assert.All(http.Sent, s => Assert.Equal("Bearer test-token", s.Headers["Authorization"]));
        Assert.Contains("https://management.azure.com/.default", login.Scopes);
        var e = Assert.Single(source.Current());
        Assert.Equal("Degraded", e.State);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:50:00Z"), e.Since);
    }

    [Fact]
    public async Task The_current_status_closes_an_event_the_log_never_resolved_and_a_status_that_cannot_be_read_leaves_the_log_standing()
    {
        var closed = new CannedHttp().Respond(r => r.Uri!.ToString().Contains("availabilityStatuses")
            ? CannedHttp.Reply("""{ "properties": { "availabilityState": "Available" } }""")
            : CannedHttp.Reply(Page(Row(BorealisOrders, "2026-01-01T00:50:00Z", "Activated", "Degraded"))));
        var (source, registry, _) = await Live(closed);
        await source.PollAsync(registry, CancellationToken.None);
        Assert.Empty(source.Current());

        var denied = new CannedHttp().Respond(r => r.Uri!.ToString().Contains("availabilityStatuses")
            ? CannedHttp.Reply("""{ "error": "no" }""", HttpStatusCode.Forbidden)
            : CannedHttp.Reply(Page(Row(BorealisOrders, "2026-01-01T00:50:00Z", "Activated", "Degraded"))));
        var (kept, registry2, _) = await Live(denied);
        await kept.PollAsync(registry2, CancellationToken.None);
        Assert.Equal("Degraded", Assert.Single(kept.Current()).State);
        Assert.Null(kept.Problem); // being unable to confirm is not a failed read
    }

    [Fact]
    public async Task The_current_status_can_make_an_event_worse_than_the_log_said()
    {
        var http = new CannedHttp().Respond(r => r.Uri!.ToString().Contains("availabilityStatuses")
            ? CannedHttp.Reply("""{ "properties": { "availabilityState": "Unavailable" } }""")
            : CannedHttp.Reply(Page(Row(BorealisOrders, "2026-01-01T00:50:00Z", "Activated", "Degraded"))));
        var (source, registry, _) = await Live(http);

        await source.PollAsync(registry, CancellationToken.None);

        Assert.Equal("Unavailable", Assert.Single(source.Current()).State);
    }

    [Fact]
    public async Task A_failed_read_keeps_the_last_good_list_says_why_and_the_town_shows_it_as_a_notice()
    {
        var fail = false;
        var http = new CannedHttp().Respond(r =>
        {
            if (r.Uri!.ToString().Contains("availabilityStatuses")) return CannedHttp.Reply("""{ "properties": { "availabilityState": "Degraded" } }""");
            return fail ? CannedHttp.Reply("""{ "error": "boom" }""", HttpStatusCode.Forbidden) : CannedHttp.Reply(Page(Row(BorealisOrders, "2026-01-01T00:50:00Z", "Activated", "Degraded")));
        });
        var (source, registry, set) = await Live(http);
        await source.PollAsync(registry, CancellationToken.None);
        Assert.Single(source.Current());

        fail = true;
        var ex = await Assert.ThrowsAsync<HttpRequestException>(() => source.PollAsync(registry, CancellationToken.None));

        Assert.Contains("all 2 activity log reads failed", ex.Message);
        Assert.Single(source.Current()); // nothing was read, so the last good list stands
        Assert.Contains("403", source.Problem);
        var builder = new SnapshotBuilder(registry, new LatestState(), new FakeTimeProvider(T1)) { Environment = "prod", ScopeSource = set.Scope, HealthSources = [source] };
        Assert.DoesNotContain(builder.Build().Notices, n => n.Contains("health reports")); // the log carries it, the town does not

        fail = false;
        await source.PollAsync(registry, CancellationToken.None);
        Assert.Null(source.Problem);
        Assert.DoesNotContain(builder.Build().Notices, n => n.Contains("could not read the cloud's health reports"));
    }

    [Fact]
    public async Task It_waits_for_the_inventory_and_asks_nothing_until_it_knows_where_to_look()
    {
        var registry = RegistryLoader.Load(TownA, TestAdapters.Azure).ForEnvironment("prod");
        var env = registry.ActiveEnvironment!;
        var http = new CannedHttp().Answer(Page());
        var definition = env.Sources.Single(s => s.Name == "health") with { Connection = null, TimeoutSeconds = 0.05 };
        var source = new ResourceHealthSourceFactory(new HttpClient(http), new FakeTimeProvider(T1)).Create(new SourceContext("prod", definition, null, env.Scope, new ObservabilityCity.Core.Scope.ScopeStore(), TownA));

        await source.PollAsync(registry, CancellationToken.None);

        Assert.Empty(http.Sent);
        var waiting = (ResourceHealthSource)source;
        Assert.Equal(TimeSpan.FromSeconds(30), waiting.RetryIn); // tried again soon, not a whole interval later
        Assert.Equal("waiting for the resource inventory, retrying in 30s", waiting.RoundNote);
    }

    [Fact]
    public async Task Once_the_inventory_is_there_a_round_goes_back_to_the_normal_interval()
    {
        var (source, registry, _) = await Live(new CannedHttp().Answer(Page()));

        await source.PollAsync(registry, CancellationToken.None);

        Assert.Null(source.RetryIn);
        Assert.Equal("health read: 2 reads, 0 failed, 0 reports (0 open)", source.RoundNote);
    }

    private const string BeLedger = "/subscriptions/00000000-0000-0000-0000-0000000000a2/resourceGroups/rg/providers/microsoft.documentdb/databaseaccounts/11111111111111111111111111111111-be-led";

    [Fact]
    public void Only_the_subscription_and_provider_pairs_the_inventory_has_resources_for_are_read()
    {
        var registry = RegistryLoader.Load(TownA, TestAdapters.Azure).ForEnvironment("prod");
        var env = registry.ActiveEnvironment!;
        var health = env.Sources.Single(s => s.Name == "health");
        var definition = health with { Connection = null, Typed = AzureSettings.Of(health) with { Providers = ["Microsoft.DocumentDB", "Microsoft.Web", "Microsoft.KeyVault"] } };
        var source = (ResourceHealthSource)new ResourceHealthSourceFactory(new HttpClient(new CannedHttp()), new FakeTimeProvider(T1))
            .Create(new SourceContext("prod", definition, null, env.Scope, new ObservabilityCity.Core.Scope.ScopeStore(), TownA));
        static ObservabilityCity.Core.Scope.InventoryResource R(string sub, string type) => new($"/subscriptions/{sub}/x", "x", type, sub, null, new Dictionary<string, string>());
        var inventory = new ObservabilityCity.Core.Scope.Inventory([], [R("S1", "microsoft.documentdb/databaseaccounts"), R("s1", "Microsoft.Web/sites"), R("s2", "microsoft.web/serverfarms")]);

        var asks = source.AsksOf(["s1", "s2", "s3"], inventory);

        Assert.Equal([("s1", "Microsoft.DocumentDB"), ("s1", "Microsoft.Web"), ("s2", "Microsoft.Web")], asks); // no key vault anywhere, nothing in s3: not asked
        Assert.Equal(9, source.AsksOf(["s1", "s2", "s3"], null).Count); // no inventory to go by: every pair
    }

    [Fact]
    public async Task A_read_that_fails_keeps_its_reports_from_the_last_good_round_the_others_are_updated_and_a_notice_says_the_list_may_be_incomplete()
    {
        var failA2 = false;
        var a1Event = true;
        var http = new CannedHttp().Respond(r =>
        {
            var url = r.Uri!.ToString();
            if (url.Contains("availabilityStatuses")) return CannedHttp.Reply("""{ "properties": { "availabilityState": "Degraded" } }""");
            if (url.Contains("0000000000a2"))
                return failA2 ? CannedHttp.Reply("""{ "error": "boom" }""", HttpStatusCode.Forbidden) : CannedHttp.Reply(Page(Row(BeLedger, "2026-01-01T00:40:00Z", "Activated", "Degraded")));
            return CannedHttp.Reply(a1Event ? Page(Row(BorealisOrders, "2026-01-01T00:50:00Z", "Activated", "Degraded")) : Page());
        });
        var (source, registry, set) = await Live(http);
        await source.PollAsync(registry, CancellationToken.None);
        Assert.Equal(2, source.Current().Count);

        failA2 = true;
        a1Event = false; // the read that works says the a1 report is gone
        await source.PollAsync(registry, CancellationToken.None); // a partial round is not a failed one

        var kept = Assert.Single(source.Current());
        Assert.Equal(BeLedger, kept.ResourceId, ignoreCase: true); // kept: its read failed, so nothing says it ended
        Assert.Contains("1 of 2 activity log reads failed, so the list may be incomplete", source.Problem);
        Assert.Contains("403", source.Problem);
        Assert.StartsWith("health read: 2 reads, 1 failed, 1 reports (1 open); the first failure: ", source.RoundNote);
        Assert.Contains("403", source.RoundNote); // the Aspire log line says why
        var builder = new SnapshotBuilder(registry, new LatestState(), new FakeTimeProvider(T1)) { Environment = "prod", ScopeSource = set.Scope, HealthSources = [source] };
        var snapshot = builder.Build();
        Assert.DoesNotContain(snapshot.Notices, n => n.Contains("health reports") || n.Contains("activity log reads")); // never in the UI
        Assert.Single(snapshot.HealthEvents!);

        failA2 = false;
        await source.PollAsync(registry, CancellationToken.None);
        Assert.Null(source.Problem);
    }

    [Fact]
    public async Task A_read_that_runs_out_of_time_counts_as_a_failed_read_and_the_others_still_count()
    {
        var http = new CannedHttp().Respond(r =>
        {
            var url = r.Uri!.ToString();
            if (url.Contains("availabilityStatuses")) return CannedHttp.Reply("""{ "properties": { "availabilityState": "Degraded" } }""");
            if (url.Contains("0000000000a2")) throw new TaskCanceledException("slow");
            return CannedHttp.Reply(Page(Row(BorealisOrders, "2026-01-01T00:50:00Z", "Activated", "Degraded")));
        });
        var (source, registry, _) = await Live(http);

        await source.PollAsync(registry, CancellationToken.None);

        Assert.Single(source.Current());
        Assert.Contains("the read ran out of time", source.Problem);
    }

    // ---- the config ----

    [Fact]
    public void A_source_naming_no_provider_cannot_start_and_says_so()
    {
        var env = RegistryLoader.Load(TownA, TestAdapters.Azure).Environments.Single();
        var bare = env with { Sources = env.Sources.Select(s => s.Name == "health" ? s with { Typed = AzureSettings.Of(s) with { Providers = [] } } : s).ToList() };

        var set = new AdapterCatalog([new AzureAdapters()]).Build(bare, TownA);

        Assert.Contains(set.Problems, p => p.Contains("source 'health' could not start") && p.Contains("no resource provider"));
        Assert.DoesNotContain(set.Sources, s => s.Name == "health");
    }

    [Fact]
    public void A_provider_must_be_written_the_way_the_cloud_names_it()
    {
        using var copy = new TownFiles(TownA);
        copy.Write("environments/prod.yaml", File.ReadAllText(copy.FilePath("environments/prod.yaml")).Replace("providers: [Microsoft.DocumentDB]", "providers: [documentdb]"));

        var ex = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path, TestAdapters.Azure));

        Assert.Contains("source 'health' has the provider 'documentdb'", ex.Message);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public void A_health_source_fills_no_signal_and_is_not_reported_as_unused(string town)
    {
        // that its kind fills no signal is the module's word (it declares HealthEvents), so the view is made with the loaded modules, as the host makes it
        var registry = RegistryLoader.Load(Folder(town), TestAdapters.Azure).ForEnvironment("prod", null, new AdapterCatalog([new AzureAdapters()]));

        Assert.DoesNotContain(registry.Warnings, w => w.Contains(SourceName(town)));
        Assert.Equal("resourcehealth", registry.ActiveEnvironment!.Sources.Single(s => s.Name == SourceName(town)).Kind);
    }

    [Fact]
    public void A_health_source_has_its_own_defaults_and_a_window_in_days_is_understood()
    {
        var a = RegistryLoader.Load(TownA, TestAdapters.Azure).ForEnvironment("prod").ActiveEnvironment!.Sources.Single(s => s.Name == "health");
        var b = RegistryLoader.Load(TownB, TestAdapters.Azure).ForEnvironment("prod").ActiveEnvironment!.Sources.Single(s => s.Name == "azure-health");

        Assert.Equal(TimeSpan.FromDays(3), SourceQuery.WindowOf(a with { Window = ResourceHealthSource.DefaultWindow }));
        Assert.Equal("7d", b.Window);
        Assert.Equal(TimeSpan.FromDays(7), SourceQuery.WindowOf(b));
    }

    // ---- resolved reports stay for a while, and can be dismissed ----

    private const string Db = "/subscriptions/s/providers/p/accounts/db1";

    private static HealthLogEntry[] WentWrongAndRecovered() =>
        [Entry(Db, "2026-01-01T00:10:00Z", "Activated", "Degraded", "Available", "Unknown", "Slow"), Entry(Db, "2026-01-01T00:40:00Z", "Resolved", "Available", "Degraded")];

    [Fact]
    public void A_resolution_gives_a_resolved_report_with_when_it_began_when_it_ended_and_what_it_was_before()
    {
        var done = Assert.Single(ResourceHealthLog.Resolved(WentWrongAndRecovered(), DateTimeOffset.Parse("2026-01-01T00:00:00Z")));

        Assert.Equal("Resolved", done.State);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:10:00Z"), done.Since);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:40:00Z"), done.ResolvedAt);
        Assert.Equal("Available", done.Previous);
        Assert.Equal("Unknown", done.Cause);
        Assert.Equal(ResourceHealthLog.Open(WentWrongAndRecovered().Take(1)).Single().Id, done.Id); // the same id the open report had, so a viewer sees one report change
    }

    [Fact]
    public void A_resolution_older_than_the_keep_time_or_of_a_resource_that_never_went_wrong_gives_nothing()
    {
        Assert.Empty(ResourceHealthLog.Resolved(WentWrongAndRecovered(), DateTimeOffset.Parse("2026-01-01T00:41:00Z")));
        Assert.Empty(ResourceHealthLog.Resolved([Entry(Db, "2026-01-01T00:40:00Z", "Resolved", "Available", "Available")], DateTimeOffset.Parse("2026-01-01T00:00:00Z")));
    }

    [Fact]
    public void A_resource_that_went_wrong_recovered_and_went_wrong_again_has_two_reports_one_resolved_and_one_open_with_their_own_ids()
    {
        HealthLogEntry[] twice = [.. WentWrongAndRecovered(), Entry(Db, "2026-01-01T00:50:00Z", "Activated", "Unavailable", "Available", "PlatformInitiated")];

        var resolved = Assert.Single(ResourceHealthLog.Resolved(twice, DateTimeOffset.Parse("2026-01-01T00:00:00Z")));
        var open = Assert.Single(ResourceHealthLog.Open(twice));

        Assert.Equal("Resolved", resolved.State);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:10:00Z"), resolved.Since);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:40:00Z"), resolved.ResolvedAt);
        Assert.Equal("Unavailable", open.State);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:50:00Z"), open.Since); // the new report began when it was declared, not when the first did
        Assert.NotEqual(resolved.Id, open.Id);
        Assert.Equal("Unknown", resolved.Cause); // each keeps its own cause
        Assert.Equal("PlatformInitiated", open.Cause);
    }

    [Fact]
    public void Two_earlier_reports_that_both_resolved_are_both_listed()
    {
        var twice = new[]
        {
            Entry(Db, "2026-01-01T00:10:00Z", "Activated", "Degraded"), Entry(Db, "2026-01-01T00:20:00Z", "Resolved", "Available", "Degraded"),
            Entry(Db, "2026-01-01T00:30:00Z", "Activated", "Unavailable"), Entry(Db, "2026-01-01T00:45:00Z", "Resolved", "Available", "Unavailable"),
        };

        var done = ResourceHealthLog.Resolved(twice, DateTimeOffset.Parse("2026-01-01T00:00:00Z"));

        Assert.Equal(2, done.Count);
        Assert.Equal(2, done.Select(d => d.Id).Distinct().Count());
        var late = Assert.Single(ResourceHealthLog.Resolved(twice, DateTimeOffset.Parse("2026-01-01T00:30:00Z"))); // the first ended before the keep time
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:45:00Z"), late.ResolvedAt);
    }

    [Fact]
    public async Task The_town_lists_the_open_report_and_the_earlier_resolved_one_of_the_same_resource_as_two_incidents()
    {
        var http = new CannedHttp().Respond(r => r.Uri!.ToString().Contains("availabilityStatuses")
            ? CannedHttp.Reply("""{ "properties": { "availabilityState": "Degraded" } }""")
            : CannedHttp.Reply(Page(Row(BorealisOrders, "2026-01-01T00:10:00Z", "Activated", "Degraded"), Row(BorealisOrders, "2026-01-01T00:40:00Z", "Resolved", "Available", "Degraded"), Row(BorealisOrders, "2026-01-01T00:50:00Z", "Activated", "Degraded"))));
        var (source, registry, _) = await Live(http);
        await source.PollAsync(registry, CancellationToken.None);

        var events = source.Current().OrderBy(e => e.Since).ToList();

        Assert.Equal(["Resolved", "Degraded"], events.Select(e => e.State));
        Assert.NotEqual(events[0].Id, events[1].Id);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:40:00Z"), events[0].ResolvedAt);
        Assert.Null(events[1].ResolvedAt);
    }

    private static CannedHttp ResolvedLog() =>
        new CannedHttp().Respond(r => CannedHttp.Reply(Page(Row(BorealisOrders, "2026-01-01T00:20:00Z", "Activated", "Degraded"), Row(BorealisOrders, "2026-01-01T00:40:00Z", "Resolved", "Available", "Degraded"))));

    [Fact]
    public async Task A_resolved_report_stays_listed_for_four_hours_by_default_and_for_the_time_the_source_says()
    {
        var (source, registry, _) = await Live(ResolvedLog());
        await source.PollAsync(registry, CancellationToken.None);
        Assert.Null(source.Problem); var kept = Assert.Single(source.Current());
        Assert.Equal("Resolved", kept.State);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:40:00Z"), kept.ResolvedAt);
        Assert.Equal(TimeSpan.FromHours(4), source.KeepResolvedFor);

        using var copy = new TownFiles(TownA);
        copy.Write("environments/prod.yaml", File.ReadAllText(copy.FilePath("environments/prod.yaml")).Replace("providers: [Microsoft.DocumentDB]", "providers: [Microsoft.DocumentDB], keepResolvedFor: 10m"));
        var (short10, registry2, _) = await Live(ResolvedLog(), registry: copy.Load("prod"), folder: copy.Path);
        await short10.PollAsync(registry2, CancellationToken.None);
        Assert.Equal(TimeSpan.FromMinutes(10), short10.KeepResolvedFor);
        Assert.Empty(short10.Current()); // resolved 20 minutes ago
    }

    [Fact]
    public async Task A_report_the_cloud_now_calls_available_with_no_resolution_in_the_log_turns_resolved_only_if_it_was_listed_open()
    {
        var available = false;
        var http = new CannedHttp().Respond(r => r.Uri!.ToString().Contains("availabilityStatuses")
            ? CannedHttp.Reply($$"""{ "properties": { "availabilityState": "{{(available ? "Available" : "Degraded")}}" } }""")
            : CannedHttp.Reply(Page(Row(BorealisOrders, "2026-01-01T00:50:00Z", "Activated", "Degraded"))));
        var (source, registry, _) = await Live(http);
        await source.PollAsync(registry, CancellationToken.None);
        Assert.Equal("Degraded", Assert.Single(source.Current()).State);

        available = true;
        await source.PollAsync(registry, CancellationToken.None);
        var resolved = Assert.Single(source.Current());
        Assert.Equal("Resolved", resolved.State);
        Assert.NotNull(resolved.ResolvedAt);

        await source.PollAsync(registry, CancellationToken.None);
        Assert.Equal(resolved.ResolvedAt, Assert.Single(source.Current()).ResolvedAt); // the time it resolved does not move with each poll

        var (fresh, registry2, _) = await Live(http); // a restart: it never listed the report open, so it does not invent a resolution
        await fresh.PollAsync(registry2, CancellationToken.None);
        Assert.Empty(fresh.Current());
    }

    [Fact]
    public async Task A_dismissed_report_is_hidden_open_or_resolved_and_an_unknown_one_is_not_found()
    {
        var (source, registry, _) = await Live(ResolvedLog());
        await source.PollAsync(registry, CancellationToken.None);
        var id = Assert.Single(source.Current()).Id;

        Assert.False(source.Dismiss("nothing@20260101T000000Z"));
        Assert.True(source.Dismiss(id));
        Assert.Empty(source.Current());

        await source.PollAsync(registry, CancellationToken.None);
        Assert.Empty(source.Current()); // it stays hidden when it is read again
    }

    private sealed class Stub(params ResourceHealthEvent[] events) : IHealthEventSource
    {
        public string Name => "stub";
        public IReadOnlyList<ResourceHealthEvent> Current() => events;
        public string? Problem => null;
        public bool Dismiss(string id) => false;
    }

    [Fact]
    public async Task A_resolved_report_is_listed_after_the_open_ones_and_is_not_an_incident()
    {
        var resolved = new ResourceHealthEvent("r1", BorealisOrders, "orders", "Resolved", "Available", "Unknown", T1.AddMinutes(-30), null, T1.AddMinutes(-5));
        var rig = await Run(TownA, "health", healthSources: [new Stub(resolved)]);

        var snapshot = rig.Builder.Build();

        var e = Assert.Single(snapshot.HealthEvents!);
        Assert.Equal("Resolved", e.State);
        Assert.Equal(T1.AddMinutes(-5), e.ResolvedAt);
        Assert.Equal("aa.orders-db", e.NodeId); // still tied to its building, so the drawer can say it was resolved
        Assert.Equal(0, snapshot.Totals.Incidents);
        Assert.False(snapshot.IncidentsSeen); // nothing is open, so the island has had no incident
    }

    [Fact]
    public async Task Open_reports_come_before_resolved_ones()
    {
        var open = new ResourceHealthEvent("o1", BorealisOrders, "orders", "Degraded", "Available", null, T1.AddMinutes(-20));
        var resolved = new ResourceHealthEvent("r1", "/subscriptions/x/providers/p/accounts/other", "other", "Resolved", null, null, T1.AddMinutes(-90), null, T1.AddMinutes(-10));
        var rig = await Run(TownA, "health", healthSources: [new Stub(resolved, open)]);

        var snapshot = rig.Builder.Build();

        Assert.Equal(["Degraded", "Resolved"], snapshot.HealthEvents!.Select(x => x.State));
        Assert.Equal(1, snapshot.Totals.Incidents);
    }

    [Fact]
    public void A_keep_time_must_be_a_number_and_a_unit()
    {
        using var copy = new TownFiles(TownA);
        copy.Write("environments/prod.yaml", File.ReadAllText(copy.FilePath("environments/prod.yaml")).Replace("providers: [Microsoft.DocumentDB]", "providers: [Microsoft.DocumentDB], keepResolvedFor: soon"));

        var ex = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path, TestAdapters.Azure));

        Assert.Contains("keepResolvedFor 'soon'", ex.Message);
    }
}
