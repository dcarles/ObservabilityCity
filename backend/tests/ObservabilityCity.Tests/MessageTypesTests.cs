using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// The kinds of message each queue handles and how many a second of each, from a query the environment writes (<c>typesQuery</c>; columns queue, type and calls).
/// The program knows no table, no property and no naming: two towns with differently shaped queries, names and column order read the same way.
/// </summary>
public class MessageTypesTests
{
    private static string Town(string name) => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", name);
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    private static async Task<IReadOnlyDictionary<string, NodeReading>> Read(string folder)
    {
        var registry = RegistryLoader.Load(folder).ForEnvironment("prod");
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, folder);
        Assert.Empty(set.Problems);
        await set.Sources.Single(s => s.Name == "inventory").PollAsync(registry, CancellationToken.None);
        return await set.Sources.Single(s => s.Name == "messaging").PollAsync(registry, CancellationToken.None);
    }

    [Fact]
    public async Task A_queue_lists_the_kinds_it_handled_with_their_rate_highest_first_and_the_same_kind_in_two_rows_added_up()
    {
        var readings = await Read(Town("messaging-town-b"));

        var types = readings["aa.orders-worker"].Queues!.Single(q => q.Name == "bus.aa.orders.in").Types!;

        Assert.Equal(["OrderPlaced", "OrderCancelled"], types.Select(t => t.Type));
        Assert.Equal(6.0, types[0].PerSecond, 3); // 1500 and 300 calls in two rows, over the 5 minute window
        Assert.Equal(1.0, types[1].PerSecond, 3);
        Assert.Equal(3.0, readings["bb.ledger-worker"].Queues!.Single(q => q.Name == "bus.bb.ledger.in").Types!.Single().PerSecond, 3);
    }

    [Fact]
    public async Task A_town_with_other_names_a_other_query_and_another_column_order_reads_the_same_way()
    {
        var readings = await Read(Town("routes-town"));

        var queue = readings["aa.orders-worker"].Queues!.Single(q => q.Name == "bus.bb.ledger.orders.out");

        Assert.Equal(7, queue.Types!.Count);
        Assert.Equal("OrderPlaced", queue.Types[0].Type);
        Assert.Equal(2.0, queue.Types[0].PerSecond, 3); // 600 calls over the 300 second window
        Assert.Equal(queue.Types.Select(t => t.PerSecond).OrderByDescending(x => x), queue.Types.Select(t => t.PerSecond));
        Assert.Equal(0, queue.TypesCut);
    }

    [Fact]
    public async Task A_queue_the_query_has_no_row_for_lists_no_kinds_and_a_town_without_the_query_measures_none()
    {
        var withQuery = await Read(Town("routes-town"));
        Assert.Empty(withQuery["bb.ledger-worker"].Queues!.Single().Types!); // measured, and nothing was handled

        var without = await Read(Town("messaging-town-a"));
        Assert.All(without.Values.SelectMany(r => r.Queues ?? []), q => Assert.Null(q.Types)); // not measured
    }

    [Fact]
    public async Task The_kinds_reach_the_snapshot_on_the_system_that_reads_the_queue()
    {
        var folder = Town("routes-town");
        var registry = RegistryLoader.Load(folder).ForEnvironment("prod");
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, folder);
        var state = new LatestState();
        foreach (var source in set.Sources) state.Update(source.Name, await source.PollAsync(registry, CancellationToken.None));

        var snapshot = new SnapshotBuilder(registry, state, new FakeTimeProvider(T0)) { Environment = "prod" }.Build();

        var queue = snapshot.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == "aa.orders-worker").Queues!.Single(q => q.Name == "bus.bb.ledger.orders.out");
        Assert.Equal("OrderPlaced", queue.Types![0].Type);
        Assert.Equal(2.0, queue.Types[0].PerSecond, 3);
    }

    [Fact]
    public void A_queue_lists_at_most_the_ceiling_and_counts_the_quietest_it_left_out()
    {
        var rows = Enumerable.Range(1, 250).Select(i => new TypeRow("q", $"T{i:000}", i)).ToList();

        var (types, cut) = ServiceBusSource.TypesByQueue(rows, TimeSpan.FromSeconds(100))["q"];

        Assert.Equal(ServiceBusSource.TypeCeiling, types.Count);
        Assert.Equal(50, cut);
        Assert.Equal("T250", types[0].Type);
        Assert.Equal(2.5, types[0].PerSecond, 3);
        Assert.DoesNotContain(types, t => t.Type == "T001"); // the quietest are the ones left out
    }

    [Fact]
    public void Kinds_with_the_same_rate_are_ordered_by_name_and_a_kind_with_no_calls_is_not_listed()
    {
        var rows = new[] { new TypeRow("q", "B", 10), new TypeRow("q", "A", 10), new TypeRow("q", "Z", 0), new TypeRow("q", "Y", -5) };

        var (types, _) = ServiceBusSource.TypesByQueue(rows, TimeSpan.FromSeconds(10))["q"];

        Assert.Equal(["A", "B"], types.Select(t => t.Type));
    }

    [Fact]
    public void The_types_query_must_return_the_queue_type_and_calls_columns()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => LogAnalyticsReader.ParseTypes("""{ "tables": [ { "columns": [ { "name": "queue" }, { "name": "calls" } ], "rows": [] } ] }"""));

        Assert.Contains("queue, type, calls", ex.Message);
    }

    [Fact]
    public void A_types_query_with_an_unknown_variable_is_a_config_error()
    {
        using var copy = new RegistryCopy(Town("messaging-town-b"));
        var file = copy.FilePath(Path.Combine("environments", "prod.yaml"));
        File.WriteAllText(file, File.ReadAllText(file).Replace("Name == \"messaging.process.duration\"", "Name == \"{nonsense}\""));

        var ex = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("typesQuery", ex.Message);
    }
}
