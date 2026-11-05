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
    private static string TownRoutes => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "routes-town");
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
        Assert.Equal(6, http.Sent.Count(r => r.Uri!.AbsolutePath.Contains("/namespaces/sb-acme-"))); // the backlog, the dead letters and the arrivals add up differently, so each namespace is asked three times
        Assert.Equal(30, readings["aa.orders-worker"].QueueDepth); // 15 in each of the two namespaces the same answer was given for
        Assert.Equal(8, readings["bb.ledger-worker"].QueueDepth); // a point with no value is a gap, not a zero
    }

    [Fact]
    public void Last_reads_the_newest_point_and_nothing_when_there_is_none()
    {
        Assert.Equal(0, AzureMonitorReader.Reduce([12, 12, 0], "last"));
        Assert.Equal(5, AzureMonitorReader.Reduce([0, 0, 5], "last"));
        Assert.Null(AzureMonitorReader.Reduce([], "last"));
    }

    [Fact]
    public async Task A_replayed_queue_reads_zero_at_once_when_the_dead_letters_use_last_but_still_its_peak_with_maximum()
    {
        const string answer = """
            { "value": [ { "name": { "value": "DeadletteredMessages" }, "timeseries": [
                { "metadatavalues": [ { "name": { "value": "entityname" }, "value": "sbq-al-ord-inbox" } ], "data": [ { "maximum": 12 }, { "maximum": 12 }, { "maximum": 0 } ] } ] } ] }
            """;
        foreach (var (aggregation, expected) in new[] { ("last", 0.0), ("maximum", 24.0) }) // two namespaces answer the same
        {
            var folder = CopyWith(yaml => yaml.Replace("deadLetter: { metric: DeadletteredMessages, aggregation: maximum }", $"deadLetter: {{ metric: DeadletteredMessages, aggregation: {aggregation} }}"));
            try
            {
                var http = new CannedHttp().Respond(r => Uri.UnescapeDataString(r.Uri!.Query).Contains("metricnames=DeadletteredMessages") ? CannedHttp.Reply(answer) : CannedHttp.Reply("""{ "value": [] }"""));
                var (source, registry) = await Messaging(folder, http);

                var readings = await source.PollAsync(registry, CancellationToken.None);

                Assert.Equal(expected, readings["aa.orders-worker"].DeadLetters);
                Assert.Contains(http.Sent, r => Uri.UnescapeDataString(r.Uri!.Query).Contains("aggregation=Maximum")); // Azure has no "last": it is asked for the maximum of each grain
                Assert.DoesNotContain(http.Sent, r => Uri.UnescapeDataString(r.Uri!.Query).Contains("aggregation=Last"));
            }
            finally { Directory.Delete(folder, true); }
        }
    }

    [Theory]
    [InlineData("backlog: { metric: ActiveMessages, aggregation: average }", "backlog: { metric: ActiveMessages, aggregation: last }", true)]
    [InlineData("throughput: { metric: IncomingMessages, aggregation: total }", "throughput: { metric: IncomingMessages, aggregation: last }", false)]
    public void Last_is_allowed_for_the_backlog_but_refused_for_the_arrivals_which_are_added_up(string from, string to, bool allowed)
    {
        var folder = CopyWith(yaml => yaml.Replace(from, to));
        try
        {
            if (allowed) { RegistryLoader.Load(folder); return; }
            var error = Assert.Throws<RegistryException>(() => RegistryLoader.Load(folder));
            Assert.Contains("aggregation 'last'", error.Message);
        }
        finally { Directory.Delete(folder, true); }
    }

    private static string CopyWith(Func<string, string> env)
    {
        var target = Path.Combine(Path.GetTempPath(), "oc-last-" + Guid.NewGuid().ToString("N"));
        CopyDirectory(TownA, target);
        var file = Path.Combine(target, "environments", "prod.yaml");
        var before = File.ReadAllText(file);
        var after = env(before);
        Assert.Contains("aggregation: maximum }", before); // the lines the tests change are there
        File.WriteAllText(file, after);
        return target;
    }

    private static void CopyDirectory(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
        foreach (var d in Directory.GetDirectories(from)) CopyDirectory(d, Path.Combine(to, Path.GetFileName(d)));
    }

    [Fact]
    public async Task The_arrivals_of_a_queue_become_messages_a_second_over_the_window()
    {
        var http = new CannedHttp().Respond(r => Uri.UnescapeDataString(r.Uri!.Query).Contains("metricnames=IncomingMessages") ? CannedHttp.Reply("""
            { "value": [ { "name": { "value": "IncomingMessages" }, "timeseries": [
                { "metadatavalues": [ { "name": { "value": "entityname" }, "value": "sbq-al-ord-inbox" } ], "data": [ { "total": 300 }, { "total": 300 }, { "total": 300 } ] } ] } ] }
            """) : CannedHttp.Reply("""{ "value": [] }"""));
        var (source, registry) = await Messaging(TownA, http);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        var queue = Assert.Single(readings["aa.orders-worker"].Queues!);
        Assert.Equal("sbq-al-ord-inbox", queue.Name);
        Assert.Equal(6.0, queue.PerSecond!.Value, 3); // 900 in each of two namespaces over the 5 minute window of the town, 3 a second in each
        Assert.Null(queue.Backlog); // what is not asked for stays unknown
    }

    [Fact]
    public async Task A_read_split_by_queue_asks_Azure_for_every_queue_not_only_the_first_ten()
    {
        var http = new CannedHttp().Respond(_ => CannedHttp.Reply("""{ "value": [] }"""));
        var (source, registry) = await Messaging(TownA, http);

        await source.PollAsync(registry, CancellationToken.None);

        Assert.All(http.Sent.Where(r => r.Uri!.AbsolutePath.Contains("/namespaces/sb-acme-")), r => Assert.Contains($"&top={AzureMonitorReader.MaxSeries}", r.Uri!.Query));
    }

    [Fact]
    public async Task A_queue_that_is_quiet_for_a_poll_keeps_its_place_with_no_numbers_instead_of_vanishing()
    {
        var withNumbers = CannedHttp.Reply("""
            { "value": [ { "name": { "value": "ActiveMessages" }, "timeseries": [
                { "metadatavalues": [ { "name": { "value": "entityname" }, "value": "sbq-al-ord-inbox" } ], "data": [ { "average": 10 } ] } ] } ] }
            """);
        var calls = 0;
        var http = new CannedHttp().Respond(_ => ++calls <= 6 ? CannedHttp.Reply(withNumbers.Content.ReadAsStringAsync().Result) : CannedHttp.Reply("""{ "value": [] }"""));
        var (source, registry) = await Messaging(TownA, http);
        await source.PollAsync(registry, CancellationToken.None);

        var second = await source.PollAsync(registry, CancellationToken.None); // Azure sends nothing for the queue this time

        var queue = Assert.Single(second["aa.orders-worker"].Queues!);
        Assert.Equal("sbq-al-ord-inbox", queue.Name);
        Assert.Null(queue.Backlog);
        Assert.Null(second["aa.orders-worker"].QueueDepth); // no number, not a zero
    }

    [Fact]
    public async Task A_queue_name_that_names_only_the_service_is_read_by_that_service_in_whichever_pillar_it_is()
    {
        // town a's outbox pattern has no pillar group: sbq-al-led-ord-outbox is addressed to the one service with the code ord
        var http = new CannedHttp().Respond(_ => CannedHttp.Reply("""
            { "value": [ { "name": { "value": "ActiveMessages" }, "timeseries": [
                { "metadatavalues": [ { "name": { "value": "entityname" }, "value": "sbq-zz-led-ord-outbox" } ], "data": [ { "average": 5 } ] } ] } ] }
            """));
        var (source, registry) = await Messaging(TownA, http);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        Assert.Equal(10, readings["aa.orders-worker"].QueueDepth); // 5 in each of the two namespaces
    }

    [Fact]
    public async Task A_queue_name_that_says_who_publishes_it_is_a_route_from_that_service_to_its_reader()
    {
        var (source, registry) = await Messaging(TownRoutes);

        var readings = await source.PollAsync(registry, CancellationToken.None);

        var queues = readings["aa.orders-worker"].Queues!;
        Assert.Equal(("bb", "ledger"), (queues.Single(q => q.Name == "bus.bb.ledger.orders.out").ProducerGroup, queues.Single(q => q.Name == "bus.bb.ledger.orders.out").ProducerService));
        Assert.Null(queues.Single(q => q.Name == "bus.aa.orders.in").ProducerGroup); // its own inbox has no publisher in its name
        var ledger = readings["bb.ledger-worker"].Queues!.Single();
        Assert.Equal(("aa", "orders"), (ledger.ProducerGroup, ledger.ProducerService));
    }

    [Fact]
    public async Task The_topology_comes_from_the_queue_names_when_no_pillar_file_names_a_topic_or_a_subscription()
    {
        var registry = Prod(TownRoutes);
        Assert.Empty(registry.Topics); // the pillar files say nothing about messaging
        Assert.Empty(registry.Subscriptions);
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, TownRoutes);
        Assert.Empty(set.Problems);
        var state = new LatestState();
        foreach (var source in set.Sources) state.Update(source.Name, await source.PollAsync(registry, CancellationToken.None));

        var snapshot = new SnapshotBuilder(registry, state, new FakeTimeProvider(T0)) { Environment = "prod" }.Build();

        var aa = snapshot.Groups.Single(g => g.Id == "aa").Messaging!;
        var bb = snapshot.Groups.Single(g => g.Id == "bb").Messaging!;
        Assert.Contains(aa.Topics, t => t.Name == "bus.aa.orders.ledger.out" && t.Service == "orders"); // aa publishes what bb reads
        Assert.Contains(bb.Subscriptions, s => s.Topic == "bus.aa.orders.ledger.out" && s.Publisher == "aa" && s.Consumer == "bb.ledger-worker");
        Assert.Contains(aa.Subscriptions, s => s.Topic == "bus.bb.ledger.orders.out" && s.Publisher == "bb" && s.Consumer == "aa.orders-worker");
        Assert.DoesNotContain(bb.Subscriptions, s => s.Consumer == "aa.orders-worker");
    }

    [Fact]
    public void A_route_needs_both_groups_that_name_the_publisher()
    {
        var folder = CopyOf(TownRoutes, yaml => yaml.Replace("(?<producer>[a-z]+)", "[a-z]+"));
        try
        {
            var ex = Assert.ThrowsAny<Exception>(() => RegistryLoader.Load(folder));
            Assert.Contains("a route needs both groups", ex.Message);
        }
        finally { Directory.Delete(folder, true); }
    }

    private static string CopyOf(string source, Func<string, string> editProd)
    {
        var folder = Path.Combine(Path.GetTempPath(), "routes-" + Guid.NewGuid().ToString("N"));
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(folder, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target);
        }
        var prod = Path.Combine(folder, "environments", "prod.yaml");
        File.WriteAllText(prod, editProd(File.ReadAllText(prod)));
        return folder;
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
