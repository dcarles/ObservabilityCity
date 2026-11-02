using System.Net;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 3, slice 5: the backlog and the dead letters of a consumer come from the message broker's platform metrics split by entity name. The program
/// knows no metric, no entity naming and no threshold: the environment's <c>entities</c> block says them. Two towns with differently shaped blocks
/// (queue names that carry codes and are averaged; names that carry ids and a peak) read recorded numbers of the same state and show the same town.
/// </summary>
public class MessagingSourceTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "messaging-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "messaging-town-b");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    private static TownRegistry Prod(string folder) => RegistryLoader.Load(folder).ForEnvironment("prod");
    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).First(n => n.Id == id);

    private static async Task<(IMetricSource Source, TownRegistry Registry)> Messaging(string folder, CannedHttp? http = null)
    {
        var registry = Prod(folder);
        var env = registry.ActiveEnvironment!;
        var set = new AdapterCatalog([new AzureAdapters()]).Build(env, folder);
        Assert.Empty(set.Problems);
        await set.Sources.Single(s => s.Name == "inventory").PollAsync(registry, CancellationToken.None);
        if (http is null) return (set.Sources.Single(s => s.Name == "messaging"), registry);
        var definition = env.Sources.Single(s => s.Name == "messaging") with { Connection = null };
        var source = new ServiceBusSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(new SourceContext("prod", definition, null, env.Scope, set.Scope, folder));
        return (source, registry);
    }

    private static async Task<Snapshot> TownSnapshot(string folder)
    {
        var registry = Prod(folder);
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, folder);
        Assert.Empty(set.Problems);
        var state = new LatestState();
        foreach (var source in set.Sources) state.Update(source.Name, await source.PollAsync(registry, CancellationToken.None));
        return new SnapshotBuilder(registry, state, new FakeTimeProvider(T0)) { Environment = "prod" }.Build();
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task Two_towns_with_differently_shaped_entities_show_the_same_backlog_and_dead_letters(string town)
    {
        var snapshot = await TownSnapshot(town == "a" ? TownA : TownB);

        // the orders worker's inbox (25 over the two regions), its changefeed (0) and the outbox addressed to it (150) wait for it
        var orders = Node(snapshot, "aa.orders-worker");
        Assert.Equal(175, orders.QueueDepth);
        Assert.Equal(2, orders.DeadLetters); // town A's recording is a peak of 2, town B's a total of 2: each adds them up the way its entry says
        Assert.Equal(HealthState.Degraded, orders.State); // more than the count threshold (100) waits

        var ledger = Node(snapshot, "bb.ledger-worker");
        Assert.Equal(3, ledger.QueueDepth);
        Assert.Equal(0, ledger.DeadLetters);
        Assert.Equal(HealthState.Healthy, ledger.State);

        // a system no entity belongs to has no backlog signal, rather than a zero
                Assert.Null(Node(snapshot, "aa.orders-api").QueueDepth);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task Entities_no_pattern_claims_are_left_out_and_every_reading_passes_the_contract(string town)
    {
        var (source, registry) = await Messaging(town == "a" ? TownA : TownB);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        Assert.Equal(["aa.orders-worker", "bb.ledger-worker"], readings.Keys.Order());
        Assert.Equal(2, ((ServiceBusSource)source).Unclaimed); // a queue of an unknown pillar and the egress topic
        AdapterContract.AssertReadings(readings, registry);
    }

    [Fact]
    public void A_pattern_without_the_pillar_and_service_groups_is_a_config_error()
    {
        using var copy = new RegistryCopy(TownA);
        var file = copy.FilePath(Path.Combine("environments", "prod.yaml"));
        File.WriteAllText(file, File.ReadAllText(file).Replace("(?<pillar>[a-z]+)-(?<service>[a-z]+)-(?:inbox|changefeed)", "(?<pillar>[a-z]+)-[a-z]+-(?:inbox|changefeed)"));

        var ex = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("no group named 'service'", ex.Message);
    }

    [Fact]
    public void A_broker_source_must_name_a_rule_that_exists()
    {
        using var copy = new RegistryCopy(TownA);
        var file = copy.FilePath(Path.Combine("environments", "prod.yaml"));
        File.WriteAllText(file, File.ReadAllText(file).Replace("resources: broker", "resources: brokr"));

        var ex = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("'brokr' is not a rule of scope.resources", ex.Message);
        Assert.Contains("broker", ex.Message); // and says what it meant
    }

    [Fact]
    public async Task The_metrics_api_is_asked_for_each_entity_on_its_own_in_every_namespace()
    {
        var http = new CannedHttp().Respond(_ => CannedHttp.Reply("""
            { "value": [ { "name": { "value": "ActiveMessages" }, "timeseries": [
                { "metadatavalues": [ { "name": { "value": "entityname" }, "value": "sbq-al-ord-inbox" } ], "data": [ { "average": 10 }, { "average": 20 } ] },
                { "metadatavalues": [ { "name": { "value": "entityname" }, "value": "sbq-be-led-inbox" } ], "data": [ { "average": 4 }, { } ] } ] } ] }
            """));
        var (source, registry) = await Messaging(TownA, http);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        var url = Uri.UnescapeDataString(http.Sent[0].Uri!.Query);
        Assert.Contains("$filter=EntityName eq '*'", url);
        Assert.Contains("metricnames=ActiveMessages", url);
        Assert.Equal(4, http.Sent.Count(r => r.Uri!.AbsolutePath.Contains("/namespaces/sb-acme-"))); // the backlog and the dead letters add up differently, so each namespace is asked twice
        Assert.Equal(30, readings["aa.orders-worker"].QueueDepth); // 15 in each of the two namespaces the same answer was given for
        Assert.Equal(8, readings["bb.ledger-worker"].QueueDepth); // a point with no value is a gap, not a zero
    }

    [Fact]
    public async Task One_namespace_that_cannot_be_read_fails_the_poll_so_a_half_number_never_shows()
    {
        var http = new CannedHttp().Respond(r => r.Uri!.AbsolutePath.Contains("westeurope") ? CannedHttp.Reply("denied", HttpStatusCode.Forbidden) : CannedHttp.Reply("""{ "value": [] }"""));
        var (source, registry) = await Messaging(TownA, http);

        var ex = await Assert.ThrowsAsync<HttpRequestException>(() => source.PollAsync(registry, CancellationToken.None));

        Assert.Contains("1 of 2 namespace reads failed", ex.Message);
        Assert.Contains("403", ex.Message);
    }
}
